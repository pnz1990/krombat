# Operations Runbook

## Common Operations

### Check dungeon status
```bash
kubectl get dungeons
kubectl get dungeon <name> -o jsonpath='{.status}'
```

### Check all pods in a dungeon
```bash
kubectl get pods -n <dungeon-name> -o custom-columns='NAME:.metadata.name,HP:.metadata.annotations.game\.k8s\.example/hp,STATE:.metadata.labels.game\.k8s\.example/state'
```

### Check RGD health
```bash
kubectl get rgd
kubectl get rgd dungeon-graph -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'
kubectl get rgd attack-graph -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'
```

### Force kro to re-reconcile a dungeon
```bash
kubectl annotate dungeon <name> kro.run/force-reconcile=$(date +%s) --overwrite
```

## Troubleshooting

### Attack job stuck or failing
```bash
# Check job status
kubectl get jobs -l test-dungeon=<name>
kubectl logs job/<attack-name>

# Cancel a stuck job
kubectl delete job <attack-name>

# Delete the Attack CR
kubectl delete attack <attack-name>
```

### Monster pod not updating state after attack
kro reconciles on a loop. Wait 10-15 seconds. If still stuck:
```bash
# Check the Dungeon CR spec — HP values should reflect the attack
kubectl get dungeon <name> -o jsonpath='{.spec.monsterHP}'

# Force reconciliation
kubectl annotate dungeon <name> kro.run/force-reconcile=$(date +%s) --overwrite
```

### Manually set monster HP (emergency)
```bash
# Set monster-0 HP to 0 (kill it)
kubectl patch dungeon <name> --type=merge -p '{"spec":{"monsterHP":[0,50,50]}}'
```

### Manually defeat boss (emergency)
```bash
kubectl patch dungeon <name> --type=merge -p '{"spec":{"bossHP":0}}'
```

### Clean up orphaned dungeon namespace
```bash
# Delete the dungeon CR — kro will clean up the namespace
kubectl delete dungeon <name>

# If namespace is stuck, force delete
kubectl delete ns <dungeon-name> --force --grace-period=0
```

### RGD stuck in Inactive
```bash
# Check the error
kubectl get rgd <name> -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'

# Delete and let Argo CD recreate it
kubectl delete rgd <name>
```

## Dungeon Reaper

A CronJob runs every 10 minutes and deletes dungeons older than 4 hours (configurable via `MAX_AGE_HOURS` env var).

```bash
# Check reaper status
kubectl get cronjob dungeon-reaper -n rpg-system

# Check last run
kubectl get jobs -n rpg-system -l job-name=dungeon-reaper --sort-by=.metadata.creationTimestamp

# Trigger manual reap
kubectl create job --from=cronjob/dungeon-reaper manual-reap -n rpg-system
```

## Argo CD

### Force sync
```bash
kubectl annotate application krombat -n argocd argocd.argoproj.io/refresh=hard --overwrite
```

### Check sync status
```bash
kubectl get application krombat -n argocd -o jsonpath='Sync: {.status.sync.status} Rev: {.status.sync.revision}'
```
