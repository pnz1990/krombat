package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/pnz1990/krombat/backend/internal/ws"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

// ReconcileDiff is the payload of a RECONCILE_DIFF WebSocket event.
type ReconcileDiff struct {
	// Resource identifies what changed (e.g. "configmap/my-dungeon-monster-0")
	Resource string `json:"resource"`
	// Kind is the k8s Kind (ConfigMap, Monster, Boss, Hero, …)
	Kind string `json:"kind"`
	// ResourceVersion of the new object
	ResourceVersion string `json:"resourceVersion"`
	// Action is ADDED / MODIFIED / DELETED
	Action string `json:"action"`
	// Fields are the field-level diffs
	Fields []FieldDiff `json:"fields"`
	// DungeonName so the frontend can anchor the event to a dungeon
	DungeonName string `json:"dungeonName"`
	// DungeonNamespace is the namespace the child resource lives in
	DungeonNamespace string `json:"dungeonNamespace"`
}

// FieldDiff is one changed field within a reconcile event.
type FieldDiff struct {
	// Path is the dot-separated field path (e.g. "data.entityState")
	Path string `json:"path"`
	// Old value (empty string on ADDED)
	Old string `json:"old"`
	// New value
	New string `json:"new"`
	// CEL is the kro CEL expression that drives this field (if known)
	CEL string `json:"cel,omitempty"`
	// RGD is the ResourceGraphDefinition responsible
	RGD string `json:"rgd,omitempty"`
	// Concept is the KroConceptId the frontend should surface for this field
	Concept string `json:"concept,omitempty"`
}

// celAnnotation describes what kro CEL expression drives a specific field on a specific resource type.
type celAnnotation struct {
	cel     string
	rgd     string
	concept string
}

// celAnnotations maps "kind/fieldPath" → annotation.
// Keys use lowercase kind and dot-separated path into spec or data.
var celAnnotations = map[string]celAnnotation{
	// ── monster-graph outputs (ConfigMap data fields) ──────────────────────
	"configmap/data.entitystate": {
		cel:     `schema.spec.hp > 0 ? "alive" : "dead"`,
		rgd:     "monster-graph",
		concept: "cel-basics",
	},
	"configmap/data.hp": {
		cel:     `string(schema.spec.hp)`,
		rgd:     "monster-graph / boss-graph / hero-graph",
		concept: "cel-basics",
	},
	// ── boss-graph outputs (ConfigMap data fields) ─────────────────────────
	"configmap/data.entitystate_boss": {
		cel:     `schema.spec.hp > 0 ? (schema.spec.monstersAlive == 0 ? "ready" : "pending") : "defeated"`,
		rgd:     "boss-graph",
		concept: "cel-basics",
	},
	"configmap/data.phase": {
		cel: `schema.spec.hp <= 0 ? "defeated" :
  schema.spec.hp * 100 / schema.spec.maxHP > 50 ? "phase1" :
  schema.spec.hp * 100 / schema.spec.maxHP > 25 ? "phase2" : "phase3"`,
		rgd:     "boss-graph",
		concept: "cel-basics",
	},
	"configmap/data.damagemultiplier": {
		cel: `schema.spec.hp <= 0 ? "10" :
  schema.spec.hp * 100 / schema.spec.maxHP > 50 ? "10" :
  schema.spec.hp * 100 / schema.spec.maxHP > 25 ? "13" : "16"`,
		rgd:     "boss-graph",
		concept: "cel-basics",
	},
	// ── hero-graph outputs (ConfigMap data fields) ─────────────────────────
	"configmap/data.maxhp": {
		cel:     `schema.spec.heroClass == "warrior" ? "200" : schema.spec.heroClass == "mage" ? "120" : "150"`,
		rgd:     "hero-graph",
		concept: "cel-basics",
	},
	"configmap/data.maxmana": {
		cel:     `schema.spec.heroClass == "mage" ? "8" : "0"`,
		rgd:     "hero-graph",
		concept: "cel-basics",
	},
	// ── modifier-graph outputs ─────────────────────────────────────────────
	"configmap/data.effect": {
		cel:     `schema.spec.modifierType == "poison" ? "Poison -5 HP/turn" : ...`,
		rgd:     "modifier-graph",
		concept: "modifier-concept",
	},
	// ── dungeon-graph gameConfig ConfigMap ─────────────────────────────────
	"configmap/data.diceformula": {
		cel:     `schema.spec.difficulty == "easy" ? "1d20+3" : schema.spec.difficulty == "hard" ? "3d20+8" : "2d12+6"`,
		rgd:     "dungeon-graph (gameConfig)",
		concept: "rgd",
	},
	"configmap/data.maxmonsterhp": {
		cel:     `schema.spec.difficulty == "easy" ? "30" : schema.spec.difficulty == "hard" ? "80" : "50"`,
		rgd:     "dungeon-graph (gameConfig)",
		concept: "rgd",
	},
	"configmap/data.maxbosshp": {
		cel:     `schema.spec.difficulty == "easy" ? "200" : schema.spec.difficulty == "hard" ? "800" : "400"`,
		rgd:     "dungeon-graph (gameConfig)",
		concept: "rgd",
	},
	// ── Hero CR spec fields (written by dungeon-graph specPatch) ───────────
	"hero/spec.hp": {
		cel:     `dungeonInit specPatch: heroClass == "warrior" ? 200 : heroClass == "mage" ? 120 : 150`,
		rgd:     "dungeon-graph (dungeonInit specPatch)",
		concept: "spec-patch",
	},
	// ── Monster CR spec fields ─────────────────────────────────────────────
	"monster/spec.hp": {
		cel:     `combatResolve specPatch: monsterHP[idx] recomputed after attack`,
		rgd:     "dungeon-graph (combatResolve specPatch)",
		concept: "spec-patch",
	},
	// ── Boss CR spec fields ────────────────────────────────────────────────
	"boss/spec.hp": {
		cel:     `combatResolve specPatch: bossHP recomputed after attack`,
		rgd:     "dungeon-graph (combatResolve specPatch)",
		concept: "spec-patch",
	},
	"boss/spec.monstersalive": {
		cel:     `size(schema.spec.monsterHP.filter(hp, hp > 0))`,
		rgd:     "dungeon-graph (bossCR template)",
		concept: "status-aggregation",
	},
	// ── Treasure CR spec fields ────────────────────────────────────────────
	"treasure/spec.opened": {
		cel:     `actionResolve specPatch: treasureOpened = 1 when hero opens treasure`,
		rgd:     "dungeon-graph (actionResolve specPatch)",
		concept: "spec-patch",
	},
	"configmap/data.state": {
		cel:     `schema.spec.opened == 1 ? "opened" : "unopened"`,
		rgd:     "treasure-graph",
		concept: "cel-basics",
	},
	// ── Loot CR spec fields ────────────────────────────────────────────────
	"loot/spec.itemtype": {
		cel: `["weapon","armor","hppotion","manapotion","shield","helmet","pants","boots"][
  int(alphabet.indexOf(random.seededString(1, name+"-typ"))) % 8]`,
		rgd:     "monster-graph / boss-graph (lootCR)",
		concept: "cel-probability",
	},
	"loot/spec.rarity": {
		cel: `["common","rare","epic"][rarIdx < 22 ? 0 : rarIdx < 33 ? 1 : 2]
# rarIdx = alphabet.indexOf(random.seededString(1, name+"-rar")) % 36`,
		rgd:     "monster-graph / boss-graph (lootCR)",
		concept: "cel-probability",
	},
	"loot/spec.dropped": {
		cel: `alphabet.indexOf(random.seededString(1, name+"-drop")) % 36
  < (difficulty=="easy" ? 22 : difficulty=="hard" ? 13 : 16)`,
		rgd:     "monster-graph / boss-graph (lootCR)",
		concept: "cel-probability",
	},
}

