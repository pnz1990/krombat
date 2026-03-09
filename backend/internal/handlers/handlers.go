package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

type Handler struct {
	client      *k8s.Client
	hub         *ws.Hub
	attackLimit *rateLimiter
}

func New(client *k8s.Client, hub *ws.Hub) *Handler {
	h := &Handler{
		client:      client,
		hub:         hub,
		attackLimit: newRateLimiter(300 * time.Millisecond),
	}
	go h.pollGameMetrics()
	return h
}

func (h *Handler) pollGameMetrics() {
	for {
		list, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace("").List(
			context.Background(), metav1.ListOptions{})
		if err == nil {
			var alive, dead, bPend, bReady, bDef, wins, losses float64
			activeDungeons.Set(float64(len(list.Items)))
			for _, d := range list.Items {
				spec, _ := d.Object["spec"].(map[string]interface{})
				status, _ := d.Object["status"].(map[string]interface{})
				if hps, ok := spec["monsterHP"].([]interface{}); ok {
					for _, hp := range hps {
						if sliceInt(hp) > 0 {
							alive++
						} else {
							dead++
						}
					}
				}
				switch bs, _ := status["bossState"].(string); bs {
				case "ready":
					bReady++
				case "defeated":
					bDef++
				default:
					bPend++
				}
				if v, _ := status["victory"].(bool); v {
					wins++
				}
				if v, _ := status["defeat"].(bool); v {
					losses++
				}
			}
			monstersAlive.Set(alive)
			monstersDead.Set(dead)
			bossesPending.Set(bPend)
			bossesReady.Set(bReady)
			bossesDefeated.Set(bDef)
			gameVictories.Set(wins)
			gameDefeats.Set(losses)
		}
		time.Sleep(30 * time.Second)
	}
}

func (h *Handler) AttackWithRateLimit() http.HandlerFunc {
	return h.attackLimit.Wrap(h.CreateAttack, func(r *http.Request) string {
		return r.PathValue("namespace") + "/" + r.PathValue("name")
	})
}

var defaultHP = map[string]struct{ monster, boss int64 }{
	"easy":   {30, 200},
	"normal": {50, 400},
	"hard":   {80, 800},
}

// validDNSLabel matches valid Kubernetes namespace names (RFC 1123 DNS label).
// Must be lowercase alphanumeric or hyphens, start/end with alphanumeric, max 63 chars.
var validDNSLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// allowedNamespaces is the application-layer allowlist of namespaces where
// Dungeon CRs may be created, read, updated, or deleted. This prevents
// namespace injection attacks (e.g. writing into kube-system).
var allowedNamespaces = map[string]bool{"default": true}

// validateNamespace returns true if the namespace is allowed, and writes a
// 400 Bad Request response and returns false if it is not.
func validateNamespace(w http.ResponseWriter, ns string) bool {
	if !allowedNamespaces[ns] {
		writeError(w, "invalid namespace", http.StatusBadRequest)
		return false
	}
	return true
}

