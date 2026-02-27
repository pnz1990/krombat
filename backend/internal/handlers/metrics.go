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

	// Game state gauges (derived from Dungeon CRs)
	activeDungeons = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_active_dungeons", Help: "Active dungeon count"})
	monstersAlive  = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_monsters_alive", Help: "Alive monsters across all dungeons"})
	monstersDead   = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_monsters_dead", Help: "Dead monsters across all dungeons"})
	bossesPending  = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_pending", Help: "Bosses pending"})
	bossesReady    = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_ready", Help: "Bosses ready"})
	bossesDefeated = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_defeated", Help: "Bosses defeated"})
	gameVictories  = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_victories", Help: "Dungeons with victory"})
	gameDefeats    = prometheus.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_defeats", Help: "Dungeons with defeat"})
)

func init() {
	prometheus.MustRegister(dungeonsCreated, attacksSubmitted, attacksRateLimited, httpRequests,
		activeDungeons, monstersAlive, monstersDead, bossesPending, bossesReady, bossesDefeated, gameVictories, gameDefeats)
}
