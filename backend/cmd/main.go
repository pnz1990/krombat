package main

import (
	"log"
	"net/http"
	"os"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/pnz1990/krombat/backend/internal/handlers"
	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
)

func main() {
	client, err := k8s.NewClient()
	if err != nil {
		log.Fatalf("Failed to create k8s client: %v", err)
	}

	hub := ws.NewHub()
	go hub.Run()
	go k8s.StartWatchers(client, hub)

	mux := http.NewServeMux()
	h := handlers.New(client, hub)

	mux.HandleFunc("POST /api/v1/dungeons", h.CreateDungeon)
	mux.HandleFunc("GET /api/v1/dungeons", h.ListDungeons)
	mux.HandleFunc("GET /api/v1/dungeons/{namespace}/{name}", h.GetDungeon)
	mux.HandleFunc("POST /api/v1/dungeons/{namespace}/{name}/attacks", h.AttackWithRateLimit())
	mux.HandleFunc("GET /api/v1/events", h.Events)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("GET /metrics", promhttp.Handler())

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	log.Printf("Backend listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