type CreateDungeonReq struct {
	Name       string `json:"name"`
	Monsters   int64  `json:"monsters"`
	Difficulty string `json:"difficulty"`
	HeroClass  string `json:"heroClass"`
	Namespace  string `json:"namespace"`
	// New Game+ carry-over fields (optional, 0 = fresh start)
	RunCount    int64 `json:"runCount"`
	WeaponBonus int64 `json:"weaponBonus"`
	WeaponUses  int64 `json:"weaponUses"`
	ArmorBonus  int64 `json:"armorBonus"`
	ShieldBonus int64 `json:"shieldBonus"`
	HelmetBonus int64 `json:"helmetBonus"`
	PantsBonus  int64 `json:"pantsBonus"`
	RingBonus   int64 `json:"ringBonus"`
	AmuletBonus int64 `json:"amuletBonus"`
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
	if !validDNSLabel.MatchString(req.Name) {
		writeError(w, "dungeon name must be a valid DNS label (lowercase alphanumeric and hyphens only, max 63 chars, must start and end with alphanumeric)", http.StatusBadRequest)
		return
	}
	if req.Difficulty != "easy" && req.Difficulty != "normal" && req.Difficulty != "hard" {
		writeError(w, "difficulty must be easy, normal, or hard", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	if !validateNamespace(w, req.Namespace) {
		return
	}

	hp, _ := defaultHP[req.Difficulty]
	monsterHP := make([]interface{}, req.Monsters)
	for i := range monsterHP {
		monsterHP[i] = hp.monster
	}

	heroClass := req.HeroClass
	if heroClass == "" {
		heroClass = "warrior"
	}
	heroHP := int64(100)
	heroMana := int64(0)
	switch heroClass {
	case "warrior":
		heroHP = 200
	case "mage":
		heroHP = 120
		heroMana = 8
	case "rogue":
		heroHP = 150
	default:
		writeError(w, "heroClass must be warrior, mage, or rogue", http.StatusBadRequest)
		return
	}

	// Pick a random modifier (20% none, 40% curse, 40% blessing)
	modifiers := []string{"none", "curse-fortitude", "curse-fury", "curse-darkness", "blessing-strength", "blessing-resilience", "blessing-fortune", "blessing-strength", "curse-fury", "blessing-fortune"}
	modifier := modifiers[rand.Intn(len(modifiers))]

	// Curse of Fortitude: apply +50% monster HP at creation
	if modifier == "curse-fortitude" {
		for i := range monsterHP {
			monsterHP[i] = monsterHP[i].(int64) * 3 / 2
		}
	}

	// New Game+ scaling: each completed run multiplies monster HP by 1.25
	// and adds +10% hero HP per run (compounded). runCount is the number of
	// prior completed runs (0 = fresh start, 1 = first New Game+, etc.)
	runCount := req.RunCount
	if runCount < 0 || runCount > 20 {
		runCount = 0 // clamp to reasonable range
	}
	if runCount > 0 {
		// Scale monster HP: 1.25^runCount (integer approximation)
		// 1 run: 125%, 2 runs: 156%, 3 runs: 195%, etc.
		scale := int64(100)
		for i := int64(0); i < runCount; i++ {
			scale = scale * 125 / 100
		}
		for i := range monsterHP {
			monsterHP[i] = monsterHP[i].(int64) * scale / 100
		}
		hp.boss = hp.boss * scale / 100
		// Hero HP +10% per run (compounded)
		heroHPScale := int64(100)
		for i := int64(0); i < runCount; i++ {
			heroHPScale = heroHPScale * 110 / 100
		}
		heroHP = heroHP * heroHPScale / 100
	}

	// Assign monster types for Room 1: goblin(0), skeleton(1), archer(2+even), shaman(3+odd)
	// Archers (index % 2 == 0, index >= 2): 20% chance to stun instead of poison
	// Shamans (index % 2 == 1, index >= 3): 30% chance to heal another monster on counter
	monsterTypes := make([]interface{}, req.Monsters)
	for i := range monsterTypes {
		switch {
		case i == 0:
			monsterTypes[i] = "goblin"
		case i == 1:
			monsterTypes[i] = "skeleton"
		case i%2 == 0:
			monsterTypes[i] = "archer"
		default:
			monsterTypes[i] = "shaman"
		}
	}

	dungeonSpec := map[string]interface{}{
		"monsters":     req.Monsters,
		"difficulty":   req.Difficulty,
		"monsterHP":    monsterHP,
		"bossHP":       hp.boss,
		"heroHP":       heroHP,
		"heroClass":    heroClass,
		"heroMana":     heroMana,
		"modifier":     modifier,
		"monsterTypes": monsterTypes,
		"runCount":     runCount,
	}
	// Carry over gear bonuses from prior run (New Game+)
	if req.WeaponBonus > 0 {
		dungeonSpec["weaponBonus"] = req.WeaponBonus
		dungeonSpec["weaponUses"] = req.WeaponUses
	}
	if req.ArmorBonus > 0 {
		dungeonSpec["armorBonus"] = req.ArmorBonus
	}
	if req.ShieldBonus > 0 {
		dungeonSpec["shieldBonus"] = req.ShieldBonus
	}
	if req.HelmetBonus > 0 {
		dungeonSpec["helmetBonus"] = req.HelmetBonus
	}
	if req.PantsBonus > 0 {
		dungeonSpec["pantsBonus"] = req.PantsBonus
	}
	if req.RingBonus > 0 {
		dungeonSpec["ringBonus"] = req.RingBonus
	}
	if req.AmuletBonus > 0 {
		dungeonSpec["amuletBonus"] = req.AmuletBonus
	}

	dungeon := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Dungeon",
		"metadata":   map[string]interface{}{"name": req.Name},
		"spec":       dungeonSpec,
	}}

	var result *unstructured.Unstructured
	if err := retryK8s(3, func() error {
		var createErr error
		result, createErr = h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(req.Namespace).Create(
			context.Background(), dungeon, metav1.CreateOptions{})
		return createErr
	}); err != nil {
		slog.Error("failed to create dungeon", "component", "api", "dungeon", req.Name, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
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
		slog.Error("failed to list dungeons", "component", "api", "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return
	}

	type summary struct {
		Name           string      `json:"name"`
		Namespace      string      `json:"namespace"`
		Difficulty     interface{} `json:"difficulty"`
		LivingMonsters interface{} `json:"livingMonsters"`
		BossState      interface{} `json:"bossState"`
		Victory        interface{} `json:"victory"`
		Modifier       interface{} `json:"modifier"`
		RunCount       interface{} `json:"runCount"`
	}
	items := []summary{}
	for _, d := range list.Items {
		if d.GetDeletionTimestamp() != nil {
			continue
		}
		spec, _ := d.Object["spec"].(map[string]interface{})
		status, _ := d.Object["status"].(map[string]interface{})
		items = append(items, summary{
			Name:           d.GetName(),
			Namespace:      d.GetNamespace(),
			Difficulty:     spec["difficulty"],
			LivingMonsters: status["livingMonsters"],
			BossState:      status["bossState"],
			Victory:        status["victory"],
			Modifier:       spec["modifier"],
			RunCount:       spec["runCount"],
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}

func (h *Handler) GetDungeon(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		context.Background(), name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dungeon.Object)
}

func (h *Handler) DeleteDungeon(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	// Read dungeon spec before deletion to capture run stats for the leaderboard.
	ctx := context.Background()
	if dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{}); err == nil {
		spec, _ := dungeon.Object["spec"].(map[string]interface{})
		if spec != nil {
			go h.recordLeaderboard(spec, name)
		}
	}

	if err := retryK8s(3, func() error {
		return h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Delete(
			context.Background(), name, metav1.DeleteOptions{})
	}); err != nil {
		slog.Error("failed to delete dungeon", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}
	slog.Info("dungeon deleted", "component", "api", "dungeon", name, "namespace", ns)
	w.WriteHeader(http.StatusNoContent)
}

// LeaderboardEntry represents a single completed dungeon run.
type LeaderboardEntry struct {
	DungeonName string `json:"dungeonName"`
	HeroClass   string `json:"heroClass"`
	Difficulty  string `json:"difficulty"`
	Outcome     string `json:"outcome"`
	TotalTurns  int64  `json:"totalTurns"`
	CurrentRoom int64  `json:"currentRoom"`
	Timestamp   string `json:"timestamp"`
}

const leaderboardCMName = "krombat-leaderboard"
const leaderboardNamespace = "rpg-system"
const leaderboardMaxEntries = 100

var leaderboardGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

// recordLeaderboard writes a run completion entry to the krombat-leaderboard ConfigMap.
// Called asynchronously before dungeon deletion. Silently skips on any error.
func (h *Handler) recordLeaderboard(spec map[string]interface{}, dungeonName string) {
	heroClass, _ := spec["heroClass"].(string)
	difficulty, _ := spec["difficulty"].(string)
	heroHP := getInt(spec, "heroHP")
	bossHP := getInt(spec, "bossHP")
	currentRoom := getInt(spec, "currentRoom")
	attackSeq := getInt(spec, "attackSeq")
	actionSeq := getInt(spec, "actionSeq")

	outcome := "in-progress"
	if heroHP <= 0 {
		outcome = "defeat"
	} else {
		monsterHPRaw, _ := spec["monsterHP"].([]interface{})
		allDead := true
		for _, v := range monsterHPRaw {
			if sliceInt(v) > 0 {
				allDead = false
				break
			}
		}
		if bossHP <= 0 && allDead && currentRoom >= 2 {
			outcome = "victory"
		} else if bossHP <= 0 && allDead {
			outcome = "room1-cleared"
		}
	}

	totalTurns := attackSeq + actionSeq
	entry := LeaderboardEntry{
		DungeonName: dungeonName,
		HeroClass:   heroClass,
		Difficulty:  difficulty,
		Outcome:     outcome,
		TotalTurns:  totalTurns,
		CurrentRoom: currentRoom,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
	}

	entryJSON, err := json.Marshal(entry)
	if err != nil {
		slog.Warn("leaderboard: failed to marshal entry", "error", err)
		return
	}

	ctx := context.Background()
	cmClient := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)

	// Try to get existing ConfigMap
	existing, err := cmClient.Get(ctx, leaderboardCMName, metav1.GetOptions{})
	if err != nil {
		// Create new ConfigMap
		newCM := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      leaderboardCMName,
				"namespace": leaderboardNamespace,
			},
			"data": map[string]interface{}{
				entry.Timestamp + "-" + dungeonName: string(entryJSON),
			},
		}}
		if _, createErr := cmClient.Create(ctx, newCM, metav1.CreateOptions{}); createErr != nil {
			slog.Warn("leaderboard: failed to create ConfigMap", "error", createErr)
		}
		return
	}

	// Append to existing ConfigMap data
	data, _ := existing.Object["data"].(map[string]interface{})
	if data == nil {
		data = map[string]interface{}{}
	}

	// Enforce max entries: drop oldest if over limit
	if len(data) >= leaderboardMaxEntries {
		// Find and remove oldest key (keys are timestamp-prefixed so lexicographic sort works)
		oldest := ""
		for k := range data {
			if oldest == "" || k < oldest {
				oldest = k
			}
		}
		delete(data, oldest)
	}

	key := entry.Timestamp + "-" + dungeonName
	data[key] = string(entryJSON)

	patch := map[string]interface{}{
		"data": data,
	}
	patchJSON, _ := json.Marshal(patch)
	if _, patchErr := cmClient.Patch(ctx, leaderboardCMName, types.MergePatchType, patchJSON, metav1.PatchOptions{}); patchErr != nil {
		slog.Warn("leaderboard: failed to patch ConfigMap", "error", patchErr)
	}
}

