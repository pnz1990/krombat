#!/usr/bin/env bash
# Delete all Dungeon CRs — kro cascades cleanup of child resources and namespaces
set -euo pipefail
dungeons=$(kubectl get dungeons -o name 2>/dev/null)
attacks=$(kubectl get attacks -A -o name 2>/dev/null)
actions=$(kubectl get actions -A -o name 2>/dev/null)
if [ -z "$dungeons" ] && [ -z "$attacks" ] && [ -z "$actions" ]; then echo "Nothing to delete"; exit 0; fi
[ -n "$dungeons" ] && echo "$dungeons"
[ -n "$attacks" ] && echo "$attacks"
[ -n "$actions" ] && echo "$actions"
echo ""
read -p "Delete all? (y/N) " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  [ -n "$attacks" ] && kubectl delete attacks -A --all
  [ -n "$actions" ] && kubectl delete actions -A --all
  [ -n "$dungeons" ] && echo "$dungeons" | xargs kubectl delete
fi
