package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pnz1990/krombat/backend/internal/k8s"
	"github.com/pnz1990/krombat/backend/internal/ws"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
						if v, _ := hp.(float64); v > 0 {
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

type CreateDungeonReq struct {
	Name       string `json:"name"`
	Monsters   int64  `json:"monsters"`
	Difficulty string `json:"difficulty"`
	HeroClass  string `json:"heroClass"`
	Namespace  string `json:"namespace"`
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
	if req.Namespace == "" {
		req.Namespace = "default"
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

	dungeon := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "game.k8s.example/v1alpha1",
		"kind":       "Dungeon",
		"metadata":   map[string]interface{}{"name": req.Name},
		"spec": map[string]interface{}{
			"monsters":   req.Monsters,
			"difficulty": req.Difficulty,
			"monsterHP":  monsterHP,
			"bossHP":     hp.boss,
			"heroHP":     heroHP,
			"heroClass":  heroClass,
			"heroMana":   heroMana,
			"modifier":   modifier,
		},
	}}

	result, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(req.Namespace).Create(
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
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}

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

func (h *Handler) DeleteDungeon(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("namespace")
	name := r.PathValue("name")

	err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Delete(
		context.Background(), name, metav1.DeleteOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}
	slog.Info("dungeon deleted", "component", "api", "dungeon", name, "namespace", ns)
	w.WriteHeader(http.StatusNoContent)
}

type CreateAttackReq struct {
	Target string `json:"target"`
	Damage int64  `json:"damage"`
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
		if err := h.processAction(ctx, ns, name, req.Target, w); err != nil {
			// error already written
			return
		}
	} else {
		if err := h.processCombat(ctx, ns, name, req.Target, req.Damage, w); err != nil {
			// error already written
			return
		}
	}
}