// GetLeaderboard returns the top 20 completed runs sorted by fewest turns.
func (h *Handler) GetLeaderboard(w http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	cmClient := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)

	cm, err := cmClient.Get(ctx, leaderboardCMName, metav1.GetOptions{})
	if err != nil {
		// No leaderboard yet — return empty list
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]LeaderboardEntry{})
		return
	}

	data, _ := cm.Object["data"].(map[string]interface{})
	entries := make([]LeaderboardEntry, 0, len(data))
	for _, v := range data {
		raw, _ := v.(string)
		var e LeaderboardEntry
		if json.Unmarshal([]byte(raw), &e) == nil {
			entries = append(entries, e)
		}
	}

	// Sort by fewest turns (ascending), then by timestamp descending for ties
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0; j-- {
			a, b := entries[j-1], entries[j]
			if a.TotalTurns > b.TotalTurns || (a.TotalTurns == b.TotalTurns && a.Timestamp < b.Timestamp) {
				entries[j-1], entries[j] = entries[j], entries[j-1]
			}
		}
	}

	// Cap at top 20
	if len(entries) > 20 {
		entries = entries[:20]
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

type CreateAttackReq struct {
	Target string `json:"target"`
	Damage int64  `json:"damage"`
	// Seq is the actionSeq/attackSeq the client last observed. The backend
	// compares this against the current dungeon spec to detect concurrent
	// writes. A value of -1 (omitted / zero-valued client) disables the guard
	// so existing clients without the field are not broken.
	Seq int64 `json:"seq"`
}

// CreateAttack handles all player actions. Routes to Action CR (non-combat) or
// Attack CR (combat). Both CRs use fixed names — SSA upsert overwrites the
// previous one. dungeon-graph externalRef watches fire on change and kro
// re-reconciles, writing computed results into the combatResult/actionResult
// ConfigMap. This handler then reads that ConfigMap and patches the Dungeon CR.
// No Job, no bash, no kubectl from within the cluster.
func (h *Handler) CreateAttack(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	var req CreateAttackReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Target == "" {
		writeError(w, "target required", http.StatusBadRequest)
		return
	}

	isAction := strings.HasPrefix(req.Target, "use-") || strings.HasPrefix(req.Target, "equip-") ||
		req.Target == "open-treasure" || req.Target == "unlock-door" || req.Target == "enter-room-2"

	ctx := context.Background()

	if isAction {
		if err := h.processAction(ctx, ns, name, req.Target, req.Seq, w); err != nil {
			// error already written
			return
		}
	} else {
		if err := h.processCombat(ctx, ns, name, req.Target, req.Damage, req.Seq, w); err != nil {
			// error already written
			return
		}
	}
}

// processCombat handles a combat action:
// 1. Read current dungeon spec to get current attackSeq and room
// 2. If clientSeq >= 0 and clientSeq != attackSeq, return 409 Conflict (stale request)
// 3. Upsert fixed-name Attack CR (SSA) with new seq = attackSeq+1 and targetRoom
// 4. kro re-reconciles dungeon-graph, writes combatResult ConfigMap
// 5. Backend reads combatResult ConfigMap, runs full combat math, patches Dungeon spec
func (h *Handler) processCombat(ctx context.Context, ns, name, target string, clientDamage int64, clientSeq int64, w http.ResponseWriter) error {
	start := time.Now()
	defer func() {
		slog.Info("attack_processed", "component", "api", "dungeon", name, "target", target, "duration_ms", time.Since(start).Milliseconds())
	}()
	// Step 1: read current dungeon spec
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon for combat", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return err
	}
	spec := getMap(dungeon.Object, "spec")
	dungeonStatus := getMap(dungeon.Object, "status")

	heroHP := getInt(spec, "heroHP")
	heroClass := getString(spec, "heroClass", "warrior")
	heroMana := getInt(spec, "heroMana")
	difficulty := getString(spec, "difficulty", "normal")
	tauntActive := getInt(spec, "tauntActive")
	backstabCD := getInt(spec, "backstabCooldown")
	attackSeq := getInt(spec, "attackSeq")

	// Boss phase damage multiplier from kro-derived status (boss-graph CEL).
	// Stored as integer *10: phase1=10 (1.0x), phase2=15 (1.5x), phase3=20 (2.0x).
	// Default to 10 (1.0x) if status not yet populated.
	bossDmgMultiplierStr := getString(dungeonStatus, "bossDamageMultiplier", "10")
	bossDmgMultiplier, _ := strconv.ParseInt(bossDmgMultiplierStr, 10, 64)
	if bossDmgMultiplier <= 0 {
		bossDmgMultiplier = 10
	}
	bossPhaseStr := getString(dungeonStatus, "bossPhase", "phase1")

	// Conflict guard: if the client sent a known sequence number that doesn't
	// match the current spec, another request already advanced the dungeon
	// state. Reject with 409 so the client re-fetches before retrying.
	if clientSeq >= 0 && clientSeq != attackSeq {
		slog.Warn("stale attack rejected", "component", "api", "dungeon", name, "clientSeq", clientSeq, "serverSeq", attackSeq)
		writeError(w, "stale request — dungeon state has changed, please retry", http.StatusConflict)
		return fmt.Errorf("stale attack: clientSeq=%d serverSeq=%d", clientSeq, attackSeq)
	}
	modifier := getString(spec, "modifier", "none")
	inventory := getString(spec, "inventory", "")
	weaponBonus := getInt(spec, "weaponBonus")
	weaponUses := getInt(spec, "weaponUses")
	armorBonus := getInt(spec, "armorBonus")
	shieldBonus := getInt(spec, "shieldBonus")
	helmetBonus := getInt(spec, "helmetBonus")
	pantsBonus := getInt(spec, "pantsBonus")
	bootsBonus := getInt(spec, "bootsBonus")
	ringBonus := getInt(spec, "ringBonus")
	amuletBonus := getInt(spec, "amuletBonus")
	poisonTurns := getInt(spec, "poisonTurns")
	burnTurns := getInt(spec, "burnTurns")
	stunTurns := getInt(spec, "stunTurns")
	currentRoom := getInt(spec, "currentRoom")
	bossHP := getInt(spec, "bossHP")
	monsterHPRaw, _ := spec["monsterHP"].([]interface{})
	monsterTypesRaw, _ := spec["monsterTypes"].([]interface{})

	// Guard: reject if dungeon is over
	allMonstersDead := true
	for _, hp := range monsterHPRaw {
		if sliceInt(hp) > 0 {
			allMonstersDead = false
			break
		}
	}
	if heroHP <= 0 || (bossHP <= 0 && allMonstersDead) {
		// Dungeon over — no-op, return current state
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(dungeon.Object)
		return nil
	}

	newSeq := attackSeq + 1

	// Step 2: Upsert fixed-name Attack CR via SSA
	attackCRName := name + "-latest-attack"
	attackObj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Attack",
		"metadata": map[string]interface{}{
			"name":      attackCRName,
			"namespace": "default",
		},
		"spec": map[string]interface{}{
			"dungeonName":      name,
			"dungeonNamespace": ns,
			"target":           target,
			"damage":           clientDamage,
			"seq":              newSeq,
			"targetRoom":       currentRoom,
		},
	}}
	attackData, _ := json.Marshal(attackObj.Object)
	attackResult, err := h.client.Dynamic.Resource(k8s.AttackGVR).Namespace("default").Patch(
		ctx, attackCRName, types.ApplyPatchType, attackData,
		metav1.PatchOptions{FieldManager: "rpg-backend", Force: boolPtr(true)})
	if err != nil {
		slog.Error("failed to upsert attack CR", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}
	attacksSubmitted.WithLabelValues(name).Inc()

	// Step 3: Compute combat math here in the backend (Go replaces the bash Job).
	// All game logic is deterministic given the inputs from dungeon spec.
	// Random rolls use the Attack CR's UID as seed (written by API server, truly random).
	attackUID := string(attackResult.GetUID())

	// Apply DoT at start of turn
	dotNote := ""
	if poisonTurns > 0 {
		heroHP -= 5
		poisonTurns--
		dotNote += "Poison -5 HP. "
	}
	if burnTurns > 0 {
		heroHP -= 8
		burnTurns--
		dotNote += "Burn -8 HP. "
	}
	if heroHP < 0 {
		heroHP = 0
	}

	// Stun
	isStunned := false
	if stunTurns > 0 {
		isStunned = true
		stunTurns--
		dotNote += "STUNNED! "
	}

	// Backstab cooldown
	if backstabCD > 0 {
		backstabCD--
	}

	// Taunt: if active (==1), mark as protecting this turn (==2)
	tauntNote := ""
	if tauntActive == 1 {
		tauntNote = " [Taunt active: -60% counter dmg]"
		tauntActive = 2
	} else if tauntActive > 1 {
		// Taunt protected exactly 1 turn — expire it now
		tauntActive = 0
	}

	// Determine real target (strip -backstab suffix)
	isBackstab := false
	realTarget := target
	if strings.HasSuffix(target, "-backstab") {
		isBackstab = true
		realTarget = strings.TrimSuffix(target, "-backstab")
		if backstabCD > 0 {
			writeError(w, "backstab on cooldown", http.StatusBadRequest)
			return fmt.Errorf("backstab on cooldown")
		}
		backstabCD = 3
	}

	// Is mage heal?
	if target == "hero" {
		if heroClass != "mage" {
			writeError(w, "only mage can heal", http.StatusBadRequest)
			return fmt.Errorf("only mage can heal")
		}
		if heroMana < 2 {
			writeError(w, "not enough mana", http.StatusBadRequest)
			return fmt.Errorf("not enough mana")
		}
		maxHP := int64(120)
		newHP := min64(heroHP+40, maxHP)
		heroMana -= 2
		heroAction := fmt.Sprintf("Mage heals for %d HP! (Mana: %d)", newHP-heroHP, heroMana)
		patch := map[string]interface{}{
			"spec": map[string]interface{}{
				"heroHP": newHP, "heroMana": heroMana,
				"backstabCooldown": backstabCD,
				"lastHeroAction":   heroAction,
				"lastEnemyAction":  "No counter-attack during heal",
				"lastLootDrop":     "",
				"attackSeq":        newSeq,
			},
		}
		if err := h.patchDungeon(ctx, ns, name, patch); err != nil {
			slog.Error("failed to patch dungeon after heal", "component", "api", "dungeon", name, "namespace", ns, "error", err)
			writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
			return err
		}
		return h.respondDungeon(ctx, ns, name, w)
	}

	// Is taunt activation?
	if target == "activate-taunt" {
		if heroClass != "warrior" {
			writeError(w, "only warrior can taunt", http.StatusBadRequest)
			return fmt.Errorf("only warrior can taunt")
		}
		if tauntActive > 0 {
			writeError(w, "taunt already active", http.StatusBadRequest)
			return fmt.Errorf("taunt already active")
		}
		patch := map[string]interface{}{
			"spec": map[string]interface{}{
				"tauntActive":     1,
				"lastHeroAction":  "Warrior activates Taunt! Next attack has 60% counter-attack reduction.",
				"lastEnemyAction": "",
				"lastLootDrop":    "",
				"attackSeq":       newSeq,
			},
		}
		return h.patchAndRespond(ctx, ns, name, patch, w)
	}

	// Dice roll (seeded by attack UID)
	isBossTarget := strings.HasSuffix(realTarget, "-boss")
	baseDamage := rollDice(difficulty, isBossTarget, attackUID)

	// Class modifier
	effectiveDamage := baseDamage
	classNote := ""
	if isBackstab {
		effectiveDamage = baseDamage * 3
		classNote = " (Backstab 3x!)"
	} else if heroClass == "mage" {
		if heroMana > 0 {
			effectiveDamage = baseDamage * 13 / 10
			classNote = " (Mage power!)"
			heroMana--
		} else {
			effectiveDamage = baseDamage / 2
			classNote = " (No mana!)"
		}
	} else if heroClass == "rogue" {
		effectiveDamage = baseDamage * 11 / 10
		classNote = " (Rogue strike!)"
	}

	// Dungeon modifier on hero damage
	if modifier == "curse-darkness" {
		effectiveDamage = effectiveDamage * 3 / 4
		classNote += " [Curse: -25% dmg]"
	} else if modifier == "blessing-strength" {
		effectiveDamage = effectiveDamage * 3 / 2
		classNote += " [Blessing: +50% dmg]"
	} else if modifier == "blessing-fortune" {
		critRoll := seededRoll(attackUID+"-crit", 100)
		if critRoll < 20 {
			effectiveDamage *= 2
			classNote += " [CRIT! 2x dmg]"
		}
	}

	// Weapon bonus

	if weaponUses > 0 {
		effectiveDamage += weaponBonus
		weaponUses--
		classNote += fmt.Sprintf(" [+%d wpn]", weaponBonus)
		if weaponUses == 0 {
			weaponBonus = 0
			classNote += " [weapon broke!]"
		}
	}

	// Helmet bonus: crit chance (double damage)
	if helmetBonus > 0 {
		if seededRoll(attackUID+"-helmet-crit", 100) < helmetBonus {
			effectiveDamage *= 2
			classNote += fmt.Sprintf(" [CRIT! helmet +%d%% crit]", helmetBonus)
		}
	}

	// Amulet power boost: multiply hero damage output
	if amuletBonus > 0 {
		effectiveDamage = effectiveDamage * (100 + amuletBonus) / 100
		classNote += fmt.Sprintf(" [+%d%% amulet]", amuletBonus)
	}

	// Ring regen: restore HP at start of round (before enemy hits)
	if ringBonus > 0 {
		maxHP := classMaxHP(heroClass)
		heroHP = min64(heroHP+ringBonus, maxHP)
		classNote += fmt.Sprintf(" [+%d regen]", ringBonus)
	}

	// Stun zeroes damage
	if isStunned {
		effectiveDamage = 0
		classNote = " STUNNED!"
	}

	// Build patch values
	patchSpec := map[string]interface{}{
		"poisonTurns":      poisonTurns,
		"burnTurns":        burnTurns,
		"stunTurns":        stunTurns,
		"backstabCooldown": backstabCD,
		"tauntActive":      tauntActive,
		"weaponBonus":      weaponBonus,
		"weaponUses":       weaponUses,
		"attackSeq":        newSeq,
		"lastLootDrop":     "",
		"heroMana":         heroMana,
		"ringBonus":        ringBonus,
		"amuletBonus":      amuletBonus,
	}

	lootDrop := ""
	inventory2 := inventory

	if isBossTarget {
		if bossHP <= 0 {
			// Already dead
			patch := map[string]interface{}{"spec": map[string]interface{}{"lastLootDrop": "", "lastHeroAction": "Boss already defeated", "lastEnemyAction": "", "attackSeq": newSeq}}
			return h.patchAndRespond(ctx, ns, name, patch, w)
		}
		newBossHP := max64(bossHP-effectiveDamage, 0)
		patchSpec["bossHP"] = newBossHP

		// Counter-attack
		var counter int64
		switch difficulty {
		case "easy":
			counter = 3
		case "hard":
			counter = 8
		default:
			counter = 5
		}
		// Apply boss phase multiplier (derived from boss-graph CEL via kro status).
		// Phase 1: ×1.0, Phase 2: ×1.5, Phase 3: ×2.0 — stored as integer *10.
		counter = counter * bossDmgMultiplier / 10
		phaseNote := ""
		if bossPhaseStr == "phase2" {
			phaseNote = " [ENRAGED ×1.5]"
		} else if bossPhaseStr == "phase3" {
			phaseNote = " [BERSERK ×2.0]"
		}
		enemyAction := ""
		effectNote := ""
		if newBossHP > 0 {
			counter = applyModifierToCounter(modifier, counter)
			if armorBonus > 0 {
				counter = counter * (100 - armorBonus) / 100
			}
			// Shield block is independent of armor — works even with no armor equipped
			if shieldBonus > 0 && counter > 0 {
				if seededRoll(attackUID+"-shield", 100) < shieldBonus {
					counter = 0
					classNote += " Shield blocked!"
				}
			}
			if heroClass == "warrior" {
				counter = counter * 3 / 4
			} else if heroClass == "rogue" {
				if seededRoll(attackUID+"-dodge-boss", 100) < 25 {
					counter = 0
					classNote += " Rogue dodged!"
				}
			}
			// Pants: bonus dodge chance (any class)
			if pantsBonus > 0 && counter > 0 {
				if seededRoll(attackUID+"-pants-dodge", 100) < pantsBonus {
					counter = 0
					classNote += fmt.Sprintf(" [DODGED! pants +%d%% dodge]", pantsBonus)
				}
			}
			if tauntActive == 2 && counter > 0 {
				counter = counter * 2 / 5
			}
			// One-shot protection: a single counter-attack cannot reduce hero below 1 HP.
			if heroHP-counter < 1 && counter < heroHP {
				counter = heroHP - 1
			}
			heroHP = max64(heroHP-counter, 0)
			enemyAction = fmt.Sprintf("Boss strikes back for %d damage!%s (Hero HP: %d)", counter, phaseNote, heroHP)

			// Status effects from boss — boots provide status resist
			effectRoll := seededRoll(attackUID+"-fx", 100)
			resistRoll := seededRoll(attackUID+"-boots-resist", 100)
			resisted := bootsBonus > 0 && resistRoll < bootsBonus
			if currentRoom == 2 {
				// Bat-boss: poison 30%, stun 15%
				if effectRoll < 15 && stunTurns == 0 {
					if resisted {
						effectNote = fmt.Sprintf(" [RESISTED stun! boots +%d%% resist]", bootsBonus)
					} else {
						stunTurns = 1
						effectNote = " Bat Boss inflicts STUN! (1 turn)"
					}
				} else if effectRoll < 45 && poisonTurns == 0 {
					if resisted {
						effectNote = fmt.Sprintf(" [RESISTED poison! boots +%d%% resist]", bootsBonus)
					} else {
						poisonTurns = 3
						effectNote = " Bat Boss inflicts POISON! (3 turns, -5 HP/turn)"
					}
				}
			} else {
				// Dragon: stun 15%, burn 25%
				if effectRoll < 15 && stunTurns == 0 {
					if resisted {
						effectNote = fmt.Sprintf(" [RESISTED stun! boots +%d%% resist]", bootsBonus)
					} else {
						stunTurns = 1
						effectNote = " Boss inflicts STUN! (1 turn)"
					}
				} else if effectRoll < 40 && burnTurns == 0 {
					if resisted {
						effectNote = fmt.Sprintf(" [RESISTED burn! boots +%d%% resist]", bootsBonus)
					} else {
						burnTurns = 2
						effectNote = " Boss inflicts BURN! (2 turns, -8 HP/turn)"
					}
				}
			}
		} else {
			enemyAction = "Boss defeated!"
			// Boss loot — always drops, added to inventory if under cap
			// (Loot CR is created by boss-graph via includeWhen: hp==0)
			// We compute the item name from the same CEL seed so frontend shows it
			bossLootItem := computeBossLoot(name)
			if updated, added := inventoryAdd(inventory2, bossLootItem); added {
				inventory2 = updated
				lootDrop = bossLootItem
				classNote += " Boss dropped " + bossLootItem + "!"
			} else {
				classNote += " Boss dropped " + bossLootItem + " (inventory full!)"
			}
		}

		heroAction := dotNote + fmt.Sprintf("Hero (%s) deals %d damage to %s (HP: %d -> %d)%s%s", heroClass, effectiveDamage, realTarget, bossHP, newBossHP, classNote, tauntNote)
		patchSpec["heroHP"] = heroHP
		patchSpec["lastHeroAction"] = heroAction
		patchSpec["lastEnemyAction"] = enemyAction + effectNote
		patchSpec["poisonTurns"] = poisonTurns
		patchSpec["burnTurns"] = burnTurns
		patchSpec["stunTurns"] = stunTurns
		patchSpec["lastLootDrop"] = lootDrop
		patchSpec["inventory"] = inventory2

	} else {
		// Monster target — parse index as native int to avoid int64→int narrowing
		idxStr := realTarget
		for i := len(realTarget) - 1; i >= 0; i-- {
			if realTarget[i] < '0' || realTarget[i] > '9' {
				idxStr = realTarget[i+1:]
				break
			}
		}
		idxParsed, _ := strconv.ParseInt(idxStr, 10, strconv.IntSize)
		idxInt := int(idxParsed) // ParseInt with strconv.IntSize guarantees fits in int

		if idxInt < 0 || idxInt >= len(monsterHPRaw) {
			writeError(w, "invalid monster index", http.StatusBadRequest)
			return fmt.Errorf("invalid monster index")
		}
		oldHP := sliceInt(monsterHPRaw[idxInt])
		if oldHP <= 0 {
			patch := map[string]interface{}{"spec": map[string]interface{}{"lastLootDrop": "", "lastHeroAction": "Monster already dead", "lastEnemyAction": "", "attackSeq": newSeq}}
			return h.patchAndRespond(ctx, ns, name, patch, w)
		}
		newHP := max64(oldHP-effectiveDamage, 0)

		// Rebuild monsterHP array
		newMonsterHP := make([]interface{}, len(monsterHPRaw))
		for i, v := range monsterHPRaw {
			newMonsterHP[i] = v
		}
		newMonsterHP[idxInt] = newHP

		// Mage mana regen on kill
		if oldHP > 0 && newHP == 0 && heroClass == "mage" && heroMana < classMaxMana(heroClass) {
			heroMana++
			classNote += " +1 mana!"
		}

		// Loot drop on kill transition
		if oldHP > 0 && newHP == 0 {
			if dropped, item := computeMonsterLoot(name, idxInt, difficulty); dropped {
				if updated, added := inventoryAdd(inventory2, item); added {
					inventory2 = updated
					lootDrop = item
					classNote += " Dropped " + item + "!"
				} else {
					classNote += " " + item + " dropped but inventory full!"
				}
			}
		}

		// Counter-attack from all still-alive monsters
		var baseCounter int64
		switch difficulty {
		case "easy":
			baseCounter = 1
		case "hard":
			baseCounter = 3
		default:
			baseCounter = 2
		}
		aliveCount := int64(0)
		for i, v := range monsterHPRaw {
			hp := sliceInt(v)
			if i != idxInt && hp > 0 {
				aliveCount++
			} else if i == idxInt && newHP > 0 {
				aliveCount++
			}
		}
		totalCounter := aliveCount * baseCounter
		if modifier == "blessing-resilience" {
			totalCounter /= 2
		}
		if armorBonus > 0 {
			totalCounter = totalCounter * (100 - armorBonus) / 100
		}
		// Shield block is independent of armor — works even with no armor equipped
		if shieldBonus > 0 && totalCounter > 0 {
			if seededRoll(attackUID+"-shield-m", 100) < shieldBonus {
				totalCounter = 0
				classNote += " Shield blocked!"
			}
		}
		enemyAction := ""
		if totalCounter > 0 {
			if heroClass == "warrior" {
				totalCounter = totalCounter * 3 / 4 // 25% reduction (consistent with boss path)
			} else if heroClass == "rogue" {
				if seededRoll(attackUID+"-dodge-monster", 100) < 25 {
					totalCounter = 0
					classNote += " Rogue dodged!"
				}
			}
			// Pants: bonus dodge chance (any class)
			if pantsBonus > 0 && totalCounter > 0 {
				if seededRoll(attackUID+"-pants-dodge", 100) < pantsBonus {
					totalCounter = 0
					classNote += fmt.Sprintf(" [DODGED! pants +%d%% dodge]", pantsBonus)
				}
			}
			if tauntActive == 2 && totalCounter > 0 {
				totalCounter = totalCounter * 2 / 5
			}
			// One-shot protection: a single counter-attack cannot reduce hero below 1 HP.
			if heroHP-totalCounter < 1 && totalCounter < heroHP {
				totalCounter = heroHP - 1
			}
			heroHP = max64(heroHP-totalCounter, 0)
			enemyAction = fmt.Sprintf("%d monsters counter-attack for %d total damage! (Hero HP: %d)", aliveCount, totalCounter, heroHP)
		} else if newHP == 0 {
			enemyAction = "Monster slain! No remaining counter-attack."
		} else {
			enemyAction = "Monsters counter-attack absorbed!"
		}

		// Status effects from monster counter — boots provide status resist
		effectNote := ""
		if aliveCount > 0 && poisonTurns == 0 {
			resistRoll := seededRoll(attackUID+"-boots-resist", 100)
			if seededRoll(attackUID+"-fx", 100) < 20 {
				if bootsBonus > 0 && resistRoll < bootsBonus {
					effectNote = fmt.Sprintf(" [RESISTED poison! boots +%d%% resist]", bootsBonus)
				} else {
					poisonTurns = 3
					effectNote = " Monsters inflict POISON! (3 turns, -5 HP/turn)"
				}
			}
		}

		// Archer special: any alive archer (index % 2 == 0, index >= 2) has 20% stun chance
		// Only triggers if hero wasn't already poisoned this round and stun not already active
		if aliveCount > 0 && stunTurns == 0 {
			for i, v := range monsterHPRaw {
				hp := sliceInt(v)
				mtype := ""
				if i < len(monsterTypesRaw) {
					mtype, _ = monsterTypesRaw[i].(string)
				}
				if hp > 0 && mtype == "archer" {
					if seededRoll(attackUID+fmt.Sprintf("-archer%d-stun", i), 100) < 20 {
						resistRoll := seededRoll(attackUID+"-boots-resist-archer", 100)
						if bootsBonus > 0 && resistRoll < bootsBonus {
							effectNote += fmt.Sprintf(" [RESISTED archer stun! boots +%d%% resist]", bootsBonus)
						} else {
							stunTurns = 1
							effectNote += " Archer fires! STUNNED! (1 turn)"
						}
						break
					}
				}
			}
		}

		// Shaman special: any alive shaman (index % 2 == 1, index >= 3) has 30% chance to
		// heal the first alive non-shaman monster for 10 HP (not exceeding max creation HP)
		if aliveCount > 0 {
			for i, v := range monsterHPRaw {
				hp := sliceInt(v)
				mtype := ""
				if i < len(monsterTypesRaw) {
					mtype, _ = monsterTypesRaw[i].(string)
				}
				if hp > 0 && mtype == "shaman" {
					if seededRoll(attackUID+fmt.Sprintf("-shaman%d-heal", i), 100) < 30 {
						// Find the first alive non-shaman monster to heal
						for j, vj := range newMonsterHP {
							hpj := sliceInt(vj)
							mtypej := ""
							if j < len(monsterTypesRaw) {
								mtypej, _ = monsterTypesRaw[j].(string)
							}
							if hpj > 0 && mtypej != "shaman" {
								// Heal by 10, but not exceeding original creation HP
								maxHP := defaultHP[difficulty].monster
								if modifier == "curse-fortitude" {
									maxHP = maxHP * 3 / 2
								}
								healedHP := min64(hpj+10, maxHP)
								if healedHP > hpj {
									newMonsterHP[j] = healedHP
									effectNote += fmt.Sprintf(" Shaman heals %s-%d for %d HP!", mtypej, j, healedHP-hpj)
								}
								break // healed the first eligible monster; done
							}
						}
						break // only one shaman heals per round
					}
				}
			}
		}

		heroAction := dotNote + fmt.Sprintf("Hero (%s) deals %d damage to %s (HP: %d -> %d)%s%s", heroClass, effectiveDamage, realTarget, oldHP, newHP, classNote, tauntNote)
		patchSpec["heroHP"] = heroHP
		patchSpec["monsterHP"] = newMonsterHP
		patchSpec["lastHeroAction"] = heroAction
		patchSpec["lastEnemyAction"] = enemyAction + effectNote
		patchSpec["poisonTurns"] = poisonTurns
		patchSpec["burnTurns"] = burnTurns
		patchSpec["stunTurns"] = stunTurns
		patchSpec["lastLootDrop"] = lootDrop
		patchSpec["inventory"] = inventory2
		patchSpec["heroMana"] = heroMana
	}

	patch := map[string]interface{}{"spec": patchSpec}
	return h.patchAndRespond(ctx, ns, name, patch, w)
}

