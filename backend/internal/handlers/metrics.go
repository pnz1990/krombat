package handlers

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	dungeonsCreated = promauto.NewCounter(prometheus.CounterOpts{
		Name: "k8s_rpg_dungeons_created_total",
		Help: "Total dungeons created",
	})
	attacksSubmitted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_attacks_submitted_total",
		Help: "Total attacks submitted",
	}, []string{"dungeon"})
	attacksRateLimited = promauto.NewCounter(prometheus.CounterOpts{
		Name: "k8s_rpg_attacks_rate_limited_total",
		Help: "Total attacks rejected by rate limiter",
	})

	// httpRequests is now incremented by AccessLog middleware for every request
	// (success and error alike). Labels are sanitized to prevent cardinality explosion.
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_http_requests_total",
		Help: "Total HTTP requests",
	}, []string{"method", "path", "status"})

	// httpDuration tracks per-route latency in milliseconds.
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "k8s_rpg_http_duration_ms",
		Help:    "HTTP request latency in milliseconds",
		Buckets: []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2500},
	}, []string{"method", "path", "status"})

	// combatEvents tracks combat and action events with game-dimension labels.
	// event = "attack" | "action"
	// outcome = "hit" | "kill" | "boss_kill" | "room_clear" | "victory" | "defeat"
	combatEvents = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_combat_events_total",
		Help: "Combat and action events processed",
	}, []string{"event", "hero_class", "difficulty", "outcome"})

	// lootDrops tracks loot item drops.
	lootDrops = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_loot_drops_total",
		Help: "Loot items dropped",
	}, []string{"item_type", "rarity", "difficulty"})

	// statusEffectsInflicted tracks DoT/stun inflictions.
	statusEffectsInflicted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "k8s_rpg_status_effects_total",
		Help: "Status effects inflicted on hero",
	}, []string{"effect"}) // effect = "poison" | "burn" | "stun"

	activeDungeons = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_active_dungeons", Help: "Active dungeon count"})
	monstersAlive  = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_monsters_alive", Help: "Alive monsters"})
	monstersDead   = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_monsters_dead", Help: "Dead monsters"})
	bossesPending  = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_pending", Help: "Bosses pending"})
	bossesReady    = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_ready", Help: "Bosses ready"})
	bossesDefeated = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_bosses_defeated", Help: "Bosses defeated"})
	gameVictories  = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_victories", Help: "Victories"})
	gameDefeats    = promauto.NewGauge(prometheus.GaugeOpts{Name: "k8s_rpg_defeats", Help: "Defeats"})
)