// processCombat handles a combat action:
// 1. Read current dungeon spec to get current attackSeq and room
// 2. Upsert fixed-name Attack CR (SSA) with new seq = attackSeq+1 and targetRoom
// 3. kro re-reconciles dungeon-graph, writes combatResult ConfigMap
// 4. Backend reads combatResult ConfigMap, runs full combat math, patches Dungeon spec
func (h *Handler) processCombat(ctx context.Context, ns, name, target string, clientDamage int64, w http.ResponseWriter) error {
	// Step 1: read current dungeon spec
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeError(w, "dungeon not found: "+err.Error(), http.StatusNotFound)
		return err
	}
	spec := getMap(dungeon.Object, "spec")

	heroHP := getInt(spec, "heroHP")
	heroClass := getString(spec, "heroClass", "warrior")
	heroMana := getInt(spec, "heroMana")
	difficulty := getString(spec, "difficulty", "normal")
	tauntActive := getInt(spec, "tauntActive")
	backstabCD := getInt(spec, "backstabCooldown")
	attackSeq := getInt(spec, "attackSeq")
	modifier := getString(spec, "modifier", "none")
	inventory := getString(spec, "inventory", "")
	weaponBonus := getInt(spec, "weaponBonus")
	weaponUses := getInt(spec, "weaponUses")
	armorBonus := getInt(spec, "armorBonus")
	shieldBonus := getInt(spec, "shieldBonus")
	poisonTurns := getInt(spec, "poisonTurns")
	burnTurns := getInt(spec, "burnTurns")
	stunTurns := getInt(spec, "stunTurns")
	currentRoom := getInt(spec, "currentRoom")
	bossHP := getInt(spec, "bossHP")
	monsterHPRaw, _ := spec["monsterHP"].([]interface{})

	// Guard: reject if dungeon is over
	allMonstersDead := true
	for _, hp := range monsterHPRaw {
		if v, _ := hp.(float64); v > 0 {
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
		writeError(w, "failed to upsert attack: "+err.Error(), http.StatusInternalServerError)
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
		tauntActive--
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
			writeError(w, err.Error(), http.StatusInternalServerError)
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
		enemyAction := ""
		effectNote := ""
		if newBossHP > 0 {
			counter = applyModifierToCounter(modifier, counter)
			if armorBonus > 0 {
				counter = counter * (100 - armorBonus) / 100
				if shieldBonus > 0 {
					if seededRoll(attackUID+"-shield", 100) < shieldBonus {
						counter = 0
						classNote += " Shield blocked!"
					}
				}
			}
			if heroClass == "warrior" {
				counter = counter * 3 / 4
			} else if heroClass == "rogue" {
				if seededRoll(attackUID+"-dodge", 100) < 25 {
					counter = 0
					classNote += " Rogue dodged!"
				}
			}
			if tauntActive == 2 && counter > 0 {
				counter = counter * 2 / 5
			}
			heroHP = max64(heroHP-counter, 0)
			enemyAction = fmt.Sprintf("Boss strikes back for %d damage! (Hero HP: %d)", counter, heroHP)

			// Status effects from boss
			effectRoll := seededRoll(attackUID+"-fx", 100)
			if currentRoom == 2 {
				// Bat-boss: poison 30%, stun 15%
				if effectRoll < 15 && stunTurns == 0 {
					stunTurns = 1
					effectNote = " Bat Boss inflicts STUN! (1 turn)"
				} else if effectRoll < 45 && poisonTurns == 0 {
					poisonTurns = 3
					effectNote = " Bat Boss inflicts POISON! (3 turns, -5 HP/turn)"
				}
			} else {
				// Dragon: stun 15%, burn 25%
				if effectRoll < 15 && stunTurns == 0 {
					stunTurns = 1
					effectNote = " Boss inflicts STUN! (1 turn)"
				} else if effectRoll < 40 && burnTurns == 0 {
					burnTurns = 2
					effectNote = " Boss inflicts BURN! (2 turns, -8 HP/turn)"
				}
			}
		} else {
			enemyAction = "Boss defeated!"
			// Boss loot — always drops, added to inventory
			// (Loot CR is created by boss-graph via includeWhen: hp==0)
			// We compute the item name from the same CEL seed so frontend shows it
			bossLootItem := computeBossLoot(name)
			if inventory2 != "" {
				inventory2 = inventory2 + "," + bossLootItem
			} else {
				inventory2 = bossLootItem
			}
			lootDrop = bossLootItem
			classNote += " Boss dropped " + bossLootItem + "!"
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
		// Monster target
		idxStr := realTarget
		for i := len(realTarget) - 1; i >= 0; i-- {
			if realTarget[i] < '0' || realTarget[i] > '9' {
				idxStr = realTarget[i+1:]
				break
			}
		}
		idx, _ := strconv.ParseInt(idxStr, 10, 64)

		if idx < 0 || idx >= int64(len(monsterHPRaw)) {
			writeError(w, "invalid monster index", http.StatusBadRequest)
			return fmt.Errorf("invalid monster index")
		}
		idxInt := int(idx) // safe: bounds checked above, len(monsterHPRaw) <= 10
		oldHP := int64(monsterHPRaw[idxInt].(float64))
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
		if oldHP > 0 && newHP == 0 && heroClass == "mage" && heroMana < 5 {
			heroMana++
			classNote += " +1 mana!"
		}

		// Loot drop on kill transition
		if oldHP > 0 && newHP == 0 {
			if dropped, item := computeMonsterLoot(name, idxInt, difficulty); dropped {
				if inventory2 != "" {
					inventory2 = inventory2 + "," + item
				} else {
					inventory2 = item
				}
				lootDrop = item
				classNote += " Dropped " + item + "!"
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
			hp := int64(v.(float64))
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
		enemyAction := ""
		if totalCounter > 0 {
			if heroClass == "warrior" {
				totalCounter = totalCounter * 4 / 5
			} else if heroClass == "rogue" {
				if seededRoll(attackUID+"-dodge", 100) < 25 {
					totalCounter = 0
					classNote += " Rogue dodged!"
				}
			}
			if tauntActive == 2 && totalCounter > 0 {
				totalCounter = totalCounter * 2 / 5
			}
			heroHP = max64(heroHP-totalCounter, 0)
			enemyAction = fmt.Sprintf("%d monsters counter-attack for %d total damage! (Hero HP: %d)", aliveCount, totalCounter, heroHP)
		} else if newHP == 0 {
			enemyAction = "Monster slain! No remaining counter-attack."
		} else {
			enemyAction = "Monsters counter-attack absorbed!"
		}

		// Status effects from monster counter
		effectNote := ""
		if aliveCount > 0 && poisonTurns == 0 {
			if seededRoll(attackUID+"-fx", 100) < 20 {
				poisonTurns = 3
				effectNote = " Monsters inflict POISON! (3 turns, -5 HP/turn)"
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
func (h *Handler) processAction(ctx context.Context, ns, name, action string, w http.ResponseWriter) error {
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeError(w, "dungeon not found: "+err.Error(), http.StatusNotFound)
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
		writeError(w, "failed to upsert action: "+err.Error(), http.StatusInternalServerError)
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
			newMana := min64(heroMana+2, 5)
			patchSpec["heroMana"] = newMana
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-rare":
			newMana := min64(heroMana+3, 5)
			patchSpec["heroMana"] = newMana
			patchSpec["lastHeroAction"] = fmt.Sprintf("Used %s! Mana: %d -> %d", item, heroMana, newMana)
			patchSpec["lastEnemyAction"] = "Item used"
		case "manapotion-epic":
			newMana := min64(heroMana+5, 5)
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
		default:
			writeError(w, "cannot equip: "+item, http.StatusBadRequest)
			return fmt.Errorf("cannot equip item")
		}
		patchSpec["lastEnemyAction"] = "Item equipped"

	case action == "open-treasure":
		allDead := true
		for _, v := range monsterHPRaw {
			if hp, _ := v.(float64); hp > 0 {
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
		var r2MonsterHP, r2BossHP int64
		switch difficulty {
		case "easy":
			r2MonsterHP, r2BossHP = 50, 400
		case "hard":
			r2MonsterHP, r2BossHP = 120, 1200
		default:
			r2MonsterHP, r2BossHP = 80, 800
		}
		newMonsterHP := make([]interface{}, len(monsterHPRaw))
		for i := range newMonsterHP {
			newMonsterHP[i] = r2MonsterHP
		}
		patchSpec["currentRoom"] = int64(2)
		patchSpec["monsterHP"] = newMonsterHP
		patchSpec["bossHP"] = r2BossHP
		patchSpec["room2MonsterHP"] = newMonsterHP
		patchSpec["room2BossHP"] = r2BossHP
		patchSpec["treasureOpened"] = int64(0)
		patchSpec["doorUnlocked"] = int64(0)
		patchSpec["lastHeroAction"] = "Entered Room 2! Stronger enemies await..."
		patchSpec["lastEnemyAction"] = ""

	default:
		writeError(w, "unknown action: "+action, http.StatusBadRequest)
		return fmt.Errorf("unknown action")
	}

	patch := map[string]interface{}{"spec": patchSpec}
	return h.patchAndRespond(ctx, ns, name, patch, w)
}

// ---- helpers ----------------------------------------------------------------

func (h *Handler) patchDungeon(ctx context.Context, ns, name string, patch map[string]interface{}) error {
	data, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Patch(
		ctx, name, types.MergePatchType, data, metav1.PatchOptions{})
	return err
}

func (h *Handler) patchAndRespond(ctx context.Context, ns, name string, patch map[string]interface{}, w http.ResponseWriter) error {
	if err := h.patchDungeon(ctx, ns, name, patch); err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return err
	}
	return h.respondDungeon(ctx, ns, name, w)
}

func (h *Handler) respondDungeon(ctx context.Context, ns, name string, w http.ResponseWriter) error {
	dungeon, err := h.client.Dynamic.Resource(k8s.DungeonGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
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

// ---- game math helpers -------------------------------------------------------

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
	typRoll := int(seededRoll(seed+"-typ", 5))
	types := []string{"weapon", "armor", "hppotion", "manapotion", "shield"}
	return true, types[typRoll] + "-" + rarity
}

// computeBossLoot mirrors the CEL logic in boss-graph.yaml.
func computeBossLoot(dungeonName string) string {
	rarRoll := int(seededRoll(dungeonName+"-boss-rar", 36))
	rarity := "rare"
	if rarRoll >= 18 {
		rarity = "epic"
	}
	typRoll := int(seededRoll(dungeonName+"-boss-typ", 4))
	types := []string{"weapon", "armor", "hppotion", "shield"}
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

func inventoryContains(inventory, item string) bool {
	for _, v := range strings.Split(inventory, ",") {
		if v == item {
			return true
		}
	}
	return false
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