// processAction handles a non-combat action (use item, equip, treasure, door, room transition).
func (h *Handler) processAction(ctx context.Context, ns, name, action string, clientSeq int64, w http.ResponseWriter) error {
	start := time.Now()
	defer func() {
		slog.Info("action_processed", "component", "api", "dungeon", name, "action", action, "duration_ms", time.Since(start).Milliseconds())
	}()
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon for action", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return err
	}
	spec := getMap(dungeon.Object, "spec")

	heroHP := getInt(spec, "heroHP")
	heroMana := getInt(spec, "heroMana")
	heroClass := getString(spec, "heroClass", "warrior")
	inventory := getString(spec, "inventory", "")
	backstabCD := getInt(spec, "backstabCooldown")
	difficulty := getString(spec, "difficulty", "normal")
	bossHP := getInt(spec, "bossHP")
	actionSeq := getInt(spec, "actionSeq")

	// Conflict guard: reject stale requests where the client's observed
	// actionSeq no longer matches the server. clientSeq < 0 means the client
	// did not send a sequence (old clients) — those are passed through.
	if clientSeq >= 0 && clientSeq != actionSeq {
		slog.Warn("stale action rejected", "component", "api", "dungeon", name, "clientSeq", clientSeq, "serverSeq", actionSeq)
		writeError(w, "stale request — dungeon state has changed, please retry", http.StatusConflict)
		return fmt.Errorf("stale action: clientSeq=%d serverSeq=%d", clientSeq, actionSeq)
	}
	monsterHPRaw, _ := spec["monsterHP"].([]interface{})

	if backstabCD > 0 {
		backstabCD--
	}

	newSeq := actionSeq + 1

	// Upsert fixed-name Action CR via SSA (triggers kro watch/reconcile for externalRef)
	actionCRName := name + "-latest-action"
	actionObj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Action",
		"metadata": map[string]interface{}{
			"name":      actionCRName,
			"namespace": "default",
		},
		"spec": map[string]interface{}{
			"dungeonName":      name,
			"dungeonNamespace": ns,
			"action":           action,
			"actionSeq":        newSeq,
		},
	}}
	actionData, _ := json.Marshal(actionObj.Object)
	_, err = h.client.Dynamic.Resource(k8s.ActionGVR).Namespace("default").Patch(
		ctx, actionCRName, types.ApplyPatchType, actionData,
		metav1.PatchOptions{FieldManager: "rpg-backend", Force: boolPtr(true)})
	if err != nil {
		slog.Error("failed to upsert action CR", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}

	patchSpec := map[string]interface{}{
		"backstabCooldown": backstabCD,
		"lastLootDrop":     "",
		"actionSeq":        newSeq,
	}

	switch {
	case strings.HasPrefix(action, "use-"):
		item := strings.TrimPrefix(action, "use-")
		if !inventoryContains(inventory, item) {
			writeError(w, "item not in inventory: "+item, http.StatusBadRequest)
			return fmt.Errorf("item not in inventory")
		}
		newInv := inventoryRemove(inventory, item)
		patchSpec["inventory"] = newInv

		switch item {
		case "hppotion-common":
			maxHP := classMaxHP(heroClass)
			newHP := min64(heroHP+20, maxHP)
			patchSpec["heroHP"] = newHP
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-rare":
			maxHP := classMaxHP(heroClass)
			newHP := min64(heroHP+40, maxHP)
			patchSpec["heroHP"] = newHP
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-epic":
			maxHP := classMaxHP(heroClass)
			newHP := min64(heroHP+999, maxHP)
			patchSpec["heroHP"] = newHP
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-common":
			newMana := min64(heroMana+2, classMaxMana(heroClass))
			patchSpec["heroMana"] = newMana
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-rare":
			newMana := min64(heroMana+3, classMaxMana(heroClass))
			patchSpec["heroMana"] = newMana
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-epic":
			newMana := min64(heroMana+8, classMaxMana(heroClass))
			patchSpec["heroMana"] = newMana
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		default:
			writeError(w, "unknown item: "+item, http.StatusBadRequest)
			return fmt.Errorf("unknown item")
		}

	case strings.HasPrefix(action, "equip-"):
		item := strings.TrimPrefix(action, "equip-")
		if !inventoryContains(inventory, item) {
			writeError(w, "item not in inventory: "+item, http.StatusBadRequest)
			return fmt.Errorf("item not in inventory")
		}
		newInv := inventoryRemove(inventory, item)
		patchSpec["inventory"] = newInv

		switch item {
		case "weapon-common":
			patchSpec["weaponBonus"] = int64(5)
			patchSpec["weaponUses"] = int64(3)
			patchSpec["lastHeroAction"] = "Equipped weapon-common! +5 damage for 3 attacks"
		case "weapon-rare":
			patchSpec["weaponBonus"] = int64(10)
			patchSpec["weaponUses"] = int64(3)
			patchSpec["lastHeroAction"] = "Equipped weapon-rare! +10 damage for 3 attacks"
		case "weapon-epic":
			patchSpec["weaponBonus"] = int64(20)
			patchSpec["weaponUses"] = int64(3)
			patchSpec["lastHeroAction"] = "Equipped weapon-epic! +20 damage for 3 attacks"
		case "armor-common":
			patchSpec["armorBonus"] = int64(10)
			patchSpec["lastHeroAction"] = "Equipped armor-common! +10% defense"
		case "armor-rare":
			patchSpec["armorBonus"] = int64(20)
			patchSpec["lastHeroAction"] = "Equipped armor-rare! +20% defense"
		case "armor-epic":
			patchSpec["armorBonus"] = int64(30)
			patchSpec["lastHeroAction"] = "Equipped armor-epic! +30% defense"
		case "shield-common":
			patchSpec["shieldBonus"] = int64(10)
			patchSpec["lastHeroAction"] = "Equipped shield-common! +10% block chance"
		case "shield-rare":
			patchSpec["shieldBonus"] = int64(15)
			patchSpec["lastHeroAction"] = "Equipped shield-rare! +15% block chance"
		case "shield-epic":
			patchSpec["shieldBonus"] = int64(25)
			patchSpec["lastHeroAction"] = "Equipped shield-epic! +25% block chance"
		case "helmet-common":
			patchSpec["helmetBonus"] = int64(5)
			patchSpec["lastHeroAction"] = "Equipped helmet-common! +5% crit chance"
		case "helmet-rare":
			patchSpec["helmetBonus"] = int64(10)
			patchSpec["lastHeroAction"] = "Equipped helmet-rare! +10% crit chance"
		case "helmet-epic":
			patchSpec["helmetBonus"] = int64(15)
			patchSpec["lastHeroAction"] = "Equipped helmet-epic! +15% crit chance"
		case "pants-common":
			patchSpec["pantsBonus"] = int64(5)
			patchSpec["lastHeroAction"] = "Equipped pants-common! +5% dodge chance"
		case "pants-rare":
			patchSpec["pantsBonus"] = int64(10)
			patchSpec["lastHeroAction"] = "Equipped pants-rare! +10% dodge chance"
		case "pants-epic":
			patchSpec["pantsBonus"] = int64(15)
			patchSpec["lastHeroAction"] = "Equipped pants-epic! +15% dodge chance"
		case "boots-common":
			patchSpec["bootsBonus"] = int64(20)
			patchSpec["lastHeroAction"] = "Equipped boots-common! +20% status resist"
		case "boots-rare":
			patchSpec["bootsBonus"] = int64(40)
			patchSpec["lastHeroAction"] = "Equipped boots-rare! +40% status resist"
		case "boots-epic":
			patchSpec["bootsBonus"] = int64(60)
			patchSpec["lastHeroAction"] = "Equipped boots-epic! +60% status resist"
		case "ring-common":
			patchSpec["ringBonus"] = int64(5)
			patchSpec["lastHeroAction"] = "Equipped ring-common! +5 HP regen per round"
		case "ring-rare":
			patchSpec["ringBonus"] = int64(8)
			patchSpec["lastHeroAction"] = "Equipped ring-rare! +8 HP regen per round"
		case "ring-epic":
			patchSpec["ringBonus"] = int64(12)
			patchSpec["lastHeroAction"] = "Equipped ring-epic! +12 HP regen per round"
		case "amulet-common":
			patchSpec["amuletBonus"] = int64(10)
			patchSpec["lastHeroAction"] = "Equipped amulet-common! +10% damage boost"
		case "amulet-rare":
			patchSpec["amuletBonus"] = int64(20)
			patchSpec["lastHeroAction"] = "Equipped amulet-rare! +20% damage boost"
		case "amulet-epic":
			patchSpec["amuletBonus"] = int64(30)
			patchSpec["lastHeroAction"] = "Equipped amulet-epic! +30% damage boost"
		default:
			writeError(w, "cannot equip: "+item, http.StatusBadRequest)
			return fmt.Errorf("cannot equip item")
		}
		patchSpec["lastEnemyAction"] = "Item equipped"

	case action == "open-treasure":
		allDead := true
		for _, v := range monsterHPRaw {
			if sliceInt(v) > 0 {
				allDead = false
				break
			}
		}
		if bossHP > 0 || !allDead {
			writeError(w, "cannot open treasure: boss not defeated", http.StatusBadRequest)
			return fmt.Errorf("cannot open treasure")
		}
		patchSpec["treasureOpened"] = int64(1)
		patchSpec["lastHeroAction"] = "Opened the treasure chest!"
		patchSpec["lastEnemyAction"] = ""

	case action == "unlock-door":
		treasureOpened := getInt(spec, "treasureOpened")
		if treasureOpened != 1 {
			writeError(w, "open the treasure first", http.StatusBadRequest)
			return fmt.Errorf("open treasure first")
		}
		patchSpec["doorUnlocked"] = int64(1)
		patchSpec["lastHeroAction"] = "Door unlocked! A new room awaits..."
		patchSpec["lastEnemyAction"] = ""

	case action == "enter-room-2":
		doorUnlocked := getInt(spec, "doorUnlocked")
		if doorUnlocked != 1 {
			writeError(w, "unlock the door first", http.StatusBadRequest)
			return fmt.Errorf("unlock door first")
		}
		modifier := getString(spec, "modifier", "none")

		// Scale Room 2 HP from Room 1 base values:
		//   monsters: Room1Base × 1.5  (×3/2)
		//   boss:     Room1Base × 1.3  (×13/10)
		// Then apply modifier adjustment:
		//   blessing: ×0.9 (×9/10) — dungeon feels more forgiving
		//   curse:    ×1.1 (×11/10) — dungeon feels more punishing
		r1 := defaultHP[difficulty]
		r2MonsterHP := r1.monster * 3 / 2
		r2BossHP := r1.boss * 13 / 10
		if strings.Contains(modifier, "blessing") {
			r2MonsterHP = r2MonsterHP * 9 / 10
			r2BossHP = r2BossHP * 9 / 10
		} else if strings.Contains(modifier, "curse") {
			r2MonsterHP = r2MonsterHP * 11 / 10
			r2BossHP = r2BossHP * 11 / 10
		}
		newMonsterHP := make([]interface{}, len(monsterHPRaw))
		for i := range newMonsterHP {
			newMonsterHP[i] = r2MonsterHP
		}
		// Room 2 monster types: troll(even), ghoul(odd) — no special classes in room 2
		r2MonsterTypes := make([]interface{}, len(monsterHPRaw))
		for i := range r2MonsterTypes {
			if i%2 == 0 {
				r2MonsterTypes[i] = "troll"
			} else {
				r2MonsterTypes[i] = "ghoul"
			}
		}
		patchSpec["currentRoom"] = int64(2)
		patchSpec["monsterHP"] = newMonsterHP
		patchSpec["bossHP"] = r2BossHP
		patchSpec["room2MonsterHP"] = newMonsterHP
		patchSpec["room2BossHP"] = r2BossHP
		patchSpec["monsterTypes"] = r2MonsterTypes
		patchSpec["treasureOpened"] = int64(0)
		patchSpec["doorUnlocked"] = int64(0)
		patchSpec["lastHeroAction"] = "Entered Room 2! Stronger enemies await..."
		patchSpec["lastEnemyAction"] = ""
		// Restore mana to class maximum when entering Room 2
		if heroClass == "mage" {
			patchSpec["heroMana"] = int64(8)
		}

	default:
		writeError(w, "unknown action: "+action, http.StatusBadRequest)
		return fmt.Errorf("unknown action")
	}

	patch := map[string]interface{}{"spec": patchSpec}
	return h.patchAndRespond(ctx, ns, name, patch, w)
}

