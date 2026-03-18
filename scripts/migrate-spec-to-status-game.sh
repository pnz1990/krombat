#!/usr/bin/env bash
# migrate-spec-to-status-game.sh
#
# One-time migration: copies game-state fields from spec to status.game
# for all existing dungeons that haven't been migrated yet.
#
# This is part of issue #600 (state-node migration). After deploying the
# new KREP-023 kro with state: nodes, existing dungeons still have game
# state in spec. New dungeons get state in status.game. This script
# bridges the gap so we can eventually remove the spec migration fields.
#
# Usage:
#   ./scripts/migrate-spec-to-status-game.sh              # dry-run (default)
#   ./scripts/migrate-spec-to-status-game.sh --apply       # actually patch
#   ./scripts/migrate-spec-to-status-game.sh --apply --verbose
#
# Safety:
#   - Idempotent: skips dungeons that already have status.game.initProcessedSeq set
#   - Skips dungeons with active combat (Attack/Action CR < 90s old)
#   - Uses --context per AGENTS.md rules
#   - Dry-run by default
#
set -euo pipefail

CONTEXT="arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat"
NAMESPACE="default"
DRY_RUN=true
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --apply)  DRY_RUN=false ;;
    --verbose) VERBOSE=true ;;
    --help|-h)
      echo "Usage: $0 [--apply] [--verbose]"
      echo "  --apply   Actually patch dungeons (default is dry-run)"
      echo "  --verbose Print detailed field values"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

kctl() { kubectl --context "$CONTEXT" "$@"; }

if $DRY_RUN; then
  echo "=== DRY RUN (pass --apply to execute) ==="
else
  echo "=== LIVE RUN — will patch status.game ==="
fi
echo ""

# --- List all dungeons ---
DUNGEONS=$(kctl get dungeons -n "$NAMESPACE" -o json 2>/dev/null)
COUNT=$(echo "$DUNGEONS" | jq '.items | length')
echo "Found $COUNT dungeons in namespace $NAMESPACE"
echo ""

if [ "$COUNT" -eq 0 ]; then
  echo "Nothing to migrate."
  exit 0
fi