// resourcesToWatch is the list of GVRs we stream diffs for.
// These are the kro-managed child resources inside dungeon namespaces.
var resourcesToWatch = []schema.GroupVersionResource{
	{Group: "", Version: "v1", Resource: "configmaps"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "heroes"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "monsters"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "bosses"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "treasures"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "modifiers"},
	{Group: "game.k8s.example", Version: "v1alpha1", Resource: "loots"},
}

// lastSeenState caches the previous field snapshot per resource UID for diffing.
type lastSeenState struct {
	mu    sync.Mutex
	state map[string]map[string]string // uid → (fieldPath → value)
}

func newLastSeenState() *lastSeenState {
	return &lastSeenState{state: make(map[string]map[string]string)}
}

func (s *lastSeenState) get(uid string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state[uid]
}

func (s *lastSeenState) set(uid string, fields map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state[uid] = fields
}

func (s *lastSeenState) delete(uid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.state, uid)
}

// StartReconcileDiffWatcher launches goroutines that watch all kro-managed child
// resources across all namespaces and stream field-level diffs to the frontend.
// It only emits RECONCILE_DIFF events for resources inside "dungeon" namespaces
// (i.e. namespaces labelled game.k8s.example/dungeon or whose name is a known dungeon).
func StartReconcileDiffWatcher(client *Client, hub *ws.Hub) {
	cache := newLastSeenState()
	for _, gvr := range resourcesToWatch {
		go watchForDiffs(client, hub, gvr, cache)
	}
}

