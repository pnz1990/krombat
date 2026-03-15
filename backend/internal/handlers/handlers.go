package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
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
	BootsBonus  int64 `json:"bootsBonus"`
	RingBonus   int64 `json:"ringBonus"`
	AmuletBonus int64 `json:"amuletBonus"`
}

func (h *Handler) CreateDungeon(w http.ResponseWriter, r *http.Request) {
	// Require authentication — users must be logged in to create dungeons.
	sess := sessionFromCtx(r.Context())
	if sess == nil {
		writeError(w, "authentication required", http.StatusUnauthorized)
		return
	}

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

	// #408: enforce per-user dungeon creation limit.
	// Configurable via MAX_DUNGEONS_PER_USER env var; default 20.
	maxDungeonsPerUser := 20
	if v := os.Getenv("MAX_DUNGEONS_PER_USER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxDungeonsPerUser = n
		}
	}
	existing, listErr := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(req.Namespace).List(
		context.Background(), metav1.ListOptions{
			LabelSelector: "krombat.io/owner=" + sess.Login,
		})
	if listErr == nil && len(existing.Items) >= maxDungeonsPerUser {
		writeError(w, fmt.Sprintf("dungeon limit reached: you may have at most %d active dungeons — delete one first", maxDungeonsPerUser), http.StatusConflict)
		return
	}

	heroClass := req.HeroClass
	if heroClass == "" {
		heroClass = "warrior"
	}
	if heroClass != "warrior" && heroClass != "mage" && heroClass != "rogue" {
		writeError(w, "heroClass must be warrior, mage, or rogue", http.StatusBadRequest)
		return
	}

	runCount := req.RunCount
	if runCount < 0 || runCount > 20 {
		runCount = 0 // clamp to reasonable range
	}

	// Backend writes only the player choices. kro dungeonInit specPatch computes
	// heroHP, heroMana, monsterHP, bossHP, modifier, and monsterTypes from these
	// fields deterministically via CEL.
	dungeonSpec := map[string]interface{}{
		"monsters":   req.Monsters,
		"difficulty": req.Difficulty,
		"heroClass":  heroClass,
		"runCount":   runCount,
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
	if req.BootsBonus > 0 {
		dungeonSpec["bootsBonus"] = req.BootsBonus
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
		"metadata": map[string]interface{}{
			"name": req.Name,
			"labels": map[string]interface{}{
				"krombat.io/owner": sess.Login,
			},
		},
		"spec": dungeonSpec,
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
	// Business metric: dungeon lifecycle start event (Issue #358)
	slog.Info("dungeon_started",
		"component", "game",
		"dungeon", req.Name,
		"hero_class", heroClass,
		"difficulty", req.Difficulty,
		"monsters", req.Monsters,
		"run_count", runCount,
	)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(result.Object)
}

func (h *Handler) ListDungeons(w http.ResponseWriter, r *http.Request) {
	// Filter by owner label if authenticated.
	listOpts := metav1.ListOptions{}
	if sess := sessionFromCtx(r.Context()); sess != nil {
		listOpts.LabelSelector = "krombat.io/owner=" + sess.Login
	} else {
		// Unauthenticated: return empty list
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]interface{}{})
		return
	}
	list, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace("").List(
		context.Background(), listOpts)
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

	// Ownership check: only the owning user can get their dungeon.
	if err := requireDungeonOwner(r, dungeon); err != nil {
		writeError(w, err.Error(), http.StatusForbidden)
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

	// Read dungeon spec and status before deletion to capture run stats for the leaderboard.
	ctx := context.Background()
	if dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{}); err == nil {
		// Ownership check: only the owning user can delete their dungeon.
		if ownerErr := requireDungeonOwner(r, dungeon); ownerErr != nil {
			writeError(w, ownerErr.Error(), http.StatusForbidden)
			return
		}
		spec, _ := dungeon.Object["spec"].(map[string]interface{})
		kroStatus, _ := dungeon.Object["status"].(map[string]interface{})
		if spec != nil {
			go h.recordLeaderboard(spec, kroStatus, name)
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
// kroStatus is the kro-derived dungeon status (may be nil if kro hasn't reconciled yet).
func (h *Handler) recordLeaderboard(spec map[string]interface{}, kroStatus map[string]interface{}, dungeonName string) {
	heroClass, _ := spec["heroClass"].(string)
	difficulty, _ := spec["difficulty"].(string)
	currentRoom := getInt(spec, "currentRoom")
	attackSeq := getInt(spec, "attackSeq")
	actionSeq := getInt(spec, "actionSeq")

	// Use kro-derived victory/defeat status where available — it is the authoritative
	// source computed by dungeon-graph CEL from boss and hero entity states.
	// Fall back to spec-based derivation only if kro status is absent.
	outcome := "in-progress"
	if kroStatus != nil {
		isVictory, _ := kroStatus["victory"].(bool)
		isDefeat, _ := kroStatus["defeat"].(bool)
		if isVictory {
			outcome = "victory"
		} else if isDefeat {
			outcome = "defeat"
		} else {
			// kro says neither victory nor defeat — check for room1-cleared
			// (boss dead, all monsters dead, still in room 1)
			heroHP := getInt(spec, "heroHP")
			bossHP := getInt(spec, "bossHP")
			if heroHP > 0 {
				monsterHPRaw, _ := spec["monsterHP"].([]interface{})
				allDead := true
				for _, v := range monsterHPRaw {
					if sliceInt(v) > 0 {
						allDead = false
						break
					}
				}
				if bossHP <= 0 && allDead {
					outcome = "room1-cleared"
				}
			}
		}
	} else {
		// kro status unavailable — derive from spec fields directly
		heroHP := getInt(spec, "heroHP")
		bossHP := getInt(spec, "bossHP")
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
	}

	totalTurns := attackSeq + actionSeq
	runCount := getInt(spec, "runCount")
	// Business metric: dungeon lifecycle end event (Issue #358)
	slog.Info("dungeon_ended",
		"component", "game",
		"dungeon", dungeonName,
		"hero_class", heroClass,
		"difficulty", difficulty,
		"outcome", outcome,
		"total_turns", totalTurns,
		"current_room", currentRoom,
		"run_count", runCount,
	)
	// Only persist victories to the leaderboard — defeats, room1-cleared and
	// in-progress deletions are noise that would clutter the top-runs list.
	if outcome != "victory" {
		return
	}
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
		keyTs := time.Now().UTC().Format("20060102-150405")
		newCM := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      leaderboardCMName,
				"namespace": leaderboardNamespace,
			},
			"data": map[string]interface{}{
				keyTs + "-" + dungeonName: string(entryJSON),
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

	// ConfigMap keys must match [-._a-zA-Z0-9]+; RFC3339 timestamps contain colons.
	// Use a compact sortable format instead: "20060102-150405-<name>".
	keyTs := time.Now().UTC().Format("20060102-150405")
	key := keyTs + "-" + dungeonName
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

	// Require authentication — unauthenticated users cannot interact with dungeons.
	if sess := sessionFromCtx(r.Context()); sess == nil {
		writeError(w, "authentication required", http.StatusUnauthorized)
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
		if err := h.processAction(ctx, r, ns, name, req.Target, req.Seq, w); err != nil {
			// error already written
			return
		}
	} else {
		if err := h.processCombat(ctx, r, ns, name, req.Target, req.Damage, req.Seq, w); err != nil {
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
func (h *Handler) processCombat(ctx context.Context, r *http.Request, ns, name, target string, clientDamage int64, clientSeq int64, w http.ResponseWriter) error {
	start := time.Now()
	// These vars are captured by the defer to emit rich log + metrics at end.
	var heroClass, difficulty, combatOutcome string
	var damageDealt, postHeroHP int64
	defer func() {
		slog.Info("attack_processed",
			"component", "api",
			"dungeon", name,
			"target", target,
			"duration_ms", time.Since(start).Milliseconds(),
			"hero_class", heroClass,
			"difficulty", difficulty,
			"outcome", combatOutcome,
			"damage", damageDealt,
			"hero_hp", postHeroHP,
		)
		if heroClass != "" && difficulty != "" && combatOutcome != "" {
			combatEvents.With(map[string]string{
				"event":      "attack",
				"hero_class": heroClass,
				"difficulty": difficulty,
				"outcome":    combatOutcome,
			}).Inc()
		}
	}()
	// Step 1: read current dungeon spec
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon for combat", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return err
	}
	// #409: verify the caller owns this dungeon.
	if ownerErr := requireDungeonOwner(r, dungeon); ownerErr != nil {
		writeError(w, ownerErr.Error(), http.StatusForbidden)
		return ownerErr
	}
	spec := getMap(dungeon.Object, "spec")
	dungeonStatus := getMap(dungeon.Object, "status")

	heroHP := getInt(spec, "heroHP")
	heroClass = getString(spec, "heroClass", "warrior")
	difficulty = getString(spec, "difficulty", "normal")
	maxHeroHPStatus, _ := strconv.ParseInt(getString(dungeonStatus, "maxHeroHP", ""), 10, 64)
	if maxHeroHPStatus <= 0 {
		maxHeroHPStatus = classMaxHP(heroClass)
	}
	maxHeroManaStatus, _ := strconv.ParseInt(getString(dungeonStatus, "maxHeroMana", ""), 10, 64)
	if maxHeroManaStatus < 0 {
		maxHeroManaStatus = classMaxMana(heroClass)
	}
	heroMana := getInt(spec, "heroMana")
	attackSeq := getInt(spec, "attackSeq")
	bossHP := getInt(spec, "bossHP")
	monsterHPRaw, _ := spec["monsterHP"].([]interface{})
	currentRoom := getInt(spec, "currentRoom")
	stunTurns := getInt(spec, "stunTurns")
	ringBonus := getInt(spec, "ringBonus")
	amuletBonus := getInt(spec, "amuletBonus")

	// Conflict guard: reject stale requests
	if clientSeq >= 0 && clientSeq != attackSeq {
		slog.Warn("stale attack rejected", "component", "api", "dungeon", name, "clientSeq", clientSeq, "serverSeq", attackSeq)
		writeError(w, "stale request — dungeon state has changed, please retry", http.StatusConflict)
		return fmt.Errorf("stale attack: clientSeq=%d serverSeq=%d", clientSeq, attackSeq)
	}

	// Guard: reject if dungeon is over
	allMonstersDead := true
	for _, hp := range monsterHPRaw {
		if sliceInt(hp) > 0 {
			allMonstersDead = false
			break
		}
	}
	if heroHP <= 0 || (bossHP <= 0 && allMonstersDead) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(dungeon.Object)
		return nil
	}

	newSeq := attackSeq + 1

	// Mage heal ability
	if target == "hero" {
		if heroClass != "mage" {
			writeError(w, "only mage can heal", http.StatusBadRequest)
			return fmt.Errorf("only mage can heal")
		}
		if heroMana < 2 {
			writeError(w, "not enough mana", http.StatusBadRequest)
			return fmt.Errorf("not enough mana")
		}
		maxHP := maxHeroHPStatus
		newHP := min64(heroHP+40, maxHP)
		heroAction := fmt.Sprintf("Mage heals for %d HP! (Mana: %d)", newHP-heroHP, heroMana-2)
		patch := map[string]interface{}{
			"spec": map[string]interface{}{
				"lastAbility":     "mage-heal",
				"lastHeroAction":  heroAction,
				"lastEnemyAction": "No counter-attack during heal",
				"lastLootDrop":    "",
				"attackSeq":       newSeq,
			},
		}
		if err := h.patchDungeon(ctx, ns, name, patch); err != nil {
			slog.Error("failed to patch dungeon after heal", "component", "api", "dungeon", name, "namespace", ns, "error", err)
			writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
			return err
		}
		// Business metric: ability used (Issue #358)
		slog.Info("ability_used",
			"component", "game",
			"dungeon", name,
			"hero_class", heroClass,
			"ability", "heal",
			"turn", newSeq,
		)
		return h.respondDungeon(ctx, ns, name, w)
	}

	// Warrior taunt activation
	tauntActive := getInt(spec, "tauntActive")
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
				"lastAbility":     "warrior-taunt",
				"lastHeroAction":  "Warrior activates Taunt! Next attack has 60% counter-attack reduction.",
				"lastEnemyAction": "",
				"lastLootDrop":    "",
				"attackSeq":       newSeq,
			},
		}
		// Business metric: ability used (Issue #358)
		slog.Info("ability_used",
			"component", "game",
			"dungeon", name,
			"hero_class", heroClass,
			"ability", "taunt",
			"turn", newSeq,
		)
		return h.patchAndRespond(ctx, ns, name, patch, w)
	}

	// Determine real target (strip -backstab suffix)
	isBackstab := false
	realTarget := target
	backstabCD := getInt(spec, "backstabCooldown")
	if strings.HasSuffix(target, "-backstab") {
		isBackstab = true
		realTarget = strings.TrimSuffix(target, "-backstab")
		if backstabCD > 0 {
			writeError(w, "backstab on cooldown", http.StatusBadRequest)
			return fmt.Errorf("backstab on cooldown")
		}
		// Business metric: backstab ability used (Issue #358)
		slog.Info("ability_used",
			"component", "game",
			"dungeon", name,
			"hero_class", heroClass,
			"ability", "backstab",
			"turn", newSeq,
		)
	}

	isBossTarget := strings.HasSuffix(realTarget, "-boss")

	// Parse monster index for monster targets
	idxInt := -1
	if !isBossTarget {
		idxStr := realTarget
		for i := len(realTarget) - 1; i >= 0; i-- {
			if realTarget[i] < '0' || realTarget[i] > '9' {
				idxStr = realTarget[i+1:]
				break
			}
		}
		idxParsed, _ := strconv.ParseInt(idxStr, 10, strconv.IntSize)
		idxInt = int(idxParsed)
		if idxInt < 0 || idxInt >= len(monsterHPRaw) {
			writeError(w, "invalid monster index", http.StatusBadRequest)
			return fmt.Errorf("invalid monster index")
		}
	}

	// Early-exit: target already dead
	if isBossTarget && bossHP <= 0 {
		patch := map[string]interface{}{"spec": map[string]interface{}{"lastLootDrop": "", "lastHeroAction": "Boss already defeated", "lastEnemyAction": "", "attackSeq": newSeq}}
		return h.patchAndRespond(ctx, ns, name, patch, w)
	}
	if !isBossTarget && idxInt >= 0 && sliceInt(monsterHPRaw[idxInt]) <= 0 {
		patch := map[string]interface{}{"spec": map[string]interface{}{"lastLootDrop": "", "lastHeroAction": "Monster already dead", "lastEnemyAction": "", "attackSeq": newSeq}}
		return h.patchAndRespond(ctx, ns, name, patch, w)
	}

	// Step 2: Upsert Attack CR (trigger for kro)
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
	_, err = h.client.Dynamic.Resource(k8s.AttackGVR).Namespace("default").Patch(
		ctx, attackCRName, types.ApplyPatchType, attackData,
		metav1.PatchOptions{FieldManager: "rpg-backend", Force: boolPtr(true)})
	if err != nil {
		slog.Error("failed to upsert attack CR", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}
	attacksSubmitted.WithLabelValues(name).Inc()

	// Per-turn seed (unique per dungeon+turn, ensures real dice variance)
	turnSeed := name + "-seq-" + strconv.FormatInt(newSeq, 10)

	// Step 3: Write trigger fields only — kro's combatResolve specPatch computes
	// all actual game state (HP, mana, DoT, loot, inventory).
	patchSpec := map[string]interface{}{
		"attackSeq":            newSeq,
		"lastAttackTarget":     realTarget,
		"lastAttackSeed":       turnSeed,
		"lastAttackIndex":      int64(idxInt),
		"lastAttackIsBoss":     isBossTarget,
		"lastAttackIsBackstab": isBackstab,
		"ringBonus":            ringBonus,
		"amuletBonus":          amuletBonus,
		// Clear log fields so stale text isn't visible before kro fires
		"lastHeroAction":  "",
		"lastEnemyAction": "",
		"lastLootDrop":    "",
	}
	if err := h.patchDungeon(ctx, ns, name, map[string]interface{}{"spec": patchSpec}); err != nil {
		slog.Error("failed to patch trigger fields", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusInternalServerError)
		return err
	}

	// Step 4: Poll until kro's combatResolve has fired (combatProcessedSeq == newSeq).
	postDungeon, err := h.pollUntilCombatProcessed(ctx, ns, name, newSeq)
	if err != nil {
		// Timed out or error — return current state so frontend doesn't hang
		slog.Warn("combat poll timed out or failed", "component", "api", "dungeon", name, "seq", newSeq, "error", err)
		return h.respondDungeon(ctx, ns, name, w)
	}
	postSpec := getMap(postDungeon.Object, "spec")
	postStatus := getMap(postDungeon.Object, "status")

	// Populate telemetry vars from post-combat state.
	postHeroHP = getInt(postSpec, "heroHP")
	if isBossTarget {
		damageDealt = getInt(spec, "bossHP") - getInt(postSpec, "bossHP")
	} else if idxInt >= 0 {
		preMonHPs, _ := spec["monsterHP"].([]interface{})
		postMonHPs, _ := postSpec["monsterHP"].([]interface{})
		if idxInt < len(preMonHPs) && idxInt < len(postMonHPs) {
			damageDealt = sliceInt(preMonHPs[idxInt]) - sliceInt(postMonHPs[idxInt])
		}
	}
	if damageDealt < 0 {
		damageDealt = 0
	}
	// Determine combat outcome for metrics.
	postBossHP := getInt(postSpec, "bossHP")
	postMonsterHPRaw, _ := postSpec["monsterHP"].([]interface{})
	postAllMonstersDead := true
	for _, v := range postMonsterHPRaw {
		if sliceInt(v) > 0 {
			postAllMonstersDead = false
			break
		}
	}
	switch {
	case postHeroHP <= 0:
		combatOutcome = "defeat"
	case isBossTarget && postBossHP <= 0 && postAllMonstersDead:
		combatOutcome = "victory"
	case isBossTarget && postBossHP <= 0:
		combatOutcome = "boss_kill"
	case !isBossTarget && idxInt >= 0 && len(postMonsterHPRaw) > idxInt && sliceInt(postMonsterHPRaw[idxInt]) == 0:
		combatOutcome = "kill"
	default:
		combatOutcome = "hit"
	}

	// Emit status-effect metrics from log derivation state.
	prePoisonTurns := getInt(spec, "poisonTurns")
	preBurnTurns := getInt(spec, "burnTurns")
	preStunTurns := getInt(spec, "stunTurns")
	if getInt(postSpec, "poisonTurns") > prePoisonTurns {
		statusEffectsInflicted.With(map[string]string{"effect": "poison"}).Inc()
	}
	if getInt(postSpec, "burnTurns") > preBurnTurns {
		statusEffectsInflicted.With(map[string]string{"effect": "burn"}).Inc()
	}
	if getInt(postSpec, "stunTurns") > preStunTurns {
		statusEffectsInflicted.With(map[string]string{"effect": "stun"}).Inc()
	}

	// Business metrics: emit kill events (Issue #358)
	if combatOutcome == "kill" || combatOutcome == "boss_kill" || combatOutcome == "victory" {
		monstersTypeRaw, _ := spec["monsterTypes"].([]interface{})
		targetType := realTarget
		if isBossTarget {
			slog.Info("boss_killed",
				"component", "game",
				"dungeon", name,
				"hero_class", heroClass,
				"difficulty", difficulty,
				"room", currentRoom,
				"turn", newSeq,
			)
			// If all monsters also dead, the room is fully cleared
			if postAllMonstersDead {
				slog.Info("room_cleared",
					"component", "game",
					"dungeon", name,
					"hero_class", heroClass,
					"difficulty", difficulty,
					"room", currentRoom,
					"turns_used", newSeq,
				)
			}
		} else if idxInt >= 0 {
			if idxInt < len(monstersTypeRaw) {
				if t, ok := monstersTypeRaw[idxInt].(string); ok && t != "" {
					targetType = t
				}
			}
			slog.Info("monster_killed",
				"component", "game",
				"dungeon", name,
				"hero_class", heroClass,
				"difficulty", difficulty,
				"target_type", targetType,
				"room", currentRoom,
				"turn", newSeq,
			)
		}
	}

	// Emit loot drop metric + business event if a new item was dropped.
	postLoot := getString(postSpec, "lastLootDrop", "")
	if postLoot != "" {
		parts := strings.SplitN(postLoot, "-", 2)
		if len(parts) == 2 {
			lootDrops.With(map[string]string{
				"item_type":  parts[0],
				"rarity":     parts[1],
				"difficulty": difficulty,
			}).Inc()
			// Business metric: loot drop event (Issue #358)
			slog.Info("loot_dropped",
				"component", "game",
				"dungeon", name,
				"hero_class", heroClass,
				"difficulty", difficulty,
				"item_type", parts[0],
				"item_rarity", parts[1],
				"room", currentRoom,
			)
		}
	}

	// Step 5: Derive log text from pre→post spec diff (no math — kro is authoritative).
	diceFormula := getString(postStatus, "diceFormula", getString(dungeonStatus, "diceFormula", ""))
	bossPhaseStr := getString(postStatus, "bossPhase", getString(dungeonStatus, "bossPhase", "phase1"))
	heroAction, enemyAction := deriveCombatLog(
		spec, postSpec, realTarget, isBossTarget, idxInt, isBackstab, stunTurns > 0,
		heroClass, diceFormula, bossPhaseStr,
	)

	// Step 6: Write log text and return final dungeon state.
	logPatch := map[string]interface{}{
		"spec": map[string]interface{}{
			"lastHeroAction":  heroAction,
			"lastEnemyAction": enemyAction,
		},
	}
	return h.patchAndRespond(ctx, ns, name, logPatch, w)
}

// pollUntilCombatProcessed polls the Dungeon CR until spec.combatProcessedSeq == targetSeq,
// indicating kro's combatResolve specPatch has fired and all game state is up to date.
// Max wait: 10s (100ms intervals × 100 attempts).
func (h *Handler) pollUntilCombatProcessed(ctx context.Context, ns, name string, targetSeq int64) (*unstructured.Unstructured, error) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		d, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
		if err == nil {
			s := getMap(d.Object, "spec")
			if getInt(s, "combatProcessedSeq") >= targetSeq {
				return d, nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Last try
	d, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("poll timed out and final get failed: %w", err)
	}
	return d, fmt.Errorf("combatProcessedSeq did not reach %d", targetSeq)
}

// deriveCombatLog generates heroAction and enemyAction log strings from a pre→post spec diff.
// No RNG or math — all values are read directly from kro's computed post-state.
func deriveCombatLog(
	pre, post map[string]interface{},
	realTarget string, isBossTarget bool, idxInt int,
	isBackstab bool, wasStunned bool,
	heroClass, diceFormula, bossPhaseStr string,
) (heroAction, enemyAction string) {
	preHeroHP := getInt(pre, "heroHP")
	postHeroHP := getInt(post, "heroHP")
	preHeroMana := getInt(pre, "heroMana")
	postHeroMana := getInt(post, "heroMana")
	preBossHP := getInt(pre, "bossHP")
	postBossHP := getInt(post, "bossHP")
	preMonsterHP, _ := pre["monsterHP"].([]interface{})
	postMonsterHP, _ := post["monsterHP"].([]interface{})
	preInventory := getString(pre, "inventory", "")
	postInventory := getString(post, "inventory", "")
	prePoisonTurns := getInt(pre, "poisonTurns")
	postPoisonTurns := getInt(post, "poisonTurns")
	preBurnTurns := getInt(pre, "burnTurns")
	postBurnTurns := getInt(post, "burnTurns")
	preStunTurns := getInt(pre, "stunTurns")
	postStunTurns := getInt(post, "stunTurns")
	postWeaponBonus := getInt(post, "weaponBonus")
	postWeaponUses := getInt(post, "weaponUses")
	preWeaponBonus := getInt(pre, "weaponBonus")
	preWeaponUses := getInt(pre, "weaponUses")
	postAmuletBonus := getInt(post, "amuletBonus")
	postLastLootDrop := getString(post, "lastLootDrop", "")

	// --- Hero action ---
	var notes []string

	if wasStunned {
		// Hero was stunned: no damage dealt
		if diceFormula != "" {
			heroAction = fmt.Sprintf("[%s] Hero STUNNED! — no attack this turn", diceFormula)
		} else {
			heroAction = "Hero STUNNED! — no attack this turn"
		}
		return heroAction, "Hero was stunned this turn."
	}

	// Compute effective damage from spec diff
	var effectiveDamage int64
	var oldHP, newHP int64
	if isBossTarget {
		oldHP = preBossHP
		newHP = postBossHP
		effectiveDamage = oldHP - newHP
		if effectiveDamage < 0 {
			effectiveDamage = 0
		}
	} else if idxInt >= 0 && idxInt < len(preMonsterHP) && idxInt < len(postMonsterHP) {
		oldHP = sliceInt(preMonsterHP[idxInt])
		newHP = sliceInt(postMonsterHP[idxInt])
		effectiveDamage = oldHP - newHP
		if effectiveDamage < 0 {
			effectiveDamage = 0
		}
	}

	// Class notes from damage diff
	if isBackstab {
		notes = append(notes, "Backstab 3x!")
	} else if heroClass == "mage" {
		if preHeroMana > 0 && postHeroMana < preHeroMana {
			notes = append(notes, "Mage power!")
		} else if preHeroMana == 0 {
			notes = append(notes, "No mana!")
		}
	} else if heroClass == "rogue" {
		notes = append(notes, "Rogue strike!")
	}

	// Mana regen on monster kill (mage)
	if !isBossTarget && heroClass == "mage" && oldHP > 0 && newHP == 0 {
		if postHeroMana > preHeroMana {
			notes = append(notes, "+1 mana!")
		}
	}

	// Weapon broke
	if preWeaponUses > 0 && postWeaponUses == 0 && postWeaponBonus == 0 && preWeaponBonus > 0 {
		notes = append(notes, fmt.Sprintf("+%d wpn, weapon broke!", preWeaponBonus))
	} else if preWeaponUses > 0 && postWeaponUses < preWeaponUses {
		notes = append(notes, fmt.Sprintf("+%d wpn", preWeaponBonus))
	}

	// Amulet
	if postAmuletBonus > 0 {
		notes = append(notes, fmt.Sprintf("+%d%% amulet", postAmuletBonus))
	}

	// Inventory full (loot dropped but inventory unchanged)
	if postLastLootDrop != "" && inventoryCount(postInventory) == inventoryCount(preInventory) && inventoryCount(postInventory) >= 8 {
		notes = append(notes, "inventory full")
	}

	noteStr := ""
	if len(notes) > 0 {
		noteStr = " (" + strings.Join(notes, ", ") + ")"
	}

	formulaStr := ""
	if diceFormula != "" {
		formulaStr = fmt.Sprintf("[%s] ", diceFormula)
	}
	heroAction = fmt.Sprintf("%sHero (%s) deals %d damage to %s (HP: %d -> %d)%s",
		formulaStr, heroClass, effectiveDamage, realTarget, oldHP, newHP, noteStr)

	// --- Enemy action ---
	heroDmgTaken := preHeroHP - postHeroHP
	if heroDmgTaken < 0 {
		heroDmgTaken = 0
	}

	// Check for shaman heals (any monster HP increased)
	var healNotes []string
	for i := range postMonsterHP {
		if i >= len(preMonsterHP) {
			break
		}
		postHP := sliceInt(postMonsterHP[i])
		preHP := sliceInt(preMonsterHP[i])
		if postHP > preHP {
			healNotes = append(healNotes, fmt.Sprintf("Shaman heals m%d for %d HP!", i, postHP-preHP))
		}
	}

	// DoT inflictions
	var effectNotes []string
	if postPoisonTurns > prePoisonTurns {
		if isBossTarget {
			effectNotes = append(effectNotes, fmt.Sprintf("Bat Boss inflicts POISON! (%d turns, -5 HP/turn)", postPoisonTurns))
		} else {
			effectNotes = append(effectNotes, fmt.Sprintf("Monsters inflict POISON! (%d turns, -5 HP/turn)", postPoisonTurns))
		}
	}
	if postBurnTurns > preBurnTurns {
		effectNotes = append(effectNotes, fmt.Sprintf("Boss inflicts BURN! (%d turns, -8 HP/turn)", postBurnTurns))
	}
	if postStunTurns > preStunTurns {
		if isBossTarget {
			effectNotes = append(effectNotes, fmt.Sprintf("Boss inflicts STUN! (%d turn)", postStunTurns))
		} else {
			effectNotes = append(effectNotes, fmt.Sprintf("Archer fires! STUNNED! (%d turn)", postStunTurns))
		}
	}

	phaseNote := ""
	if bossPhaseStr == "phase2" {
		phaseNote = " [ENRAGED ×1.5]"
	} else if bossPhaseStr == "phase3" {
		phaseNote = " [BERSERK ×2.0]"
	}

	allEffects := append(healNotes, effectNotes...)
	effectStr := ""
	if len(allEffects) > 0 {
		effectStr = " " + strings.Join(allEffects, " ")
	}

	if isBossTarget {
		if postBossHP == 0 {
			enemyAction = "Boss defeated!"
		} else if heroDmgTaken > 0 {
			enemyAction = fmt.Sprintf("Boss strikes back for %d damage!%s (Hero HP: %d)%s",
				heroDmgTaken, phaseNote, postHeroHP, effectStr)
		} else {
			enemyAction = fmt.Sprintf("Boss attack blocked/dodged!%s (Hero HP: %d)%s",
				phaseNote, postHeroHP, effectStr)
		}
	} else {
		if newHP == 0 && heroDmgTaken == 0 {
			enemyAction = "Monster slain! No remaining counter-attack." + effectStr
		} else if heroDmgTaken > 0 {
			// Count alive monsters in post-state
			aliveCount := int64(0)
			for _, v := range postMonsterHP {
				if sliceInt(v) > 0 {
					aliveCount++
				}
			}
			enemyAction = fmt.Sprintf("%d monster(s) counter-attack for %d total damage! (Hero HP: %d)%s",
				aliveCount, heroDmgTaken, postHeroHP, effectStr)
		} else {
			enemyAction = "Monsters counter-attack absorbed!" + effectStr
		}
	}

	return heroAction, enemyAction
}

// processAction handles a non-combat action (use item, equip, treasure, door, room transition).
func (h *Handler) processAction(ctx context.Context, r *http.Request, ns, name, action string, clientSeq int64, w http.ResponseWriter) error {
	start := time.Now()
	var heroClassAction, difficultyAction string
	defer func() {
		slog.Info("action_processed",
			"component", "api",
			"dungeon", name,
			"action", action,
			"duration_ms", time.Since(start).Milliseconds(),
			"hero_class", heroClassAction,
			"difficulty", difficultyAction,
		)
		if heroClassAction != "" && difficultyAction != "" {
			combatEvents.With(map[string]string{
				"event":      "action",
				"hero_class": heroClassAction,
				"difficulty": difficultyAction,
				"outcome":    "action",
			}).Inc()
		}
	}()
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		slog.Error("failed to get dungeon for action", "component", "api", "dungeon", name, "namespace", ns, "error", err)
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return err
	}
	// #409: verify the caller owns this dungeon.
	if ownerErr := requireDungeonOwner(r, dungeon); ownerErr != nil {
		writeError(w, ownerErr.Error(), http.StatusForbidden)
		return ownerErr
	}
	spec := getMap(dungeon.Object, "spec")
	dungeonStatusAction := getMap(dungeon.Object, "status")

	heroHP := getInt(spec, "heroHP")
	heroMana := getInt(spec, "heroMana")
	heroClass := getString(spec, "heroClass", "warrior")
	heroClassAction = heroClass
	difficultyAction = getString(spec, "difficulty", "normal")
	maxHeroHPAction, _ := strconv.ParseInt(getString(dungeonStatusAction, "maxHeroHP", ""), 10, 64)
	if maxHeroHPAction <= 0 {
		maxHeroHPAction = classMaxHP(heroClass)
	}
	maxHeroManaAction, _ := strconv.ParseInt(getString(dungeonStatusAction, "maxHeroMana", ""), 10, 64)
	if maxHeroManaAction < 0 {
		maxHeroManaAction = classMaxMana(heroClass)
	}
	inventory := getString(spec, "inventory", "")
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

	// NOTE: backstabCooldown decrement is now handled by kro specPatch node (tickCooldown)
	// in dungeon-graph.yaml, gated on attackSeq + actionSeq advancement.

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
		"actionSeq":  newSeq,
		"lastAction": action, // trigger field for kro's actionResolve specPatch
	}

	// MIGRATION: state mutations (inventory, heroHP, heroMana, equipment bonuses,
	// treasureOpened, doorUnlocked, room transition fields) are now computed by
	// kro's actionResolve specPatch. Backend writes only trigger + log text.
	// Validation stays here (returns 400 errors before setting trigger).

	switch {
	case strings.HasPrefix(action, "use-"):
		item := strings.TrimPrefix(action, "use-")
		if !inventoryContains(inventory, item) {
			writeError(w, "item not in inventory: "+item, http.StatusBadRequest)
			return fmt.Errorf("item not in inventory")
		}

		switch item {
		case "hppotion-common":
			maxHP := maxHeroHPAction
			newHP := min64(heroHP+20, maxHP)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-rare":
			maxHP := maxHeroHPAction
			newHP := min64(heroHP+40, maxHP)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-epic":
			maxHP := maxHeroHPAction
			newHP := min64(heroHP+999, maxHP)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> %d", item, heroHP, newHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-common":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			newMana := min64(heroMana+2, maxHeroManaAction)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-rare":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			newMana := min64(heroMana+3, maxHeroManaAction)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-epic":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			newMana := min64(heroMana+8, maxHeroManaAction)
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		default:
			writeError(w, "unknown item: "+item, http.StatusBadRequest)
			return fmt.Errorf("unknown item")
		}
		// Business metric: item used (consume) (Issue #358)
		{
			parts := strings.SplitN(item, "-", 2)
			rarity := ""
			if len(parts) == 2 {
				rarity = parts[1]
			}
			slog.Info("item_used",
				"component", "game",
				"dungeon", name,
				"hero_class", heroClass,
				"item_type", parts[0],
				"item_rarity", rarity,
				"action", "consume",
			)
		}

	case strings.HasPrefix(action, "equip-"):
		item := strings.TrimPrefix(action, "equip-")
		if !inventoryContains(inventory, item) {
			writeError(w, "item not in inventory: "+item, http.StatusBadRequest)
			return fmt.Errorf("item not in inventory")
		}

		switch item {
		case "weapon-common":
			patchSpec["lastHeroAction"] = "Equipped weapon-common! +5 damage for 3 attacks"
		case "weapon-rare":
			patchSpec["lastHeroAction"] = "Equipped weapon-rare! +10 damage for 3 attacks"
		case "weapon-epic":
			patchSpec["lastHeroAction"] = "Equipped weapon-epic! +20 damage for 3 attacks"
		case "armor-common":
			patchSpec["lastHeroAction"] = "Equipped armor-common! +10% defense"
		case "armor-rare":
			patchSpec["lastHeroAction"] = "Equipped armor-rare! +20% defense"
		case "armor-epic":
			patchSpec["lastHeroAction"] = "Equipped armor-epic! +30% defense"
		case "shield-common":
			patchSpec["lastHeroAction"] = "Equipped shield-common! +10% block chance"
		case "shield-rare":
			patchSpec["lastHeroAction"] = "Equipped shield-rare! +15% block chance"
		case "shield-epic":
			patchSpec["lastHeroAction"] = "Equipped shield-epic! +25% block chance"
		case "helmet-common":
			patchSpec["lastHeroAction"] = "Equipped helmet-common! +5% crit chance"
		case "helmet-rare":
			patchSpec["lastHeroAction"] = "Equipped helmet-rare! +10% crit chance"
		case "helmet-epic":
			patchSpec["lastHeroAction"] = "Equipped helmet-epic! +15% crit chance"
		case "pants-common":
			patchSpec["lastHeroAction"] = "Equipped pants-common! +5% dodge chance"
		case "pants-rare":
			patchSpec["lastHeroAction"] = "Equipped pants-rare! +10% dodge chance"
		case "pants-epic":
			patchSpec["lastHeroAction"] = "Equipped pants-epic! +15% dodge chance"
		case "boots-common":
			patchSpec["lastHeroAction"] = "Equipped boots-common! +20% status resist"
		case "boots-rare":
			patchSpec["lastHeroAction"] = "Equipped boots-rare! +40% status resist"
		case "boots-epic":
			patchSpec["lastHeroAction"] = "Equipped boots-epic! +60% status resist"
		case "ring-common":
			patchSpec["lastHeroAction"] = "Equipped ring-common! +5 HP regen per round"
		case "ring-rare":
			patchSpec["lastHeroAction"] = "Equipped ring-rare! +8 HP regen per round"
		case "ring-epic":
			patchSpec["lastHeroAction"] = "Equipped ring-epic! +12 HP regen per round"
		case "amulet-common":
			patchSpec["lastHeroAction"] = "Equipped amulet-common! +10% damage boost"
		case "amulet-rare":
			patchSpec["lastHeroAction"] = "Equipped amulet-rare! +20% damage boost"
		case "amulet-epic":
			patchSpec["lastHeroAction"] = "Equipped amulet-epic! +30% damage boost"
		default:
			writeError(w, "cannot equip: "+item, http.StatusBadRequest)
			return fmt.Errorf("cannot equip item")
		}
		patchSpec["lastEnemyAction"] = "Item equipped"
		// Business metric: item used (equip) (Issue #358)
		{
			parts := strings.SplitN(item, "-", 2)
			rarity := ""
			if len(parts) == 2 {
				rarity = parts[1]
			}
			slog.Info("item_used",
				"component", "game",
				"dungeon", name,
				"hero_class", heroClass,
				"item_type", parts[0],
				"item_rarity", rarity,
				"action", "equip",
			)
		}

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
		patchSpec["lastHeroAction"] = "Opened the treasure chest!"
		patchSpec["lastEnemyAction"] = ""

	case action == "unlock-door":
		treasureOpened := getInt(spec, "treasureOpened")
		if treasureOpened != 1 {
			writeError(w, "open the treasure first", http.StatusBadRequest)
			return fmt.Errorf("open treasure first")
		}
		patchSpec["lastHeroAction"] = "Door unlocked! A new room awaits..."
		patchSpec["lastEnemyAction"] = ""

	case action == "enter-room-2":
		doorUnlocked := getInt(spec, "doorUnlocked")
		if doorUnlocked != 1 {
			writeError(w, "unlock the door first", http.StatusBadRequest)
			return fmt.Errorf("unlock door first")
		}
		patchSpec["lastHeroAction"] = "Entered Room 2! Stronger enemies await..."
		patchSpec["lastEnemyAction"] = ""
		// Business metric: room 2 entered (Issue #358)
		attackSeqAction := getInt(spec, "attackSeq")
		slog.Info("room2_entered",
			"component", "game",
			"dungeon", name,
			"hero_class", heroClass,
			"difficulty", difficultyAction,
			"turns_used", attackSeqAction+actionSeq,
		)

	default:
		writeError(w, "unknown action: "+action, http.StatusBadRequest)
		return fmt.Errorf("unknown action")
	}

	patch := map[string]interface{}{"spec": patchSpec}
	return h.patchAndRespond(ctx, ns, name, patch, w)
}