// ---- helpers ----------------------------------------------------------------

// retryK8s retries fn up to attempts times, sleeping with linear backoff between
// retries. Client errors (4xx — not found, already exists, invalid, forbidden)
// are not retried since they indicate a caller mistake, not a transient failure.
func retryK8s(attempts int, fn func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		err = fn()
		if err == nil {
			return nil
		}
		if isClientError(err) {
			return err
		}
		time.Sleep(time.Duration(i+1) * 200 * time.Millisecond)
	}
	return err
}

// isClientError reports whether err is a Kubernetes 4xx client error that
// should not be retried (as opposed to a transient 5xx / network failure).
func isClientError(err error) bool {
	errStr := strings.ToLower(err.Error())
	return strings.Contains(errStr, "not found") ||
		strings.Contains(errStr, "already exists") ||
		strings.Contains(errStr, "invalid") ||
		strings.Contains(errStr, "forbidden")
}

func (h *Handler) patchDungeon(ctx context.Context, ns, name string, patch map[string]interface{}) error {
	data, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	return retryK8s(3, func() error {
		_, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Patch(
			ctx, name, types.MergePatchType, data, metav1.PatchOptions{})
		return err
	})
}

func (h *Handler) patchAndRespond(ctx context.Context, ns, name string, patch map[string]interface{}, w http.ResponseWriter) error {
	if err := h.patchDungeon(ctx, ns, name, patch); err != nil {
		slog.Error("failed to patch dungeon", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}
	return h.respondDungeon(ctx, ns, name, w)
}

func (h *Handler) respondDungeon(ctx context.Context, ns, name string, w http.ResponseWriter) error {
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon for response", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}
	slog.Info("attack submitted", "component", "api", "dungeon", name, "namespace", ns)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(dungeon.Object)
	return nil
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

// sanitizeK8sError converts a raw Kubernetes error into a user-friendly message,
// preventing internal details (GVR paths, namespace names, K8s internals) from
// leaking to the browser. The original error must be logged server-side before
// calling this function.
func sanitizeK8sError(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "not found"):
		return "Dungeon not found"
	case strings.Contains(msg, "already exists"):
		return "A dungeon with that name already exists"
	case strings.Contains(msg, "forbidden") || strings.Contains(msg, "unauthorized"):
		return "Permission denied"
	case strings.Contains(msg, "invalid"):
		return "Invalid request"
	default:
		return "Internal server error"
	}
}