# --- Get recent Attack/Action CRs for active-game guard ---
NOW=$(date +%s)
ACTIVE_DUNGEONS=""
for kind in attacks actions; do
  CRS=$(kctl get "$kind" -n "$NAMESPACE" -o json 2>/dev/null || echo '{"items":[]}')
  ACTIVE=$(echo "$CRS" | jq -r --argjson now "$NOW" '
    .items[]
    | select((.metadata.creationTimestamp | fromdateiso8601) > ($now - 90))
    | .metadata.labels["krombat.io/dungeon"] // .spec.dungeonName // empty
  ')
  if [ -n "$ACTIVE" ]; then
    ACTIVE_DUNGEONS="$ACTIVE_DUNGEONS $ACTIVE"
  fi
done

MIGRATED=0
SKIPPED_ALREADY=0
SKIPPED_ACTIVE=0
SKIPPED_NOINIT=0
ERRORS=0

# --- Write dungeon list to temp file for while-read without subshell ---
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
echo "$DUNGEONS" | jq -c '.items[]' > "$TMPFILE"

while read -r DUNGEON; do
  NAME=$(echo "$DUNGEON" | jq -r '.metadata.name')
  OWNER=$(echo "$DUNGEON" | jq -r '.metadata.labels["krombat.io/owner"] // "unknown"')

  # --- Skip if already migrated (status.game.initProcessedSeq exists and > 0) ---
  INIT_SEQ=$(echo "$DUNGEON" | jq -r '.status.game.initProcessedSeq // 0')
  if [ "$INIT_SEQ" != "0" ] && [ "$INIT_SEQ" != "null" ]; then
    SKIPPED_ALREADY=$((SKIPPED_ALREADY + 1))
    $VERBOSE && echo "SKIP (already migrated): $NAME (owner=$OWNER, initProcessedSeq=$INIT_SEQ)"
    continue
  fi

  # --- Skip if spec.initProcessedSeq is 0 (dungeon never initialized by old kro) ---
  SPEC_INIT=$(echo "$DUNGEON" | jq -r '.spec.initProcessedSeq // 0')
  if [ "$SPEC_INIT" = "0" ] || [ "$SPEC_INIT" = "null" ]; then
    SKIPPED_NOINIT=$((SKIPPED_NOINIT + 1))
    $VERBOSE && echo "SKIP (never initialized): $NAME (owner=$OWNER, spec.initProcessedSeq=$SPEC_INIT)"
    continue
  fi

  # --- Skip if active combat ---
  if echo "$ACTIVE_DUNGEONS" | grep -qw "$NAME" 2>/dev/null; then
    SKIPPED_ACTIVE=$((SKIPPED_ACTIVE + 1))
    echo "SKIP (active combat): $NAME (owner=$OWNER)"
    continue
  fi

  # --- Build status.game patch from spec fields ---
  # Copies all game-state scalars + arrays from spec to status.game
  PATCH=$(echo "$DUNGEON" | jq -c '
    .spec as $s |
    {
      status: {
        game: (
          {
            heroHP:               ($s.heroHP // 0),
            heroMana:             ($s.heroMana // 0),
            bossHP:               ($s.bossHP // 0),
            modifier:             ($s.modifier // "none"),
            weaponBonus:          ($s.weaponBonus // 0),
            weaponUses:           ($s.weaponUses // 0),
            armorBonus:           ($s.armorBonus // 0),
            shieldBonus:          ($s.shieldBonus // 0),
            helmetBonus:          ($s.helmetBonus // 0),
            pantsBonus:           ($s.pantsBonus // 0),
            bootsBonus:           ($s.bootsBonus // 0),
            ringBonus:            ($s.ringBonus // 0),
            amuletBonus:          ($s.amuletBonus // 0),
            poisonTurns:          ($s.poisonTurns // 0),
            burnTurns:            ($s.burnTurns // 0),
            stunTurns:            ($s.stunTurns // 0),
            tauntActive:          ($s.tauntActive // 0),
            backstabCooldown:     ($s.backstabCooldown // 0),
            treasureOpened:       ($s.treasureOpened // 0),
            currentRoom:          ($s.currentRoom // 1),
            doorUnlocked:         ($s.doorUnlocked // 0),
            room2BossHP:          ($s.room2BossHP // 0),
            lastLootDrop:         ($s.lastLootDrop // ""),
            inventory:            ($s.inventory // ""),
            initProcessedSeq:     ($s.initProcessedSeq // 0),
            combatProcessedSeq:   ($s.combatProcessedSeq // 0),
            abilityProcessedSeq:  ($s.abilityProcessedSeq // 0),
            dotProcessedSeq:      ($s.dotProcessedSeq // 0),
            tauntProcessedSeq:    ($s.tauntProcessedSeq // 0),
            cooldownProcessedSeq: ($s.cooldownProcessedSeq // 0),
            ringProcessedSeq:     ($s.ringProcessedSeq // 0),
            actionProcessedSeq:   ($s.actionProcessedSeq // 0),
            room2ProcessedSeq:    ($s.room2ProcessedSeq // 0)
          }
          + (if $s.monsterHP      then {monsterHP: $s.monsterHP}           else {} end)
          + (if $s.monsterTypes   then {monsterTypes: $s.monsterTypes}     else {} end)
          + (if $s.room2MonsterHP then {room2MonsterHP: $s.room2MonsterHP} else {} end)
        )
      }
    }
  ')

  if $DRY_RUN; then
    echo "WOULD MIGRATE: $NAME (owner=$OWNER)"
    if $VERBOSE; then
      echo "  Patch: $(echo "$PATCH" | jq -c '.status.game | {heroHP, bossHP, currentRoom, initProcessedSeq, monsterHP: (.monsterHP // "n/a")}')"
    fi
    MIGRATED=$((MIGRATED + 1))
  else
    echo "MIGRATING: $NAME (owner=$OWNER)..."
    if kctl patch dungeon "$NAME" -n "$NAMESPACE" \
        --subresource=status --type=merge \
        -p "$PATCH" >/dev/null 2>&1; then
      MIGRATED=$((MIGRATED + 1))
      echo "  OK"
    else
      ERRORS=$((ERRORS + 1))
      echo "  FAILED"
    fi
  fi
done < "$TMPFILE"

echo ""
echo "=== Summary ==="
echo "Migrated:              $MIGRATED"
echo "Skipped (already done): $SKIPPED_ALREADY"
echo "Skipped (never init):   $SKIPPED_NOINIT"
echo "Skipped (active game):  $SKIPPED_ACTIVE"
echo "Errors:                 $ERRORS"

if $DRY_RUN; then
  echo ""
  echo "This was a dry run. Pass --apply to execute."
fi
