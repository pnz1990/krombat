package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type Handler struct {
	client      *k8s.Client
	hub         *ws.Hub
	attackLimit *rateLimiter
}

func New(client *k8s.Client, hub *ws.Hub) *Handler {
	return &Handler{
		client:      client,
		hub:         hub,
		attackLimit: newRateLimiter(300 * time.Millisecond),
	}
}

func (h *Handler) AttackWithRateLimit() http.HandlerFunc {
	return h.attackLimit.Wrap(h.CreateAttack, func(r *http.Request) string {
		return r.PathValue("namespace") + "/" + r.PathValue("name")
	})
}

var hpByDifficulty = map[string]struct{ monster, boss int64 }{
	"easy":   {30, 200},
	"normal": {50, 400},
	"hard":   {80, 800},
}

type CreateDungeonReq struct {
	Name       string        `json:"name"`
	Monsters   int64         `json:"monsters"`
	Difficulty string        `json:"difficulty"`
	MonsterHP  []interface{} `json:"monsterHP,omitempty"`
	BossHP     *int64        `json:"bossHP,omitempty"`
}

func (h *Handler) CreateDungeon(w http.ResponseWriter, r *http.Request) {
	var req CreateDungeonReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.Monsters < 1 || req.Monsters > 10 {
		writeError(w, "invalid name or monsters (1-10)", http.StatusBadRequest)
		return
	}
	if req.Difficulty != "easy" && req.Difficulty != "normal" && req.Difficulty != "hard" {
		writeError(w, "difficulty must be easy, normal, or hard", http.StatusBadRequest)
		return
	}

	// Use client-provided HP values, or derive from difficulty
	hp, _ := hpByDifficulty[req.Difficulty]
	monsterHP := req.MonsterHP
	if len(monsterHP) == 0 {
		monsterHP = make([]interface{}, req.Monsters)
		for i := range monsterHP {
			monsterHP[i] = hp.monster
		}
	}
	bossHP := hp.boss
	if req.BossHP != nil {
		bossHP = *req.BossHP
	}

	dungeon := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Dungeon",
		"metadata":   map[string]interface{}{"name": req.Name},
		"spec": map[string]interface{}{
			"monsters":   req.Monsters,
			"difficulty": req.Difficulty,
			"monsterHP":  monsterHP,
			"bossHP":     bossHP,
		},
	}}

	result, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace("default").Create(
		context.Background(), dungeon, metav1.CreateOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	dungeonsCreated.Inc()
	slog.Info("dungeon created", "component", "api", "dungeon", req.Name, "monsters", req.Monsters, "difficulty", req.Difficulty)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(result.Object)
}

func (h *Handler) ListDungeons(w http.ResponseWriter, r *http.Request) {
	list, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace("").List(
		context.Background(), metav1.ListOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type summary struct {
		Name           string      `json:"name"`
		Namespace      string      `json:"namespace"`
		Difficulty     interface{} `json:"difficulty"`
		LivingMonsters interface{} `json:"livingMonsters"`
		BossState      interface{} `json:"bossState"`
		Victory        interface{} `json:"victory"`
	}
	items := []summary{}
	for _, d := range list.Items {
		spec, _ := d.Object["spec"].(map[string]interface{})
		status, _ := d.Object["status"].(map[string]interface{})
		items = append(items, summary{
			Name:           d.GetName(),
			Namespace:      d.GetNamespace(),
			Difficulty:     spec["difficulty"],
			LivingMonsters: status["livingMonsters"],
			BossState:      status["bossState"],
			Victory:        status["victory"],
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}

// GetDungeon returns the Dungeon CR only — all state is in spec + status
func (h *Handler) GetDungeon(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		context.Background(), name, metav1.GetOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dungeon.Object)
}

type CreateAttackReq struct {
	Target string `json:"target"`
	Damage int64  `json:"damage"`
}

func (h *Handler) CreateAttack(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")

	var req CreateAttackReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Target == "" || req.Damage < 1 {
		writeError(w, "target and damage (>0) required", http.StatusBadRequest)
		return
	}

	attackName := fmt.Sprintf("%s-%s-%d", name, req.Target, time.Now().UnixMilli()%100000)

	attack := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Attack",
		"metadata":   map[string]interface{}{"name": attackName},
		"spec": map[string]interface{}{
			"dungeonName":      name,
			"dungeonNamespace": ns,
			"target":           req.Target,
			"damage":           req.Damage,
		},
	}}

	result, err := h.client.Dynamic.Resource(k8s.AttackGVR).Namespace("default").Create(
		context.Background(), attack, metav1.CreateOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	attacksSubmitted.WithLabelValues(name).Inc()
	slog.Info("attack submitted", "component", "api", "dungeon", name, "namespace", ns, "target", req.Target, "damage", req.Damage)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(result.Object)
}

func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
	conn, err := h.hub.Upgrade(w, r)
	if err != nil {
		return
	}
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	h.hub.Add(conn, ns, name)
	slog.Info("websocket connected", "component", "ws", "namespace", ns, "dungeon", name)
	defer func() {
		h.hub.Remove(conn)
		slog.Info("websocket disconnected", "component", "ws", "namespace", ns, "dungeon", name)
	}()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

func writeError(w http.ResponseWriter, msg string, code int) {
	httpRequests.WithLabelValues("", "", strconv.Itoa(code)).Inc()
	slog.Warn("request error", "component", "api", "status", code, "error", msg)
	http.Error(w, msg, code)
}
