package handlers

import "github.com/prometheus/client_golang/prometheus"

var (
	dungeonsCreated = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "k8s_rpg_dungeons_created_total",
		Help: "Total dungeons created",
	})
	attacksSubmitted = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_attacks_submitted_total",
		Help: "Total attacks submitted",
	}, []string{"dungeon"})
	attacksRateLimited = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "k8s_rpg_attacks_rate_limited_total",
		Help: "Total attacks rejected by rate limiter",
	})
	httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_http_requests_total",
		Help: "Total HTTP requests",
	}, []string{"method", "path", "status"})
)

func init() {
	prometheus.MustRegister(dungeonsCreated, attacksSubmitted, attacksRateLimited, httpRequests)
}
