#!/usr/bin/env bash
# Helper: echo header, then kubectl get with namespace stripped
# Usage: _mon-panel.sh <header> <resource> [dungeon-name]
echo "$1"
echo
NS_FLAG=(-A)
FILTER=()
if [[ -n "${3:-}" ]]; then
  if [[ "$2" == "dungeons" ]]; then
    FILTER=(--field-selector "metadata.name=$3")
  else
    NS_FLAG=(-n "$3")
  fi
fi
kubectl get "$2" "${NS_FLAG[@]}" "${FILTER[@]}" --sort-by=.metadata.creationTimestamp 2>&1 | awk '/^NAMESPACE /{sub(/^[^ ]+ +/,""); hdr=1} hdr && !/^NAMESPACE /{sub(/^[^ ]+ +/,"")} {print}'
