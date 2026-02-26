#!/usr/bin/env bash
# Watch a single dungeon's game state in a tmux dashboard
set -euo pipefail

DUNGEON="${1:-}"
if [ -z "$DUNGEON" ]; then
  echo "Available dungeons:"
  kubectl get dungeons --no-headers -o custom-columns='NAME:.metadata.name,LIVING:.status.livingMonsters,BOSS:.status.bossState,VICTORY:.status.victory' 2>/dev/null || echo "  (none)"
  echo ""
  read -rp "Dungeon name: " DUNGEON
fi

NS="${DUNGEON}"

tmux kill-session -t rpg 2>/dev/null || true

tmux new-session -d -s rpg -n dashboard

# Top-left: Dungeon CR status (live)
tmux send-keys "watch -n2 'echo \"=== DUNGEON: ${DUNGEON} ===\"; echo \"\"; kubectl get dungeon ${DUNGEON} -o custom-columns=\"LIVING:.status.livingMonsters,BOSS:.status.bossState,VICTORY:.status.victory,STATE:.status.state\" 2>/dev/null; echo \"\"; echo \"=== SPEC ===\"; kubectl get dungeon ${DUNGEON} -o jsonpath=\"monsterHP: {.spec.monsterHP}  bossHP: {.spec.bossHP}  difficulty: {.spec.difficulty}\" 2>/dev/null; echo \"\"'" C-m

# Top-right: Pods with HP and state
tmux split-window -h
tmux send-keys "watch -n2 'echo \"=== PODS (${NS}) ===\"; echo \"\"; kubectl get pods -n ${NS} -o custom-columns=\"NAME:.metadata.name,ENTITY:.metadata.labels.game\.k8s\.example/entity,STATE:.metadata.labels.game\.k8s\.example/state,HP:.metadata.annotations.game\.k8s\.example/hp\" 2>/dev/null; echo \"\"; echo \"=== TREASURE ===\"; kubectl get secret ${DUNGEON}-treasure -n ${NS} -o jsonpath=\"{.data.loot}\" 2>/dev/null | base64 -d 2>/dev/null; echo \"\"'" C-m

# Bottom-left: Attack jobs
tmux split-window -v -t 0
tmux send-keys "watch -n2 'echo \"=== ATTACK JOBS ===\"; echo \"\"; kubectl get jobs -o custom-columns=\"NAME:.metadata.name,STATUS:.status.conditions[0].type,COMPLETE:.status.succeeded\" 2>/dev/null'" C-m

# Bottom-right: Live events
tmux split-window -v -t 1
tmux send-keys "kubectl get events -n ${NS} -w --field-selector reason!=Pulled,reason!=Scheduled 2>/dev/null || echo 'Waiting for namespace...'" C-m

tmux select-pane -t 0
tmux attach -t rpg
