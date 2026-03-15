package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/pnz1990/krombat/backend/internal/handlers"
	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	// Validate KROMBAT_TEST_USER early: Kubernetes label values must be ≤63 chars.
	// The value is used as krombat.io/owner label — a 64-char value causes 500 on list.
	if tv := os.Getenv("KROMBAT_TEST_USER"); len(tv) > 63 {
		slog.Error("KROMBAT_TEST_USER exceeds 63 characters — Kubernetes label value limit; rotate the krombat-test-auth secret with: bash tests/create-test-secret.sh --rotate")
		os.Exit(1)
	}

	// #418: SESSION_SECRET must be present — fail fast rather than running degraded
	// with a random per-pod key that breaks multi-replica sessions.
	if os.Getenv("SESSION_SECRET") == "" {
		slog.Error("SESSION_SECRET is not set — cannot start without a stable HMAC key; ensure krombat-github-oauth Secret contains SESSION_SECRET")
		os.Exit(1)
	}

	client, err := k8s.NewClient()
	if err != nil {
		slog.Error("failed to create k8s client", "error", err)
		os.Exit(1)
	}

	hub := ws.NewHub()
	go hub.Run()
	go k8s.StartWatchers(client, hub)

	mux := http.NewServeMux()
	h := handlers.New(client, hub)

	mux.HandleFunc("POST /api/v1/dungeons", h.CreateDungeon)
	mux.HandleFunc("GET /api/v1/dungeons", h.ListDungeons)
	mux.HandleFunc("GET /api/v1/dungeons/{namespace}/{name}", h.GetDungeon)
	mux.HandleFunc("DELETE /api/v1/dungeons/{namespace}/{name}", h.DeleteDungeon)
	mux.HandleFunc("POST /api/v1/dungeons/{namespace}/{name}/attacks", h.AttackWithRateLimit())
	mux.HandleFunc("GET /api/v1/dungeons/{namespace}/{name}/resources", h.GetDungeonResource)
	mux.HandleFunc("POST /api/v1/dungeons/{namespace}/{name}/cel-eval", h.CelEvalHandler)
	mux.HandleFunc("GET /api/v1/leaderboard", h.GetLeaderboard)
	mux.HandleFunc("GET /api/v1/events", h.Events)
	mux.HandleFunc("POST /api/v1/client-error", h.ClientErrorHandler)
	mux.HandleFunc("POST /api/v1/vitals", h.VitalsHandler)
	mux.HandleFunc("POST /api/v1/events-track", h.EventsTrackHandler)
	// Auth routes
	mux.HandleFunc("GET /api/v1/auth/login", handlers.LoginHandler)
	mux.HandleFunc("GET /api/v1/auth/callback", handlers.CallbackHandler)
	mux.HandleFunc("GET /api/v1/auth/me", handlers.MeHandler)
	mux.HandleFunc("GET /api/v1/auth/logout", handlers.LogoutHandler)
	// Test-only login: issues a real session cookie when KROMBAT_TEST_USER is set.
	// Returns 404 when the krombat-test-auth secret is absent (i.e. in environments without the secret).
	mux.HandleFunc("GET /api/v1/auth/test-login", handlers.TestLoginHandler)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	// #416: serve Prometheus metrics on a separate internal-only port (9090).
	// This port is NOT routed through the ALB ingress, preventing public exposure.
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.Handler())
	go func() {
		metricsAddr := ":9090"
		slog.Info("metrics server starting", "addr", metricsAddr)
		if err := http.ListenAndServe(metricsAddr, metricsMux); err != nil {
			slog.Error("metrics server failed", "error", err)
		}
	}()

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	slog.Info("backend starting", "addr", addr)
	if err := http.ListenAndServe(addr, handlers.AccessLog(handlers.AuthMiddleware(mux))); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
