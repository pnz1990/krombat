#!/usr/bin/env bash
# Monitor all game.k8s.example CRs in a 3x3 tmux grid
# Usage: monitor-custom-resources.sh [dungeon-name]
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$DIR/_mon-panel.sh"
D="${1:-}"
panel() {
  local inner="'$P' '$1' '$2'"
  [[ -n "$D" ]] && inner="$inner '$D'"
  printf 'watch -n2 -t "%s"' "$inner"
}
tmux new-session -d -s krombat-watch \
  "$(panel '⚔️  DUNGEONS' dungeons)" \; \
  split-window -h "$(panel '🗡️  ATTACKS' attacks)" \; \
  split-window -h "$(panel '🎬 ACTIONS' actions)" \; \
  select-layout even-horizontal \; \
  split-window -v -t 0 "$(panel '🦸 HEROES' heroes)" \; \
  split-window -v -t 2 "$(panel '👹 MONSTERS' monsters)" \; \
  split-window -v -t 4 "$(panel '🐉 BOSSES' bosses)" \; \
  split-window -v -t 1 "$(panel '💎 TREASURES' treasures)" \; \
  split-window -v -t 5 "$(panel '✨ MODIFIERS' modifiers)" \; \
  split-window -v -t 7 "$(panel '🎁 LOOTS' loots)" \; \
  select-layout tiled \; \
  attach
