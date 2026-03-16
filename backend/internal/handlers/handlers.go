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
	client         *k8s.Client
	hub            *ws.Hub
	attackLimit    *rateLimiter
	telemetryLimit *rateLimiter // #419: rate-limit telemetry endpoints (per IP)
}

func New(client *k8s.Client, hub *ws.Hub) *Handler {
	h := &Handler{
		client:         client,
		hub:            hub,
		attackLimit:    newRateLimiter(300 * time.Millisecond),
		telemetryLimit: newRateLimiter(2 * time.Second), // max 1 telemetry event per 2s per remote addr
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
			// #475: emit structured log for CloudWatch active_dungeons metric filter
			slog.Info("active_dungeons", "component", "game", "count", len(list.Items))
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
	// #421: cap body to prevent multi-megabyte JSON DoS
	r.Body = http.MaxBytesReader(w, r.Body, 4096) // 4 KB is well above any valid dungeon creation payload
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

	// #423: validate equipment bonus values have a reasonable upper bound.
	// Prevents leaderboard cheating via inflated weapon/armor stats.
	const maxEquipBonus = 50
	if req.WeaponBonus > maxEquipBonus || req.ArmorBonus > maxEquipBonus ||
		req.ShieldBonus > maxEquipBonus || req.HelmetBonus > maxEquipBonus ||
		req.PantsBonus > maxEquipBonus || req.BootsBonus > maxEquipBonus ||
		req.RingBonus > maxEquipBonus || req.AmuletBonus > maxEquipBonus {
		writeError(w, fmt.Sprintf("equipment bonus values must not exceed %d", maxEquipBonus), http.StatusBadRequest)
		return
	}

	// Load persistent profile to pre-populate inventory and equipment for returning players.
	// Only applied when the request carries no explicit gear (i.e. not a manual New Game+).
	var profileInv string
	var profileEquip map[string]int64
	if sess != nil {
		ctx0 := context.Background()
		cmClient0 := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)
		if profCM, profErr := cmClient0.Get(ctx0, profileCMName, metav1.GetOptions{}); profErr == nil {
			if d, ok := profCM.Object["data"].(map[string]interface{}); ok {
				p := profileFromData(d, sess.Login)
				if p.HeroHP > 0 || p.Inventory != "" {
					profileInv = p.Inventory
					profileEquip = map[string]int64{
						"weaponBonus": p.WeaponBonus, "weaponUses": p.WeaponUses,
						"armorBonus": p.ArmorBonus, "shieldBonus": p.ShieldBonus,
						"helmetBonus": p.HelmetBonus, "pantsBonus": p.PantsBonus,
						"bootsBonus": p.BootsBonus, "ringBonus": p.RingBonus,
						"amuletBonus": p.AmuletBonus,
					}
				}
			}
		}
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
	// Carry over gear bonuses: explicit request values take priority,
	// then fall back to persistent profile values for returning players.
	applyBonus := func(field string, reqVal int64, profileVal int64) {
		if reqVal > 0 {
			dungeonSpec[field] = reqVal
		} else if profileVal > 0 {
			dungeonSpec[field] = profileVal
		}
	}
	var profWeaponUses, profWeaponBonus, profArmorBonus, profShieldBonus int64
	var profHelmetBonus, profPantsBonus, profBootsBonus, profRingBonus, profAmuletBonus int64
	if profileEquip != nil {
		profWeaponBonus = profileEquip["weaponBonus"]
		profWeaponUses = profileEquip["weaponUses"]
		profArmorBonus = profileEquip["armorBonus"]
		profShieldBonus = profileEquip["shieldBonus"]
		profHelmetBonus = profileEquip["helmetBonus"]
		profPantsBonus = profileEquip["pantsBonus"]
		profBootsBonus = profileEquip["bootsBonus"]
		profRingBonus = profileEquip["ringBonus"]
		profAmuletBonus = profileEquip["amuletBonus"]
	}
	applyBonus("weaponBonus", req.WeaponBonus, profWeaponBonus)
	if req.WeaponUses > 0 {
		dungeonSpec["weaponUses"] = req.WeaponUses
	} else if profWeaponUses > 0 {
		dungeonSpec["weaponUses"] = profWeaponUses
	}
	applyBonus("armorBonus", req.ArmorBonus, profArmorBonus)
	applyBonus("shieldBonus", req.ShieldBonus, profShieldBonus)
	applyBonus("helmetBonus", req.HelmetBonus, profHelmetBonus)
	applyBonus("pantsBonus", req.PantsBonus, profPantsBonus)
	applyBonus("bootsBonus", req.BootsBonus, profBootsBonus)
	applyBonus("ringBonus", req.RingBonus, profRingBonus)
	applyBonus("amuletBonus", req.AmuletBonus, profAmuletBonus)
	// Carry persistent inventory if no explicit inventory was provided.
	if profileInv != "" {
		dungeonSpec["inventory"] = profileInv
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
			login := ""
			if sess2 := sessionFromCtx(r.Context()); sess2 != nil {
				login = sess2.Login
			}
			go h.recordLeaderboard(spec, kroStatus, name, login)
			go h.recordProfile(login, spec, kroStatus)
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
	GitHubLogin string `json:"githubLogin,omitempty"`
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

const profileCMName = "krombat-profiles"

var leaderboardGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}

// recordLeaderboard writes a run completion entry to the krombat-leaderboard ConfigMap.
// Called asynchronously before dungeon deletion. Silently skips on any error.
// kroStatus is the kro-derived dungeon status (may be nil if kro hasn't reconciled yet).
func (h *Handler) recordLeaderboard(spec map[string]interface{}, kroStatus map[string]interface{}, dungeonName string, githubLogin string) {
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
		// #402: kro status unavailable — do not fall back to raw-HP derivation.
		// Outcome stays "in-progress"; only victories are persisted, so this is a no-op.
		slog.Debug("recordLeaderboard: kro status unavailable, skipping raw-HP fallback (#402)", "dungeon", dungeonName)
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
		GitHubLogin: githubLogin,
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

// UserProfile holds a player's persistent cross-dungeon stats, badges, and inventory.
type UserProfile struct {
	DungeonsPlayed    int            `json:"dungeonsPlayed"`
	DungeonsWon       int            `json:"dungeonsWon"`
	DungeonsLost      int            `json:"dungeonsLost"`
	DungeonsAbandoned int            `json:"dungeonsAbandoned"`
	TotalTurns        int            `json:"totalTurns"`
	TotalKills        int            `json:"totalKills"`
	TotalBossKills    int            `json:"totalBossKills"`
	FavouriteClass    string         `json:"favouriteClass"`
	FavouriteDiff     string         `json:"favouriteDifficulty"`
	Inventory         string         `json:"inventory"` // CSV, same format as spec.inventory
	WeaponBonus       int64          `json:"weaponBonus"`
	WeaponUses        int64          `json:"weaponUses"`
	ArmorBonus        int64          `json:"armorBonus"`
	ShieldBonus       int64          `json:"shieldBonus"`
	HelmetBonus       int64          `json:"helmetBonus"`
	PantsBonus        int64          `json:"pantsBonus"`
	BootsBonus        int64          `json:"bootsBonus"`
	RingBonus         int64          `json:"ringBonus"`
	AmuletBonus       int64          `json:"amuletBonus"`
	HeroHP            int64          `json:"heroHP"`
	HeroMana          int64          `json:"heroMana"`
	EarnedBadges      []string       `json:"earnedBadges"`
	BadgeCounts       map[string]int `json:"badgeCounts"`
	XP                int            `json:"xp"`
	Level             int            `json:"level"`
	KroCertificates   []string       `json:"kroCertificates"`
	FirstPlayed       string         `json:"firstPlayed"`
	LastPlayed        string         `json:"lastPlayed"`
}

func emptyProfile() UserProfile {
	return UserProfile{
		EarnedBadges:    []string{},
		BadgeCounts:     map[string]int{},
		KroCertificates: []string{},
	}
}

func profileFromData(data map[string]interface{}, key string) UserProfile {
	raw, ok := data[key].(string)
	if !ok || raw == "" {
		return emptyProfile()
	}
	var p UserProfile
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return emptyProfile()
	}
	if p.EarnedBadges == nil {
		p.EarnedBadges = []string{}
	}
	if p.BadgeCounts == nil {
		p.BadgeCounts = map[string]int{}
	}
	if p.KroCertificates == nil {
		p.KroCertificates = []string{}
	}
	return p
}

// classDefaultHP returns the default max HP for a hero class.
func classDefaultHP(heroClass string) int64 {
	switch heroClass {
	case "mage":
		return 120
	case "rogue":
		return 150
	default:
		return 200
	}
}

// classDefaultMana returns the default max mana for a hero class (only mage has mana).
func classDefaultMana(heroClass string) int64 {
	if heroClass == "mage" {
		return 8
	}
	return 0
}

// xpThresholds and levelTitles define the career XP level-up table for issue #360.
var xpThresholds = []int{0, 100, 250, 500, 1000, 2000, 3500, 5500, 8000, 12000}
var levelTitles = []string{
	"Adventurer", "Initiate", "Dungeon Runner", "Monster Slayer",
	"Boss Hunter", "Dungeon Veteran", "Elite Delver", "Master Delver",
	"Kro Wielder", "Dungeon Architect",
}

// computeLevel returns the level (1–10) for the given total career XP.
func computeLevel(totalXP int) int {
	level := 1
	for i, threshold := range xpThresholds {
		if totalXP >= threshold {
			level = i + 1
		}
	}
	return level
}

// levelTitle returns the display title for a given level.
func levelTitle(level int) string {
	if level < 1 || level > len(levelTitles) {
		return "Adventurer"
	}
	return levelTitles[level-1]
}

// computeProfileBadges returns badge IDs earned in this dungeon run that should be
// persisted to the profile. Career badges (multi-class, reaper, legend) are evaluated
// after profile stats are updated.
func computeProfileBadges(spec map[string]interface{}, outcome string) []string {
	if outcome != "victory" && outcome != "room1-cleared" {
		return nil
	}
	heroClass, _ := spec["heroClass"].(string)
	difficulty, _ := spec["difficulty"].(string)
	attackSeq := getInt(spec, "attackSeq")
	actionSeq := getInt(spec, "actionSeq")
	totalTurns := attackSeq + actionSeq
	heroHP := getInt(spec, "heroHP")
	currentRoom := getInt(spec, "currentRoom")

	maxHeroHP := classDefaultHP(heroClass)

	weaponBonus := getInt(spec, "weaponBonus")
	equip := []interface{}{
		spec["weaponBonus"], spec["armorBonus"], spec["shieldBonus"],
		spec["helmetBonus"], spec["pantsBonus"], spec["bootsBonus"],
		spec["ringBonus"], spec["amuletBonus"],
	}
	equippedCount := 0
	for _, v := range equip {
		if getInt(map[string]interface{}{"v": v}, "v") > 0 {
			equippedCount++
		}
	}

	// Check no-potion: if inventory still contains potions and hero never used one
	// — approximated by checking whether any potion type appears in lastHeroAction
	lastAction, _ := spec["lastHeroAction"].(string)
	usedPotion := strings.Contains(lastAction, "potion")

	var badges []string
	addIf := func(id string, cond bool) {
		if cond {
			badges = append(badges, id)
		}
	}

	addIf("speedrun", totalTurns <= 30 && outcome == "victory")
	addIf("deathless", heroHP >= maxHeroHP*8/10 && outcome == "victory")
	addIf("pacifist", weaponBonus == 0 && outcome == "victory")
	addIf("warrior-win", heroClass == "warrior" && outcome == "victory")
	addIf("mage-win", heroClass == "mage" && outcome == "victory")
	addIf("rogue-win", heroClass == "rogue" && outcome == "victory")
	addIf("hard-win", difficulty == "hard" && outcome == "victory")
	addIf("collector", equippedCount >= 5 && outcome == "victory")
	addIf("room2-winner", currentRoom >= 2 && outcome == "victory")
	addIf("no-damage", heroHP >= maxHeroHP && outcome == "victory")
	addIf("no-potions", !usedPotion && outcome == "victory")
	addIf("full-kit", equippedCount >= 8 && outcome == "victory")
	return badges
}

// tier2Certs is the set of certificate IDs that can be awarded via the
// POST /api/v1/profile/cert endpoint (frontend-triggered on K8s log tab interaction).
var tier2Certs = map[string]bool{
	"log-explorer":  true,
	"cel-trace":     true,
	"insight-card":  true,
	"glossary":      true,
	"graph-panel":   true,
	"kro-reconcile": true,
}

// computeCertificates derives Tier 1 and Tier 3 certificate IDs from spec + profile state.
// Returns only certs not already in profile.KroCertificates.
func computeCertificates(spec map[string]interface{}, profile UserProfile, outcome string) []string {
	existing := map[string]bool{}
	for _, c := range profile.KroCertificates {
		existing[c] = true
	}
	var certs []string
	add := func(id string) {
		if !existing[id] {
			certs = append(certs, id)
		}
	}

	// Tier 1 — Observer
	if profile.DungeonsPlayed == 1 {
		add("first-dungeon")
	}
	if outcome == "victory" {
		add("cel-state")
	}
	if outcome == "victory" && getInt(spec, "currentRoom") >= 2 {
		add("two-rooms")
	}
	// loot-system: 3+ distinct equipped item types
	equippedTypes := 0
	for _, field := range []string{"weaponBonus", "armorBonus", "shieldBonus", "helmetBonus", "pantsBonus", "bootsBonus", "ringBonus", "amuletBonus"} {
		if getInt(spec, field) > 0 {
			equippedTypes++
		}
	}
	if equippedTypes >= 3 {
		add("loot-system")
	}

	// Tier 3 — Architect
	modifier, _ := spec["modifier"].(string)
	difficulty, _ := spec["difficulty"].(string)
	if outcome == "victory" && strings.HasPrefix(modifier, "curse-") && difficulty == "hard" {
		add("modifier-master")
	}
	if outcome == "victory" && getInt(spec, "runCount") >= 1 {
		add("new-game-plus-cert")
	}
	if profile.DungeonsWon >= 5 {
		add("dungeon-master")
	}
	if profile.Level >= 5 {
		add("cel-scholar")
	}
	// boss-phase: check if bossPhase ever reached phase3 (we track via spec.bossMaxPhase if present;
	// fallback: phase3 means boss HP was ≤25% of room's max — we can't reconstruct that here without
	// tracking, so we gate on outcome==victory as an approximation for now)
	// TODO: add spec.bossMaxPhaseReached field in future
	return certs
}

// recordProfile writes/updates the player's profile ConfigMap in rpg-system.
// Called asynchronously before dungeon deletion. Silently skips on any error.
func (h *Handler) recordProfile(login string, spec map[string]interface{}, kroStatus map[string]interface{}) {
	if login == "" {
		login = "anonymous"
	}

	heroClass, _ := spec["heroClass"].(string)
	difficulty, _ := spec["difficulty"].(string)
	attackSeq := getInt(spec, "attackSeq")
	actionSeq := getInt(spec, "actionSeq")
	totalTurns := attackSeq + actionSeq

	// Derive outcome same way as recordLeaderboard.
	outcome := "in-progress"
	if kroStatus != nil {
		isVictory, _ := kroStatus["victory"].(bool)
		isDefeat, _ := kroStatus["defeat"].(bool)
		if isVictory {
			outcome = "victory"
		} else if isDefeat {
			outcome = "defeat"
		} else {
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
		// #402: kro status unavailable — do not fall back to raw-HP derivation.
		// Outcome stays "in-progress"; profile update is best-effort, not critical.
		slog.Debug("updateUserProfile: kro status unavailable, skipping raw-HP fallback (#402)")
	}

	// Load existing profiles CM or start fresh.
	ctx := context.Background()
	cmClient := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)
	var profile UserProfile
	existing, err := cmClient.Get(ctx, profileCMName, metav1.GetOptions{})
	var data map[string]interface{}
	if err == nil {
		data, _ = existing.Object["data"].(map[string]interface{})
		if data == nil {
			data = map[string]interface{}{}
		}
		profile = profileFromData(data, login)
	} else {
		data = map[string]interface{}{}
		profile = emptyProfile()
		profile.FirstPlayed = time.Now().UTC().Format(time.RFC3339)
	}
	if profile.FirstPlayed == "" {
		profile.FirstPlayed = time.Now().UTC().Format(time.RFC3339)
	}
	profile.LastPlayed = time.Now().UTC().Format(time.RFC3339)

	// Always update stats.
	profile.DungeonsPlayed++
	profile.TotalTurns += int(totalTurns)

	// Count monster kills this run.
	monsterHPRaw, _ := spec["monsterHP"].([]interface{})
	for _, v := range monsterHPRaw {
		if sliceInt(v) <= 0 {
			profile.TotalKills++
		}
	}

	// Count boss kill.
	if getInt(spec, "bossHP") <= 0 {
		profile.TotalBossKills++
	}

	// Update favourite class (most victories per class).
	if outcome == "victory" {
		profile.DungeonsWon++
		// Carry inventory and equipment forward only on victory.
		profile.Inventory, _ = spec["inventory"].(string)
		profile.WeaponBonus = getInt(spec, "weaponBonus")
		profile.WeaponUses = getInt(spec, "weaponUses")
		profile.ArmorBonus = getInt(spec, "armorBonus")
		profile.ShieldBonus = getInt(spec, "shieldBonus")
		profile.HelmetBonus = getInt(spec, "helmetBonus")
		profile.PantsBonus = getInt(spec, "pantsBonus")
		profile.BootsBonus = getInt(spec, "bootsBonus")
		profile.RingBonus = getInt(spec, "ringBonus")
		profile.AmuletBonus = getInt(spec, "amuletBonus")
		// Reset HP/mana to class defaults on victory.
		profile.HeroHP = classDefaultHP(heroClass)
		profile.HeroMana = classDefaultMana(heroClass)
		profile.FavouriteClass = heroClass
		profile.FavouriteDiff = difficulty
	} else if outcome == "defeat" {
		profile.DungeonsLost++
		// Persist hero's wounded state — next dungeon inherits these HP values.
		profile.HeroHP = getInt(spec, "heroHP")
		profile.HeroMana = getInt(spec, "heroMana")
	} else {
		profile.DungeonsAbandoned++
	}

	// XP accumulation — add session XP earned during combat plus end-of-run bonuses (#360).
	// Kill/clear XP is always added (even on defeat) because it was earned.
	sessionXP := int(getInt(spec, "xpEarned"))
	// Victory bonuses (only on full dungeon win)
	if outcome == "victory" {
		sessionXP += 150 // base victory bonus
		if difficulty == "hard" {
			sessionXP += 50 // hard difficulty bonus
		}
		// Flawless: hero HP equals class default max
		if getInt(spec, "heroHP") >= classDefaultHP(heroClass) {
			sessionXP += 25
		}
		// Speedrun: ≤30 total turns
		if totalTurns <= 30 {
			sessionXP += 25
		}
		// New Game+: runCount ≥ 1
		if getInt(spec, "runCount") >= 1 {
			sessionXP += 50
		}
	}
	newTotalXP := profile.XP + sessionXP
	profile.XP = newTotalXP
	profile.Level = computeLevel(newTotalXP)

	// Append earned badges and increment counts.
	newBadges := computeProfileBadges(spec, outcome)
	existing_set := map[string]bool{}
	for _, b := range profile.EarnedBadges {
		existing_set[b] = true
	}
	for _, b := range newBadges {
		if !existing_set[b] {
			profile.EarnedBadges = append(profile.EarnedBadges, b)
		}
		profile.BadgeCounts[b]++
	}

	// Career badges evaluated after stats update.
	wonClasses := map[string]bool{}
	// Infer from badges.
	for _, b := range profile.EarnedBadges {
		switch b {
		case "warrior-win":
			wonClasses["warrior"] = true
		case "mage-win":
			wonClasses["mage"] = true
		case "rogue-win":
			wonClasses["rogue"] = true
		}
	}
	if len(wonClasses) >= 3 && !existing_set["multi-class"] {
		profile.EarnedBadges = append(profile.EarnedBadges, "multi-class")
		profile.BadgeCounts["multi-class"]++
	}
	if profile.DungeonsWon >= 10 && !existing_set["reaper"] {
		profile.EarnedBadges = append(profile.EarnedBadges, "reaper")
		profile.BadgeCounts["reaper"]++
	}
	if profile.DungeonsWon >= 25 && !existing_set["legend"] {
		profile.EarnedBadges = append(profile.EarnedBadges, "legend")
		profile.BadgeCounts["legend"]++
	}
	if getInt(spec, "runCount") >= 1 && outcome == "victory" && !existing_set["new-game-plus"] {
		profile.EarnedBadges = append(profile.EarnedBadges, "new-game-plus")
		profile.BadgeCounts["new-game-plus"]++
	}

	// Compute and append new Tier 1 + Tier 3 certificates (#361).
	newCerts := computeCertificates(spec, profile, outcome)
	profile.KroCertificates = append(profile.KroCertificates, newCerts...)

	profileJSON, err := json.Marshal(profile)
	if err != nil {
		slog.Warn("profile: failed to marshal", "user", login, "error", err)
		return
	}
	data[login] = string(profileJSON)

	if existing == nil || err != nil {
		newCM := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      profileCMName,
				"namespace": leaderboardNamespace,
			},
			"data": data,
		}}
		if _, createErr := cmClient.Create(ctx, newCM, metav1.CreateOptions{}); createErr != nil {
			slog.Warn("profile: failed to create ConfigMap", "user", login, "error", createErr)
		}
		return
	}

	patch := map[string]interface{}{"data": data}
	patchJSON, _ := json.Marshal(patch)
	if _, patchErr := cmClient.Patch(ctx, profileCMName, types.MergePatchType, patchJSON, metav1.PatchOptions{}); patchErr != nil {
		slog.Warn("profile: failed to patch ConfigMap", "user", login, "error", patchErr)
	}
}