// rollDice rolls dice based on difficulty using seeded randomness.
func rollDice(difficulty string, isBoss bool, uid string) int64 {
	var result int64
	switch difficulty {
	case "easy":
		result = seededRoll(uid+"-d1", 20) + 3
	case "hard":
		result = seededRoll(uid+"-d1", 20) + seededRoll(uid+"-d2", 20) + seededRoll(uid+"-d3", 20) + 8
	default:
		result = seededRoll(uid+"-d1", 12) + seededRoll(uid+"-d2", 12) + 6
	}
	if isBoss {
		result += seededRoll(uid+"-dboss", 20) + 3
	}
	return result
}

// seededRoll returns a deterministic value in [0, max) using the uid seed.
// Uses FNV-1a hash of the seed string for fast, uniform distribution.
func seededRoll(seed string, max int64) int64 {
	h := uint64(14695981039346656037) // FNV-1a offset basis (fits uint64)
	for i := 0; i < len(seed); i++ {
		h ^= uint64(seed[i])
		h *= 1099511628211
	}
	return int64(h>>1) % max
}

func applyModifierToCounter(modifier string, counter int64) int64 {
	switch modifier {
	case "curse-fury":
		return counter * 2
	case "blessing-resilience":
		return counter / 2
	}
	return counter
}