func watchForDiffs(client *Client, hub *ws.Hub, gvr schema.GroupVersionResource, cache *lastSeenState) {
	for {
		watcher, err := client.Dynamic.Resource(gvr).Namespace("").Watch(context.Background(), metav1.ListOptions{})
		if err != nil {
			slog.Warn("reconcile-diff watch error, retrying", "resource", gvr.Resource, "error", err)
			continue
		}
		for event := range watcher.ResultChan() {
			if event.Type == watch.Error {
				continue
			}
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}

			ns := obj.GetNamespace()
			// Only stream events from dungeon-owned namespaces.
			// Dungeon child namespaces are labelled game.k8s.example/dungeon=<name>.
			// As a fast path, also skip well-known system namespaces.
			if ns == "" || ns == "kube-system" || ns == "kube-public" || ns == "kube-node-lease" ||
				ns == "rpg-system" || ns == "argocd" || ns == "kro" || ns == "amazon-cloudwatch" || ns == "external-dns" {
				continue
			}

			// The dungeon name equals the namespace name (dungeon-graph creates ns with name=schema.metadata.name).
			dungeonName := ns

			uid := string(obj.GetUID())
			kind := strings.ToLower(obj.GetKind())
			name := obj.GetName()
			rv := obj.GetResourceVersion()

			// Flatten the tracked fields for this resource type
			current := flattenFields(kind, obj)

			var diffs []FieldDiff
			switch event.Type {
			case watch.Added:
				// On first appearance, emit all fields as "added" (Old="")
				for path, val := range current {
					fd := FieldDiff{Path: path, Old: "", New: val}
					annotate(kind, path, &fd)
					diffs = append(diffs, fd)
				}
				cache.set(uid, current)

			case watch.Modified:
				prev := cache.get(uid)
				for path, val := range current {
					oldVal := ""
					if prev != nil {
						oldVal = prev[path]
					}
					if oldVal == val {
						continue
					}
					fd := FieldDiff{Path: path, Old: oldVal, New: val}
					annotate(kind, path, &fd)
					diffs = append(diffs, fd)
				}
				cache.set(uid, current)

			case watch.Deleted:
				cache.delete(uid)
				// Emit a single tombstone diff so the frontend can show "deleted"
				diffs = []FieldDiff{{Path: "~", Old: name, New: ""}}
			}

			if len(diffs) == 0 {
				continue
			}

			diff := ReconcileDiff{
				Resource:         fmt.Sprintf("%s/%s", kind, name),
				Kind:             obj.GetKind(),
				ResourceVersion:  rv,
				Action:           string(event.Type),
				Fields:           diffs,
				DungeonName:      dungeonName,
				DungeonNamespace: "default", // Dungeon CRs always live in default
			}

			data, err := json.Marshal(ws.Event{
				Type:      "RECONCILE_DIFF",
				Action:    string(event.Type),
				Name:      dungeonName,
				Namespace: "default",
				Payload:   diff,
			})
			if err != nil {
				continue
			}
			// Broadcast to all WebSocket clients watching this dungeon
			hub.Broadcast(data, "default", dungeonName)
		}
	}
}

// flattenFields extracts the fields we care about from an unstructured object
// and returns them as a map of dot-path → string value.
func flattenFields(kind string, obj *unstructured.Unstructured) map[string]string {
	out := make(map[string]string)

	switch kind {
	case "configmap":
		data, _, _ := unstructured.NestedStringMap(obj.Object, "data")
		for k, v := range data {
			out["data."+strings.ToLower(k)] = v
		}

	default:
		// For CRs: flatten spec and status
		flattenNestedMap(obj.Object, "spec", out)
		flattenNestedMap(obj.Object, "status", out)
	}
	return out
}

// flattenNestedMap walks a nested map and emits leaf values as "prefix.key" paths.
func flattenNestedMap(obj map[string]interface{}, topKey string, out map[string]string) {
	raw, ok := obj[topKey].(map[string]interface{})
	if !ok {
		return
	}
	for k, v := range raw {
		path := topKey + "." + strings.ToLower(k)
		switch val := v.(type) {
		case string:
			out[path] = val
		case bool:
			if val {
				out[path] = "true"
			} else {
				out[path] = "false"
			}
		case int64:
			out[path] = fmt.Sprintf("%d", val)
		case float64:
			out[path] = fmt.Sprintf("%g", val)
		case []interface{}:
			out[path] = flattenSlice(val)
		case map[string]interface{}:
			// Recurse one level for nested objects
			for kk, vv := range val {
				subpath := path + "." + strings.ToLower(kk)
				out[subpath] = fmt.Sprintf("%v", vv)
			}
		default:
			if v != nil {
				out[path] = fmt.Sprintf("%v", v)
			}
		}
	}
}

// flattenSlice converts a slice of interface{} to a compact string representation.
func flattenSlice(s []interface{}) string {
	parts := make([]string, len(s))
	for i, v := range s {
		parts[i] = fmt.Sprintf("%v", v)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// annotate looks up the CEL annotation for a given kind+path and fills in the FieldDiff.
func annotate(kind, path string, fd *FieldDiff) {
	key := kind + "/" + path
	if ann, ok := celAnnotations[key]; ok {
		fd.CEL = ann.cel
		fd.RGD = ann.rgd
		fd.Concept = ann.concept
		return
	}
	// Fallback: strip numeric suffixes (e.g. "data.entitystate" covers monster-0, monster-1, …)
	simplified := strings.TrimRight(path, "0123456789")
	key2 := kind + "/" + strings.TrimSuffix(simplified, "-")
	if ann, ok := celAnnotations[key2]; ok {
		fd.CEL = ann.cel
		fd.RGD = ann.rgd
		fd.Concept = ann.concept
	}
}