// GetProfile returns the authenticated user's persistent profile.
func (h *Handler) GetProfile(w http.ResponseWriter, r *http.Request) {
	sess := sessionFromCtx(r.Context())
	login := "anonymous"
	if sess != nil {
		login = sess.Login
	}

	ctx := context.Background()
	cmClient := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)

	existing, err := cmClient.Get(ctx, profileCMName, metav1.GetOptions{})
	if err != nil {
		// No profiles CM yet — return empty profile.
		profile := emptyProfile()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(profile)
		return
	}

	data, _ := existing.Object["data"].(map[string]interface{})
	profile := profileFromData(data, login)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(profile)
}

// AwardCert awards a Tier 2 certificate to the authenticated user.
// POST /api/v1/profile/cert  Body: { "cert": "<id>" }
// Only accepts cert IDs in the tier2Certs allow-list. No-op if already earned.
// Returns the updated kroCertificates array.
func (h *Handler) AwardCert(w http.ResponseWriter, r *http.Request) {
	sess := sessionFromCtx(r.Context())
	login := "anonymous"
	if sess != nil {
		login = sess.Login
	}

	var req struct {
		Cert string `json:"cert"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !tier2Certs[req.Cert] {
		writeError(w, "invalid or missing cert id", http.StatusBadRequest)
		return
	}

	ctx := context.Background()
	cmClient := h.client.Dynamic.Resource(leaderboardGVR).Namespace(leaderboardNamespace)

	var profile UserProfile
	var data map[string]interface{}
	existing, err := cmClient.Get(ctx, profileCMName, metav1.GetOptions{})
	if err == nil {
		data, _ = existing.Object["data"].(map[string]interface{})
		if data == nil {
			data = map[string]interface{}{}
		}
		profile = profileFromData(data, login)
	} else {
		data = map[string]interface{}{}
		profile = emptyProfile()
	}

	// Deduplicate — no-op if already earned
	for _, c := range profile.KroCertificates {
		if c == req.Cert {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(profile.KroCertificates)
			return
		}
	}
	profile.KroCertificates = append(profile.KroCertificates, req.Cert)

	profileJSON, err := json.Marshal(profile)
	if err != nil {
		writeError(w, "internal error", http.StatusInternalServerError)
		return
	}
	data[login] = string(profileJSON)

	if existing == nil || err != nil {
		newCM := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "v1",
			"kind":       "ConfigMap",
			"metadata": map[string]interface{}{
				"name":      profileCMName,
				"namespace": leaderboardNamespace,
			},
			"data": data,
		}}
		if _, createErr := cmClient.Create(ctx, newCM, metav1.CreateOptions{}); createErr != nil {
			writeError(w, "internal error", http.StatusInternalServerError)
			return
		}
	} else {
		patch := map[string]interface{}{"data": data}
		patchJSON, _ := json.Marshal(patch)
		if _, patchErr := cmClient.Patch(ctx, profileCMName, types.MergePatchType, patchJSON, metav1.PatchOptions{}); patchErr != nil {
			writeError(w, "internal error", http.StatusInternalServerError)
			return
		}
	}

	slog.Info("cert_awarded", "component", "api", "user", login, "cert", req.Cert)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(profile.KroCertificates)
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
	testUser := os.Getenv("KROMBAT_TEST_USER") // exclude test-user entries from the public board
	entries := make([]LeaderboardEntry, 0, len(data))
	for _, v := range data {
		raw, _ := v.(string)
		var e LeaderboardEntry
		if json.Unmarshal([]byte(raw), &e) != nil {
			continue
		}
		if e.Outcome != "victory" {
			continue
		}
		// Exclude entries with no githubLogin (legacy/test runs before auth was required)
		if e.GitHubLogin == "" {
			continue
		}
		// Exclude entries from the test user
		if testUser != "" && e.GitHubLogin == testUser {
			continue
		}
		entries = append(entries, e)
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
	// #399: reject if kro has not yet provided maxHeroHP (hero-graph not reconciled yet)
	if maxHeroHPStr := getString(dungeonStatus, "maxHeroHP", ""); maxHeroHPStr == "" {
		writeError(w, "dungeon initializing — hero max HP not yet computed by kro, please retry", http.StatusServiceUnavailable)
		return fmt.Errorf("hero maxHeroHP not yet available from kro")
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
		// #400: log text uses pre-state HP; kro abilityResolve is authoritative for actual HP mutation
		heroAction := fmt.Sprintf("Mage heals! HP: %d -> (healing...) (Mana: %d -> (spending...))", heroHP, heroMana)
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
	// bossDamageMultiplier is stored ×10 as a string in dungeon status (from boss-graph CEL).
	// e.g. '10'=1.0×, '13'=1.3×, '16'=1.6×. Default '10' when not yet set.
	bossDmgMultStr := getString(postStatus, "bossDamageMultiplier", getString(dungeonStatus, "bossDamageMultiplier", "10"))
	heroAction, enemyAction := deriveCombatLog(
		spec, postSpec, realTarget, isBossTarget, idxInt, isBackstab, stunTurns > 0,
		heroClass, diceFormula, bossPhaseStr, bossDmgMultStr,
	)

	// Step 6: Compute XP delta and write log text + xpEarned together.
	// XP is earned on kill transitions so players keep kill XP even on defeat.
	xpDelta := int64(0)
	switch combatOutcome {
	case "kill":
		xpDelta = 10
	case "boss_kill":
		if currentRoom == 2 {
			xpDelta = 100
		} else {
			xpDelta = 50
		}
	case "victory":
		// boss kill XP (always room 2 for a full victory in room 2, or room 1 for room1-cleared)
		if currentRoom == 2 {
			xpDelta = 100
		} else {
			xpDelta = 50
		}
		// room-clear bonus (all monsters + boss dead)
		xpDelta += 25
	case "defeat":
		// no end-of-run bonuses on defeat, but kill XP already accumulated
	}

	// Room-clear bonus for boss_kill when all monsters also dead (room fully cleared but hero alive)
	if combatOutcome == "boss_kill" && postAllMonstersDead {
		xpDelta += 25
	}

	newXPEarned := getInt(postSpec, "xpEarned") + xpDelta

	logPatch := map[string]interface{}{
		"spec": map[string]interface{}{
			"lastHeroAction":  heroAction,
			"lastEnemyAction": enemyAction,
			"xpEarned":        newXPEarned,
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
	heroClass, diceFormula, bossPhaseStr, bossDmgMultStr string,
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
		// Hero was stunned: no damage dealt, but enemies still counter-attack.
		// Set heroAction and fall through to compute enemyAction from pre→post HP diff.
		if diceFormula != "" {
			heroAction = fmt.Sprintf("[%s] Hero STUNNED! — no attack this turn", diceFormula)
		} else {
			heroAction = "Hero STUNNED! — no attack this turn"
		}
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
	if !wasStunned {
		heroAction = fmt.Sprintf("%sHero (%s) deals %d damage to %s (HP: %d -> %d)%s",
			formulaStr, heroClass, effectiveDamage, realTarget, oldHP, newHP, noteStr)
	}

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

	// DoT inflictions — #401: removed hardcoded per-turn damage amounts (-5/-8 HP/turn)
	// Turn counts are read from spec diff (pre→post); damage amounts are defined in dungeon-graph tickDoT CEL.
	var effectNotes []string
	if postPoisonTurns > prePoisonTurns {
		if isBossTarget {
			effectNotes = append(effectNotes, fmt.Sprintf("Bat Boss inflicts POISON! (%d turns)", postPoisonTurns))
		} else {
			effectNotes = append(effectNotes, fmt.Sprintf("Monsters inflict POISON! (%d turns)", postPoisonTurns))
		}
	}
	if postBurnTurns > preBurnTurns {
		effectNotes = append(effectNotes, fmt.Sprintf("Boss inflicts BURN! (%d turns)", postBurnTurns))
	}
	if postStunTurns > preStunTurns {
		if isBossTarget {
			effectNotes = append(effectNotes, fmt.Sprintf("Boss inflicts STUN! (%d turn)", postStunTurns))
		} else {
			effectNotes = append(effectNotes, fmt.Sprintf("Archer fires! STUNNED! (%d turn)", postStunTurns))
		}
	}

	phaseNote := ""
	if bossPhaseStr == "phase2" || bossPhaseStr == "phase3" {
		// bossDmgMultStr is stored ×10 (e.g. '13' = 1.3×, '16' = 1.6×). Convert for display.
		multInt, _ := strconv.ParseInt(bossDmgMultStr, 10, 64)
		if multInt > 10 {
			whole := multInt / 10
			frac := multInt % 10
			label := "ENRAGED"
			if bossPhaseStr == "phase3" {
				label = "BERSERK"
			}
			phaseNote = fmt.Sprintf(" [%s ×%d.%d]", label, whole, frac)
		}
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
	// #399: reject if kro has not yet provided maxHeroHP (hero-graph not reconciled yet)
	if maxHeroHPStr := getString(dungeonStatusAction, "maxHeroHP", ""); maxHeroHPStr == "" {
		writeError(w, "dungeon initializing — hero max HP not yet computed by kro, please retry", http.StatusServiceUnavailable)
		return fmt.Errorf("hero maxHeroHP not yet available from kro")
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
		"actionSeq":    newSeq,
		"lastAction":   action, // trigger field for kro's actionResolve specPatch
		"lastLootDrop": "",     // clear stale loot from previous combat turn (#AGENTS rule)
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
			// #400: no hardcoded heal amounts — log text uses pre-state HP; kro actionResolve is authoritative for actual HP mutation
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> (healing...)", item, heroHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-rare":
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> (healing...)", item, heroHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "hppotion-epic":
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! HP: %d -> (healing...)", item, heroHP)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-common":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> (restoring...)", item, heroMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-rare":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> (restoring...)", item, heroMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-epic":
			if heroClass != "mage" {
				writeError(w, "mana potions can only be used by Mage", http.StatusBadRequest)
				return fmt.Errorf("mana potion non-mage")
			}
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> (restoring...)", item, heroMana)
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
		// Award XP for entering room 2 (#360)
		patchSpec["xpEarned"] = getInt(spec, "xpEarned") + int64(10)
		// Delete stale Room 1 Attack CR so it cannot be re-processed in Room 2 (#AGENTS rule)
		attackCRName := name + "-latest-attack"
		_ = h.client.Dynamic.Resource(k8s.AttackGVR).Namespace("default").Delete(
			ctx, attackCRName, metav1.DeleteOptions{})
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
// #422: dungeons without the krombat.io/owner label are now DENIED (not allowed).
// This closes the previous "unlabelled = accessible to all" window.
func requireDungeonOwner(r *http.Request, dungeon interface{ GetLabels() map[string]string }) error {
	sess := sessionFromCtx(r.Context())
	if sess == nil {
		return fmt.Errorf("authentication required")
	}
	labels := dungeon.GetLabels()
	owner, hasLabel := labels["krombat.io/owner"]
	if !hasLabel {
		// #422: deny access to unlabelled dungeons — the label is mandatory.
		return fmt.Errorf("forbidden: dungeon has no owner label")
	}
	if owner != sess.Login {
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

// validGameEvents is the allowlist of event names accepted by EventsTrackHandler.
// Unknown events are rejected to prevent log injection and CloudWatch metric poisoning.
var validGameEvents = map[string]bool{
	"dungeon_created":  true,
	"dungeon_deleted":  true,
	"attack_submitted": true,
	"item_used":        true,
	"action_used":      true,
	"boss_killed":      true,
}

// allowedEventKeys is the set of event payload keys accepted by EventsTrackHandler.
// Unknown keys are silently dropped to prevent log injection.
var allowedEventKeys = map[string]bool{
	"event":      true,
	"monsters":   true,
	"difficulty": true,
	"heroClass":  true,
	"target":     true,
	"item":       true,
	"action":     true,
	"outcome":    true,
	"totalTurns": true,
	"room":       true,
	"runCount":   true,
}

// ClientErrorHandler accepts structured error reports from the React frontend
// (error boundary and async catch blocks) and writes them as slog lines so
// Container Insights picks them up for CloudWatch metric filters.
// POST /api/v1/client-error
func (h *Handler) ClientErrorHandler(w http.ResponseWriter, r *http.Request) {
	// #419/#421: rate-limit + body size cap to prevent CloudWatch log flooding
	if !h.telemetryLimit.Allow(r.RemoteAddr) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192) // 8 KB cap
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
	// Cap stack trace at 4 KB to prevent large allocations in slog JSON encoder
	if len(payload.Stack) > 4096 {
		payload.Stack = payload.Stack[:4096]
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
	// #421: body size cap
	r.Body = http.MaxBytesReader(w, r.Body, 1024) // 1 KB is more than enough for a vitals report
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
	// #419/#421: rate-limit + body size cap + event allowlist
	if !h.telemetryLimit.Allow(r.RemoteAddr) {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096) // 4 KB cap
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
	// Validate event name against allowlist
	if !validGameEvents[event] {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	args := []any{"component", "frontend", "event", event}
	for k, v := range payload {
		if k == "event" {
			continue
		}
		// Drop unknown keys to prevent log injection
		if !allowedEventKeys[k] {
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
		// #436: correct CM name is {name}-hero (hero-graph.yaml:34), not {name}-hero-state
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-hero"}
	case "bossstate":
		// #436: correct CM name is {name}-boss (boss-graph.yaml:31), not {name}-boss-state
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-boss"}
	case "monsterstate":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-monster-" + index}
	case "gameconfig":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-game-config"}
	// #441: combatresult, combatcm, actioncm cases removed — these ConfigMaps no longer exist
	// after combat/action resolution migrated to specPatch nodes in dungeon-graph.
	case "modifiercm":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-modifier-state"}
	case "treasurecm":
		// #436: correct CM name is {name}-treasure-state (treasure-graph.yaml:25), not {name}-treasure
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-treasure-state"}
	case "treasuresecret":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "secrets"}, name + "-treasure-secret"}
	// #437: Loot CR and its loot-graph children (lootInfo CM + lootSecret Secret)
	case "loot":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "loots"}, name + "-monster-" + index + "-loot"}
	case "lootinfo":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-monster-" + index + "-loot-info"}
	case "lootsecret":
		if index == "" {
			index = "0"
		}
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "secrets"}, name + "-monster-" + index + "-loot"}
	// #437: Boss loot CR and its loot-graph children
	case "bossloot":
		def = &resourceDef{schema.GroupVersionResource{Group: grp, Version: ver, Resource: "loots"}, name + "-boss-loot"}
	case "bosslootinfo":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "configmaps"}, name + "-boss-loot-info"}
	case "bosslootsecret":
		def = &resourceDef{schema.GroupVersionResource{Group: coreGrp, Version: coreVer, Resource: "secrets"}, name + "-boss-loot"}
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

// RunCard generates a shareable SVG run card for a completed dungeon.
// This endpoint is intentionally unauthenticated — the card contains only
// public-facing display info (hero class, difficulty, turns, dungeon name).
// Query params:
//   - concepts=N  — kro concepts unlocked during the run (optional, from frontend localStorage)
func (h *Handler) RunCard(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		context.Background(), name, metav1.GetOptions{})
	if err != nil {
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}

	spec, _ := dungeon.Object["spec"].(map[string]interface{})
	if spec == nil {
		writeError(w, "dungeon spec not found", http.StatusNotFound)
		return
	}

	heroClass, _ := spec["heroClass"].(string)
	if heroClass == "" {
		heroClass = "warrior"
	}
	difficulty, _ := spec["difficulty"].(string)
	if difficulty == "" {
		difficulty = "normal"
	}
	attackSeq := getInt(spec, "attackSeq")
	currentRoom := getInt(spec, "currentRoom")
	if currentRoom < 1 {
		currentRoom = 1
	}

	// Optional kro concepts unlocked (passed from frontend)
	conceptsStr := r.URL.Query().Get("concepts")
	conceptsUnlocked, _ := strconv.ParseInt(conceptsStr, 10, 64)
	if conceptsUnlocked < 0 {
		conceptsUnlocked = 0
	}
	if conceptsUnlocked > 27 {
		conceptsUnlocked = 27
	}

	// Sanitise name for display (truncate at 28 chars)
	displayName := name
	if len(displayName) > 28 {
		displayName = displayName[:25] + "..."
	}

	// Hero class icon (Unicode block art)
	heroIcon := map[string]string{
		"warrior": "⚔",
		"mage":    "✦",
		"rogue":   "†",
	}[heroClass]
	if heroIcon == "" {
		heroIcon = "⚔"
	}

	// Difficulty colour
	diffColour := map[string]string{
		"easy":   "#4ec94e",
		"normal": "#f0c060",
		"hard":   "#e05050",
	}[difficulty]
	if diffColour == "" {
		diffColour = "#f0c060"
	}

	// Room label
	roomLabel := "Room 1"
	if currentRoom >= 2 {
		roomLabel = "All Rooms"
	}

	// kro concept bar (0-24)
	const totalConcepts = 27
	conceptBarWidth := int(float64(conceptsUnlocked) / float64(totalConcepts) * 220)

	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&amp;display=swap');
      text { font-family: 'Press Start 2P', 'Courier New', monospace; }
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%%" stop-color="#0d0f14"/>
      <stop offset="100%%" stop-color="#1a1d2e"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%%" stop-color="#5b8cf5"/>
      <stop offset="100%%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="480" height="270" fill="url(#bg)" rx="8"/>
  <rect x="1" y="1" width="478" height="268" fill="none" stroke="#2a2d3e" stroke-width="1" rx="7"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="480" height="4" fill="#5b8cf5" rx="2"/>

  <!-- kro brand tag -->
  <rect x="20" y="18" width="60" height="16" fill="#1e2235" rx="3"/>
  <text x="50" y="30" text-anchor="middle" font-size="7" fill="#5b8cf5">kro / k8s</text>

  <!-- Dungeon name -->
  <text x="240" y="56" text-anchor="middle" font-size="10" fill="#e8eaf6" letter-spacing="1">%s</text>

  <!-- Divider -->
  <line x1="40" y1="68" x2="440" y2="68" stroke="#2a2d3e" stroke-width="1"/>

  <!-- Hero icon + class -->
  <text x="80" y="105" text-anchor="middle" font-size="28" fill="#f0c060">%s</text>
  <text x="80" y="122" text-anchor="middle" font-size="8" fill="#9ca3af">%s</text>

  <!-- Difficulty pill -->
  <rect x="150" y="88" width="80" height="22" fill="#1e2235" rx="4"/>
  <text x="190" y="104" text-anchor="middle" font-size="8" fill="%s">%s</text>

  <!-- Turns -->
  <rect x="250" y="88" width="80" height="22" fill="#1e2235" rx="4"/>
  <text x="290" y="104" text-anchor="middle" font-size="8" fill="#9ca3af">%d turns</text>

  <!-- Room cleared -->
  <rect x="348" y="88" width="92" height="22" fill="#1e2235" rx="4"/>
  <text x="394" y="104" text-anchor="middle" font-size="7" fill="#4ec94e">%s</text>

  <!-- kro concepts section -->
  <text x="130" y="148" text-anchor="middle" font-size="7" fill="#9ca3af">kro concepts</text>
  <rect x="20" y="154" width="220" height="8" fill="#1e2235" rx="4"/>
  <rect x="20" y="154" width="%d" height="8" fill="url(#bar)" rx="4"/>
  <text x="248" y="162" font-size="7" fill="#9ca3af">%d / %d</text>

  <!-- Victory label -->
  <text x="370" y="148" text-anchor="middle" font-size="7" fill="#f0c060">VICTORY</text>
  <text x="370" y="162" text-anchor="middle" font-size="18" fill="#f0c060">★</text>

  <!-- Divider -->
  <line x1="40" y1="182" x2="440" y2="182" stroke="#2a2d3e" stroke-width="1"/>

  <!-- Footer -->
  <text x="240" y="205" text-anchor="middle" font-size="7" fill="#4e5568">Powered by kro on Kubernetes</text>
  <text x="240" y="222" text-anchor="middle" font-size="7" fill="#5b8cf5">learn-kro.eks.aws.dev</text>

  <!-- Bottom decorative dots -->
  <circle cx="60" cy="250" r="2" fill="#2a2d3e"/>
  <circle cx="80" cy="250" r="2" fill="#2a2d3e"/>
  <circle cx="100" cy="250" r="2" fill="#2a2d3e"/>
  <circle cx="380" cy="250" r="2" fill="#2a2d3e"/>
  <circle cx="400" cy="250" r="2" fill="#2a2d3e"/>
  <circle cx="420" cy="250" r="2" fill="#2a2d3e"/>
</svg>`,
		displayName,
		heroIcon,
		heroClass,
		diffColour, difficulty,
		attackSeq,
		roomLabel,
		conceptBarWidth,
		conceptsUnlocked, totalConcepts,
	)

	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	fmt.Fprint(w, svg)
}

