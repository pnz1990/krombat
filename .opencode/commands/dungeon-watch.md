---
description: Monitor a dungeon or all dungeons for a user — live state, combat log, HP, gear, status effects
---
You are monitoring a Krombat dungeon. The argument is: $ARGUMENTS

The argument may be:
- A **dungeon name** (e.g. `my-dungeon`) — inspect that specific dungeon
- A **GitHub username / owner label** (e.g. `spattk`) — find all their dungeons and report on each
- Empty — list all active dungeons across all users

**IMPORTANT**: Always pass `--context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat` on every kubectl command.

---

## Step 1 — Resolve target

If the argument looks like a dungeon name (no spaces, matches an existing dungeon), fetch it directly:
!`kubectl --context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat get dungeon "$ARGUMENTS" -n default -o json 2>/dev/null`

If not found as a dungeon name, search by owner label:
!`kubectl --context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat get dungeons -A -l "krombat.io/owner=$ARGUMENTS" -o json 2>/dev/null`

If the argument is empty, list all dungeons:
!`kubectl --context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat get dungeons -A -o json 2>/dev/null`

---

## Step 2 — For each dungeon found, report the following

Parse the JSON and produce a human-readable report covering:

### Identity
- Dungeon name, namespace, owner (`krombat.io/owner` label)
- Created timestamp and age (compute from `metadata.creationTimestamp`)
- kro state (`status.state`), Ready condition, generation

### Hero
- Class, HP (`heroHP / maxHeroHP from status`), mana (mage only)
- Active status effects: poison turns, burn turns, stun turns
- Taunt active (warrior)
- Backstab cooldown (rogue)

### Combat position
- Current room (`currentRoom`)
- Attack sequence number (`attackSeq`) = turns taken
- Modifier name and effect (`status.modifier`)
- Difficulty and dice formula (`status.diceFormula`)

### Monsters (Room 1)
- For each monster in `status.game.monsterHP[]`: name (from `status.game.monsterTypes[]` if present, else goblin/skeleton by index), current HP / `status.maxMonsterHP`, alive or dead
- Boss HP (`status.game.bossHP`) / `status.maxBossHP`, boss state (`status.bossState`), boss phase (`status.bossPhase`)

### Gear & inventory
- Any equipped bonuses from `status.game` (weaponBonus, armorBonus, shieldBonus, helmetBonus, pantsBonus, bootsBonus, ringBonus, amuletBonus) — only show non-zero
- Inventory items (parse `status.game.inventory` JSON array) — show item type+rarity
- Treasure state (`status.game.treasureOpened`), door unlocked (`status.game.doorUnlocked`)

### Last combat exchange
- `spec.lastHeroAction`
- `spec.lastEnemyAction`
- `spec.lastLootDrop` (if any)

### Assessment
- Is the player winning or struggling? Compute: monsters remaining, hero HP%, threat level
- Any notable risks (poisoned + low HP, curse modifier, boss phase 2/3, etc.)
- Estimated turns to finish the room (rough heuristic based on DPS vs remaining monster HP)
- Leaderboard history for this owner — check the `krombat-leaderboard` ConfigMap:
!`kubectl --context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat get configmap krombat-leaderboard -n rpg-system -o json 2>/dev/null`
  Show prior run count, win/loss, best run (fewest turns to room 2 victory).

---

## Step 3 — Summary table

If multiple dungeons were found, end with a one-line-per-dungeon summary table:

| Dungeon | Owner | Class | Room | Hero HP | Monsters left | Boss | Turns | Status |
|---------|-------|-------|------|---------|---------------|------|-------|--------|

If no dungeons were found for the given argument, say so clearly and suggest checking the spelling or whether the dungeon was already deleted.
