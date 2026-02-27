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

## CloudWatch Observability

### Log Groups
| Log Group | Contents | Retention |
|-----------|----------|-----------|
| `/eks/krombat/rpg-system` | Backend + frontend container logs | 7 days |
| `/eks/krombat/game` | Attack Job logs, dungeon namespace pods | 7 days |
| `/eks/krombat/kro` | kro controller logs | 30 days |
| `/eks/krombat/argocd` | Argo CD logs | 30 days |

### Find logs for a specific dungeon
```
# CloudWatch Logs Insights query
fields @timestamp, @message
| filter @message like /my-dungeon/
| sort @timestamp desc
| limit 50
```

### Trace an attack
```
fields @timestamp, @message
| filter @message like /attack/ and @message like /my-dungeon/
| sort @timestamp desc
| limit 20
```

### Check kro reconciliation errors
```
# Query the kro log group
fields @timestamp, @message
| filter @message like /error|Error|ERROR/
| sort @timestamp desc
| limit 30
```

### Check backend API errors
```
# Query rpg-system log group (JSON structured logs)
fields @timestamp, msg, status, error, dungeon
| filter component = 'api' and level = 'WARN'
| sort @timestamp desc
| limit 20
```

### View attack Job combat math
```
# Query game log group
fields @timestamp, @message
| filter @message like /Hero attacks/ or @message like /counter-attack/ or @message like /Turn:/
| sort @timestamp desc
| limit 30
```

### Dashboard
Access the CloudWatch dashboard at:
```bash
terraform -chdir=infra output cloudwatch_dashboard_url
```

### Alarms
- `krombat-backend-restarts` — fires when backend pod restarts > 3 times in 5 minutes


## Child RGDs (RGD Composition)

### Check child CR status
```bash
kubectl get monsters,bosses,heroes,treasures -n <dungeon-name>
```

### Check child CR details
```bash
kubectl get monster <dungeon>-monster-0 -n <dungeon> -o jsonpath='{.status.entityState}'
kubectl get boss <dungeon>-boss -n <dungeon> -o jsonpath='{.status.entityState}'
kubectl get hero <dungeon>-hero -n <dungeon> -o jsonpath='{.status.entityState}'
```

### Child RGD not reconciling
```bash
# Check all RGDs are Active
kubectl get rgd

# If a child RGD is Inactive, check its error
kubectl get rgd <name> -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'

# Delete and let Argo CD recreate (child RGDs have sync-wave: -1)
kubectl delete rgd <name>
```

### Dungeon status shows wrong values
The dungeon status is derived from child CR statuses. If it's wrong:
```bash
# Check the chain: Dungeon spec → child CR spec → child CR status → Dungeon status
kubectl get dungeon <name> -o jsonpath='{.spec.monsterHP}'
kubectl get monster <name>-monster-0 -n <name> -o jsonpath='{.spec.hp} {.status.entityState}'
kubectl get dungeon <name> -o jsonpath='{.status.livingMonsters}'
```


## Hero Abilities

### Debug Mage heal
```bash
kubectl get dungeon <name> -o jsonpath='HP:{.spec.heroHP} Mana:{.spec.heroMana}'
# Heal requires mana >= 2, HP < 80
```

### Debug Warrior taunt
```bash
kubectl get dungeon <name> -o jsonpath='Taunt:{.spec.tauntActive}'
# tauntActive=1 means 60% damage reduction active
```

### Debug Rogue backstab
```bash
kubectl get dungeon <name> -o jsonpath='CD:{.spec.backstabCooldown}'
# backstabCooldown > 0 means backstab unavailable
```

## Dungeon Modifiers

### Check active modifier
```bash
kubectl get dungeon <name> -o jsonpath='Modifier:{.spec.modifier} Effect:{.status.modifier}'
kubectl get modifier -n <dungeon-name>
```

### Modifier not showing in status
```bash
# Check modifier-graph RGD is Active
kubectl get rgd modifier-graph
# Check Modifier CR exists
kubectl get modifier <name>-modifier -n <name> -o yaml
```

## Loot System

### Check inventory
```bash
kubectl get dungeon <name> -o jsonpath='Inv:{.spec.inventory} Wpn:{.spec.weaponBonus}({.spec.weaponUses}) Armor:{.spec.armorBonus}'
```

### Use item via kubectl
```bash
# HP potion
kubectl apply -f - <<EOF
apiVersion: game.k8s.example/v1alpha1
kind: Attack
metadata:
  name: use-potion-$(date +%s)
spec:
  dungeonName: <name>
  dungeonNamespace: default
  target: use-hppotion-rare
  damage: 0
EOF
```

## Status Effects

### Check active effects
```bash
kubectl get dungeon <name> -o jsonpath='Poison:{.spec.poisonTurns} Burn:{.spec.burnTurns} Stun:{.spec.stunTurns}'
```

### Manually clear effects
```bash
kubectl patch dungeon <name> --type=merge -p '{"spec":{"poisonTurns":0,"burnTurns":0,"stunTurns":0}}'
```
