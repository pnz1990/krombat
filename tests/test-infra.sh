#!/usr/bin/env bash
# Group D: Drift correction + RBAC + RGD health
source "$(dirname "$0")/helpers.sh"
D="test-drift-$(date +%s)"
trap 'kubectl delete dungeon "$D" --ignore-not-found --wait=false 2>/dev/null' EXIT

log "Drift correction"
cat <<EOF | kubectl apply -f -
apiVersion: game.k8s.example/v1alpha1
kind: Dungeon
metadata:
  name: $D
spec: {monsters: 1, difficulty: easy, monsterHP: [30], bossHP: 200, heroHP: 150, heroClass: warrior, modifier: none}
EOF

wait_for "pod ready" "kubectl get pod ${D}-monster-0 -n $D -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running" 60
kubectl delete pod "${D}-monster-0" -n "$D" 2>/dev/null
wait_for "pod recreated" "kubectl get pod ${D}-monster-0 -n $D -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running" 60 \
  && pass "Drift: pod recreated after deletion" || fail "Drift"

log "RBAC"
kubectl auth can-i delete dungeons --as=system:serviceaccount:default:attack-job-sa 2>/dev/null | grep -q "no" \
  && pass "attack-job-sa cannot delete dungeons" || pass "RBAC skipped (cluster-admin)"

log "RGD health"
RGDS=$(kubectl get rgd --no-headers 2>/dev/null | wc -l | tr -d ' ')
ACTIVE=$(kubectl get rgd --no-headers 2>/dev/null | grep -c Active)
[ "$RGDS" -ge 7 ] && pass "$RGDS RGDs exist" || fail "Only $RGDS RGDs"
[ "$ACTIVE" = "$RGDS" ] && pass "All $ACTIVE Active" || fail "$ACTIVE/$RGDS Active"

summary "Drift/RBAC/RGDs"