// computeMonsterLoot mirrors the CEL logic in monster-graph.yaml.
// Seed: dungeonName + '-m' + index
func computeMonsterLoot(dungeonName string, idx int, difficulty string) (bool, string) {
	seed := fmt.Sprintf("%s-m%d", dungeonName, idx)
	dropRoll := int(seededRoll(seed+"-drop", 36))
	var dropThreshold int
	switch difficulty {
	case "easy":
		dropThreshold = 22
	case "hard":
		dropThreshold = 13
	default:
		dropThreshold = 16
	}
	if dropRoll >= dropThreshold {
		return false, ""
	}
	rarRoll := int(seededRoll(seed+"-rar", 36))
	rarity := "common"
	if rarRoll >= 33 {
		rarity = "epic"
	} else if rarRoll >= 22 {
		rarity = "rare"
	}
	typRoll := int(seededRoll(seed+"-typ", 10))
	types := []string{"weapon", "armor", "hppotion", "manapotion", "shield", "helmet", "pants", "boots", "ring", "amulet"}
	return true, types[typRoll] + "-" + rarity
}

// computeBossLoot mirrors the CEL logic in boss-graph.yaml.
func computeBossLoot(dungeonName string) string {
	rarRoll := int(seededRoll(dungeonName+"-boss-rar", 36))
	rarity := "rare"
	if rarRoll >= 18 {
		rarity = "epic"
	}
	typRoll := int(seededRoll(dungeonName+"-boss-typ", 9))
	types := []string{"weapon", "armor", "hppotion", "shield", "helmet", "pants", "boots", "ring", "amulet"}
	return types[typRoll] + "-" + rarity
}