// ---- helpers ----------------------------------------------------------------

// requireDungeonOwner checks that the authenticated user (from r's context) is
// the owner of the dungeon CR. Returns a non-nil error if the check fails.
// Legacy dungeons without the krombat.io/owner label are accessible to any
// authenticated user (treat as unowned / public during migration).
func requireDungeonOwner(r *http.Request, dungeon interface{ GetLabels() map[string]string }) error {
	sess := sessionFromCtx(r.Context())
	if sess == nil {
		return fmt.Errorf("authentication required")
	}
	labels := dungeon.GetLabels()
	owner, hasLabel := labels["krombat.io/owner"]
	if hasLabel && owner != sess.Login {
		return fmt.Errorf("forbidden: dungeon belongs to another user")
	}
	return nil
}

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
	slog.Warn("request error", "component", "api", "status", code, "error", msg)
	http.Error(w, msg, code)
}

// ClientErrorHandler accepts structured error reports from the React frontend
// (error boundary and async catch blocks) and writes them as slog lines so
// Container Insights picks them up for CloudWatch metric filters.
// POST /api/v1/client-error
func (h *Handler) ClientErrorHandler(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Message        string `json:"message"`
		Stack          string `json:"stack"`
		ComponentStack string `json:"componentStack"`
		Context        string `json:"context"`
		URL            string `json:"url"`
		Timestamp      string `json:"timestamp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	slog.Error("frontend_error",
		"component", "frontend",
		"message", payload.Message,
		"context", payload.Context,
		"url", payload.URL,
		"timestamp", payload.Timestamp,
	)
	w.WriteHeader(http.StatusNoContent)
}

// VitalsHandler accepts Web Vitals reports from the frontend and logs them as
// structured slog lines for CloudWatch metric filters on LCP/CLS/TTFB/INP ratings.
// POST /api/v1/vitals
func (h *Handler) VitalsHandler(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Name   string  `json:"name"`
		Value  float64 `json:"value"`
		Rating string  `json:"rating"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	slog.Info("web_vital",
		"component", "frontend",
		"name", payload.Name,
		"value", payload.Value,
		"rating", payload.Rating,
	)
	w.WriteHeader(http.StatusNoContent)
}

