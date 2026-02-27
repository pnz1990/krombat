package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/pnz1990/krombat/backend/internal/handlers"
	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

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
	mux.HandleFunc("GET /api/v1/events", h.Events)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("GET /metrics", promhttp.Handler())

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	slog.Info("backend starting", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