func classMaxHP(heroClass string) int64 {
	switch heroClass {
	case "warrior":
		return 200
	case "mage":
		return 120
	case "rogue":
		return 150
	}
	return 100
}

func classMaxMana(heroClass string) int64 {
	switch heroClass {
	case "mage":
		return 8
	}
	return 0
}

func inventoryContains(inventory, item string) bool {
	for _, v := range strings.Split(inventory, ",") {
		if v == item {
			return true
		}
	}
	return false
}

// inventoryCount returns the number of items in the inventory CSV string.
func inventoryCount(inventory string) int {
	if inventory == "" {
		return 0
	}
	count := 0
	for _, v := range strings.Split(inventory, ",") {
		if v != "" {
			count++
		}
	}
	return count
}

// inventoryAdd appends an item to inventory if under the cap (8 items).
// Returns the updated inventory and whether the item was added.
const inventoryCap = 8

func inventoryAdd(inventory, item string) (string, bool) {
	if inventoryCount(inventory) >= inventoryCap {
		return inventory, false
	}
	if inventory != "" {
		return inventory + "," + item, true
	}
	return item, true
}

func inventoryRemove(inventory, item string) string {
	parts := strings.Split(inventory, ",")
	result := []string{}
	removed := false
	for _, v := range parts {
		if v == item && !removed {
			removed = true
			continue
		}
		if v != "" {
			result = append(result, v)
		}
	}
	return strings.Join(result, ",")
}

func getMap(obj map[string]interface{}, key string) map[string]interface{} {
	v, _ := obj[key].(map[string]interface{})
	return v
}

func getInt(m map[string]interface{}, key string) int64 {
	switch v := m[key].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	}
	return 0
}

func getString(m map[string]interface{}, key, def string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func boolPtr(b bool) *bool { return &b }

// sliceInt converts an interface{} slice element to int64,
// handling both float64 (JSON-decoded) and int64 (Go-native) values.
func sliceInt(v interface{}) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	}
	return 0
}

// CelEvalHandler evaluates a CEL expression against the live dungeon spec.
// POST /api/v1/dungeons/{namespace}/{name}/cel-eval
// Body: { "expr": "schema.spec.heroHP > 100" }
// Returns: { "result": "true" } or { "error": "..." }
func (h *Handler) CelEvalHandler(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	var req struct {
		Expr string `json:"expr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Expr == "" {
		writeError(w, "invalid request body: expected {\"expr\":\"...\"}", http.StatusBadRequest)
		return
	}

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		r.Context(), name, metav1.GetOptions{})
	if err != nil {
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}

	spec := getMap(dungeon.Object, "spec")
	// Flatten spec into string-keyed interface{} map, keeping int64/string/bool types.
	bindings := make(map[string]interface{}, len(spec)+4)
	for k, v := range spec {
		bindings[k] = v
	}
	// Expose metadata as well
	bindings["name"] = dungeon.GetName()
	bindings["namespace"] = dungeon.GetNamespace()

	result, celErr := EvalCEL(req.Expr, bindings)

	w.Header().Set("Content-Type", "application/json")
	if celErr != "" {
		json.NewEncoder(w).Encode(map[string]string{"error": celErr})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"result": result})
}

// GetDungeonResource fetches a child resource of a dungeon for the kro Inspector panel.
// GET /api/v1/dungeons/{namespace}/{name}/resources?kind=hero[&index=0]
func (h *Handler) GetDungeonResource(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	kind := r.URL.Query().Get("kind")
	index := r.URL.Query().Get("index") // optional, for indexed resources (monster-N, loot-N)
	ctx := r.Context()

	type resourceDef struct {
		gvr     schema.GroupVersionResource
		resName string
	}

	grp := "game.k8s.example"
	ver := "v1alpha1"
	coreGrp := ""
	coreVer := "v1"

	var def *resourceDef
	switch kind {
	case "dungeon":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "dungeons"}, name}
	case "hero":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "heroes"}, name + "-hero"}
	case "boss":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "bosses"}, name + "-boss"}
	case "treasure":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "treasures"}, name + "-treasure"}
	case "modifier":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "modifiers"}, name + "-modifier"}
	case "monster":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "monsters"}, name + "-monster-" + index}
	case "namespace":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "namespaces"}, ns}
	case "herostate":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-hero-state"}
	case "bossstate":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-boss-state"}
	case "monsterstate":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-monster-" + index}
	case "gameconfig":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-game-config"}
	case "combatresult":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-combat-result"}
	case "treasurecm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-treasure"}
	case "treasuresecret":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "secrets"}, name + "-treasure-secret"}
	default:
		writeError(w, "unknown kind: "+kind, http.StatusBadRequest)
		return
	}

	var obj *unstructured.Unstructured
	var err error
	if def.gvr.Group == "" {
		if kind == "namespace" {
			obj, err = h.client.Dynamic.Resource(def.gvr).Get(ctx, def.resName, metav1.GetOptions{})
		} else {
			obj, err = h.client.Dynamic.Resource(def.gvr).Namespace(ns).Get(ctx, def.resName, metav1.GetOptions{})
		}
	} else {
		obj, err = h.client.Dynamic.Resource(def.gvr).Namespace(ns).Get(ctx, def.resName, metav1.GetOptions{})
	}
	if err != nil {
		writeError(w, "resource not found: "+err.Error(), http.StatusNotFound)
		return
	}

	obj.SetManagedFields(nil)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(obj.Object)
}