// RunNarrative generates a shareable Markdown blog post for a completed dungeon run.
// The post narrates the key kro events that occurred during the run, lists unlocked
// concepts, includes the dungeon CR YAML snippet, and closes with a kro CTA.
//
// Query params:
//   - concepts=id1,id2,...  — comma-separated kro concept IDs unlocked (from frontend localStorage)
//
// Authenticated + ownership-checked (unlike RunCard which is intentionally public).
func (h *Handler) RunNarrative(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")
	if !validateNamespace(w, ns) {
		return
	}

	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(
		context.Background(), name, metav1.GetOptions{})
	if err != nil {
		writeError(w, sanitizeK8sError(err), http.StatusNotFound)
		return
	}

	if ownerErr := requireDungeonOwner(r, dungeon); ownerErr != nil {
		writeError(w, ownerErr.Error(), http.StatusForbidden)
		return
	}

	spec, _ := dungeon.Object["spec"].(map[string]interface{})
	if spec == nil {
		writeError(w, "dungeon spec not found", http.StatusNotFound)
		return
	}

	heroClass, _ := spec["heroClass"].(string)
	if heroClass == "" {
		heroClass = "warrior"
	}
	difficulty, _ := spec["difficulty"].(string)
	if difficulty == "" {
		difficulty = "normal"
	}
	attackSeq := getInt(spec, "attackSeq")
	currentRoom := getInt(spec, "currentRoom")
	if currentRoom < 1 {
		currentRoom = 1
	}
	bossHP := getInt(spec, "bossHP")
	room2BossHP := getInt(spec, "room2BossHP")
	modifier, _ := spec["modifier"].(string)
	monstersRaw, _ := spec["monsters"].(int64)
	monsters := int(monstersRaw)
	if monsters == 0 {
		monsters = 1
	}

	// Parse unlocked concept IDs from query param
	conceptsParam := r.URL.Query().Get("concepts")
	conceptIDs := []string{}
	if conceptsParam != "" {
		for _, id := range strings.Split(conceptsParam, ",") {
			if id = strings.TrimSpace(id); id != "" {
				conceptIDs = append(conceptIDs, id)
			}
		}
	}

	// Concept ID → human-readable label + kro docs link
	conceptLabels := map[string]string{
		"resource-graph":      "Resource Graphs",
		"cel-expressions":     "CEL Expressions",
		"reconcile-loop":      "Reconcile Loop",
		"crd-schema":          "CRD Schema",
		"spec-status-split":   "Spec/Status Split",
		"owner-references":    "Owner References",
		"cel-conditionals":    "CEL Conditionals",
		"cel-functions":       "CEL Functions",
		"cel-writeback":       "CEL Writeback",
		"rgd-template":        "RGD Templates",
		"namespace-scoping":   "Namespace Scoping",
		"kro-instance":        "kro Instances",
		"kro-rbac":            "kro RBAC",
		"ready-when":          "readyWhen Conditions",
		"cel-math":            "CEL Math",
		"cel-strings":         "CEL Strings",
		"cel-maps":            "CEL Maps",
		"cel-lists":           "CEL Lists",
		"cel-comprehensions":  "CEL Comprehensions",
		"spec-patch":          "Spec Patch",
		"kro-defaults":        "kro Defaults",
		"multi-resource-rgd":  "Multi-Resource RGDs",
		"kro-status-fields":   "kro Status Fields",
		"cel-ternary":         "CEL Ternary",
		"taunt-state-machine": "State Machines in CEL",
		"mana-lifecycle":      "Resource Lifecycle via CEL",
		"cel-probability":     "Probability in CEL",
	}
	kroDocsBase := "https://kro.run/docs"

	// Build concept section
	var conceptLines []string
	for _, id := range conceptIDs {
		label := conceptLabels[id]
		if label == "" {
			label = strings.ReplaceAll(id, "-", " ")
		}
		conceptLines = append(conceptLines, fmt.Sprintf("- [%s](%s/concepts/%s)", label, kroDocsBase, id))
	}

	// Key kro events narrated from spec fields
	type kroEvent struct {
		turn int64
		desc string
		cel  string
		rgd  string
	}
	var events []kroEvent

	// Event 1: Dungeon CR created → kro reconciles 16 child resources
	events = append(events, kroEvent{
		turn: 1,
		desc: fmt.Sprintf("The Dungeon CR `%s` was created. kro's `dungeon-graph` RGD immediately reconciled and created a Namespace, Hero CR, %d Monster CR(s), a Boss CR, Treasure CR, Modifier CR, and supporting ConfigMaps — all from a single custom resource.", name, monsters),
		cel:  `size(schema.spec.monsterHP.filter(hp, hp > 0))  // monstersAlive count`,
		rgd:  "dungeon-graph",
	})

	// Event 2: Hero class stats via CEL (hero-graph)
	classHP := map[string]int{"warrior": 200, "mage": 120, "rogue": 150}[heroClass]
	if classHP == 0 {
		classHP = 150
	}
	classMana := map[string]int{"warrior": 0, "mage": 8, "rogue": 4}[heroClass]
	events = append(events, kroEvent{
		turn: 1,
		desc: fmt.Sprintf("The `hero-graph` RGD computed the Hero's stats via CEL: max HP = %d for a %s, max mana = %d. The Hero ConfigMap was created with these values, written back by kro's CEL writeback feature.", classHP, heroClass, classMana),
		cel:  fmt.Sprintf(`schema.spec.heroClass == "%s" ? %d : (schema.spec.heroClass == "warrior" ? 200 : 150)  // maxHP`, heroClass, classHP),
		rgd:  "hero-graph",
	})

	// Event 3: Modifier effect
	if modifier != "" && modifier != "none" {
		modDesc := map[string]string{
			"curse-darkness":      "Curse of Darkness — hero damage reduced by 20%.",
			"curse-fury":          "Curse of Fury — monsters deal 30% more damage.",
			"curse-fortitude":     "Curse of Fortitude — boss HP increased by 25%.",
			"blessing-strength":   "Blessing of Strength — hero damage increased by 25%.",
			"blessing-resilience": "Blessing of Resilience — hero takes 25% less damage.",
			"blessing-fortune":    "Blessing of Fortune — loot drop chance doubled.",
		}[modifier]
		if modDesc == "" {
			modDesc = modifier
		}
		events = append(events, kroEvent{
			turn: 1,
			desc: fmt.Sprintf("The dungeon modifier `%s` was active: %s The `modifier-graph` RGD computed the effect and multiplier entirely in CEL — no backend code involved.", modifier, modDesc),
			cel:  `schema.spec.modifier == "blessing-strength" ? 1.25 : (schema.spec.modifier == "curse-darkness" ? 0.80 : 1.0)`,
			rgd:  "modifier-graph",
		})
	}

	// Event 4: Boss phase transitions (if boss was ever engaged)
	if bossHP >= 0 {
		events = append(events, kroEvent{
			turn: attackSeq / 3,
			desc: fmt.Sprintf("As the battle progressed, the `boss-graph` RGD tracked the boss phase in real time via CEL. When boss HP dropped below 50%%, kro recomputed `damageMultiplier` from 1.0 → 1.3; below 25%% it became 1.6. No backend code was needed — CEL expressions in the RGD drove the entire state machine."),
			cel:  `schema.spec.bossHP <= schema.status.maxBossHP * 0.25 ? 1.6 : (schema.spec.bossHP <= schema.status.maxBossHP * 0.5 ? 1.3 : 1.0)`,
			rgd:  "boss-graph",
		})
	}

	// Event 5: Room 2 transition (if player made it)
	if currentRoom >= 2 && room2BossHP > 0 {
		events = append(events, kroEvent{
			turn: attackSeq / 2,
			desc: fmt.Sprintf("After clearing Room 1, the dungeon transitioned to Room 2. kro patched `spec.monsterHP` with 1.5x scaled values (trolls and ghouls replace goblins) and `spec.bossHP` with 1.3x values. The entire room state was driven by a single PATCH to the Dungeon CR spec — kro's `dungeon-graph` RGD reconciled all 16 child resources automatically."),
			cel:  `schema.spec.currentRoom >= 2 ? int(schema.spec.room2BossHP * 1.3) : schema.spec.bossHP`,
			rgd:  "dungeon-graph",
		})
	}

	// Event 6: Loot drop via loot-graph (if inventory non-empty)
	inventory, _ := spec["inventory"].(string)
	if inventory != "" {
		items := strings.Split(inventory, ",")
		firstItem := ""
		for _, it := range items {
			it = strings.TrimSpace(it)
			if it != "" {
				firstItem = it
				break
			}
		}
		if firstItem != "" {
			events = append(events, kroEvent{
				turn: attackSeq / 4,
				desc: fmt.Sprintf("A monster kill triggered a loot drop. The `loot-graph` RGD computed the item type (`%s`), rarity, and description entirely in CEL — the result was written to a Kubernetes Secret managed by kro, then surfaced to the frontend via the dungeon spec.", firstItem),
				cel:  `schema.spec.difficulty == "hard" ? "epic" : (random.seededInt(0, 3, schema.metadata.uid) == 0 ? "rare" : "common")`,
				rgd:  "loot-graph",
			})
		}
	}

	// Build YAML snippet from key spec fields
	yamlSnippet := fmt.Sprintf(`apiVersion: rpg.krombat.io/v1alpha1
kind: Dungeon
metadata:
  name: %s
  namespace: %s
spec:
  heroClass: %s
  difficulty: %s
  monsters: %d
  heroHP: %d
  bossHP: %d
  attackSeq: %d
  currentRoom: %d
  modifier: "%s"
  inventory: "%s"`,
		name, ns,
		heroClass, difficulty,
		monsters,
		getInt(spec, "heroHP"),
		bossHP,
		attackSeq, currentRoom,
		modifier, inventory,
	)

	// Assemble the post
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("# I played a dungeon RPG on Kubernetes — here's what kro did\n\n"))
	capitalize := func(s string) string {
		if len(s) == 0 {
			return s
		}
		return strings.ToUpper(s[:1]) + s[1:]
	}
	sb.WriteString(fmt.Sprintf("> **%s** | **%s** difficulty | **%d turns** | dungeon: `%s`\n\n", capitalize(heroClass), capitalize(difficulty), attackSeq, name))

	if currentRoom >= 2 && bossHP <= 0 {
		sb.WriteString("**Victory!** Both rooms cleared.\n\n")
	} else if currentRoom >= 2 {
		sb.WriteString("**Room 2 reached.** Final boss still standing.\n\n")
	} else {
		sb.WriteString("**Room 1 cleared.**\n\n")
	}

	sb.WriteString("---\n\n")
	sb.WriteString("## What kro did during this run\n\n")
	sb.WriteString("Every attack, every HP change, every loot drop — all driven by [kro](https://github.com/kubernetes-sigs/kro) ResourceGraphDefinitions on Kubernetes. Here are the key reconcile events:\n\n")

	for i, ev := range events {
		sb.WriteString(fmt.Sprintf("### %d. %s\n\n", i+1, ev.desc))
		sb.WriteString(fmt.Sprintf("**RGD:** `%s`\n\n", ev.rgd))
		sb.WriteString(fmt.Sprintf("**CEL expression:**\n```cel\n%s\n```\n\n", ev.cel))
	}

	sb.WriteString("---\n\n")

	if len(conceptLines) > 0 {
		sb.WriteString("## kro concepts I learned\n\n")
		for _, l := range conceptLines {
			sb.WriteString(l + "\n")
		}
		sb.WriteString("\n")
		sb.WriteString("---\n\n")
	}

	sb.WriteString("## The Dungeon CR YAML\n\n")
	sb.WriteString("This single Kubernetes custom resource describes the entire game state:\n\n")
	sb.WriteString(fmt.Sprintf("```yaml\n%s\n```\n\n", yamlSnippet))

	sb.WriteString("---\n\n")
	sb.WriteString("## Try it yourself\n\n")
	sb.WriteString("Play at **[learn-kro.eks.aws.dev](https://learn-kro.eks.aws.dev)** — no local setup needed.\n\n")
	sb.WriteString("Built with **[kro](https://github.com/kubernetes-sigs/kro)** — Kubernetes Resource Orchestrator.\n\n")
	sb.WriteString("> kro lets you define a graph of Kubernetes resources as a single custom resource, with CEL expressions for dynamic values and conditions. No controllers, no operators — just YAML and CEL.\n")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"markdown": sb.String()})
}