// EventsTrackHandler accepts game interaction events from the frontend and logs
// them as structured slog lines so CloudWatch log metric filters can slice by
// event type, hero class, difficulty, etc.
// POST /api/v1/events-track
func (h *Handler) EventsTrackHandler(w http.ResponseWriter, r *http.Request) {
	var payload map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	event, _ := payload["event"].(string)
	if event == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	args := []any{"component", "frontend", "event", event}
	for k, v := range payload {
		if k == "event" {
			continue
		}
		args = append(args, k, v)
	}
	slog.Info("game_event", args...)
	w.WriteHeader(http.StatusNoContent)
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

// CelEvalHandler evaluates a CEL expression against the live dungeon spec
// using the real kro CEL environment (same libraries as kro reconcile).
// POST /api/v1/dungeons/{namespace}/{name}/cel-eval
// Body: { "expr": "cel.bind(x, schema.spec.heroHP, x * 2)" }
// Returns: { "result": "300" } or { "error": "..." }
func (h *Handler) CelEvalHandler(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	// #411: require authentication.
	if sess := sessionFromCtx(r.Context()); sess == nil {
		writeError(w, "authentication required", http.StatusUnauthorized)
		return
	}

	var req struct {
		Expr string `json:"expr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Expr == "" {
		writeError(w, "invalid request body: expected {\"expr\":\"...\"}", http.StatusBadRequest)
		return
	}
	// #411: expression complexity limit — reject expressions that are too long
	// or have too many nested brackets (proxy for AST depth / comprehension cost).
	const maxExprLen = 500
	if len(req.Expr) > maxExprLen {
		writeError(w, fmt.Sprintf("expression too long (max %d chars)", maxExprLen), http.StatusBadRequest)
		return
	}

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		r.Context(), name, metav1.GetOptions{})
	if err != nil {
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}
	// #411: require ownership — callers may only eval expressions against their own dungeon.
	if ownerErr := requireDungeonOwner(r, dungeon); ownerErr != nil {
		writeError(w, ownerErr.Error(), http.StatusForbidden)
		return
	}

	spec := getMap(dungeon.Object, "spec")
	// Pass spec + metadata to EvalCEL, which builds the nested schema.spec / schema.metadata
	// activation matching kro's RGD variable layout.
	bindings := make(map[string]interface{}, len(spec)+2)
	for k, v := range spec {
		bindings[k] = v
	}
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

	// #410: require authentication and ownership.
	if sess := sessionFromCtx(r.Context()); sess == nil {
		writeError(w, "authentication required", http.StatusUnauthorized)
		return
	}
	// Read the parent dungeon first (needed for ownership check).
	dungeonObj, dungeonErr := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if dungeonErr != nil {
		writeError(w, sanitizeK8sError(dungeonErr), http.StatusNotFound)
		return
	}
	if ownerErr := requireDungeonOwner(r, dungeonObj); ownerErr != nil {
		writeError(w, ownerErr.Error(), http.StatusForbidden)
		return
	}

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
	// #410: "namespace" kind removed — exposes raw cluster topology; not needed by the K8s Inspector panel.
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
	case "combatcm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-combat-result"}
	case "modifiercm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-modifier-state"}
	case "actioncm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-action-state"}
	case "treasurecm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-treasure"}
	case "treasuresecret":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "secrets"}, name + "-treasure-secret"}
	default:
		writeError(w, "unknown kind: "+kind, http.StatusBadRequest)
		return
	}

	var obj *unstructured.Unstructured
	var fetchErr error
	// All remaining kinds are namespaced resources (namespace kind was removed — #410).
	obj, fetchErr = h.client.Dynamic.Resource(def.gvr).Namespace(ns).Get(ctx, def.resName, metav1.GetOptions{})
	if fetchErr != nil {
		writeError(w, "resource not found: "+fetchErr.Error(), http.StatusNotFound)
		return
	}

	obj.SetManagedFields(nil)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(obj.Object)
}
