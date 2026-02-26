# Kubernetes RPG — Project Context

## What This Is
A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

## Architecture
- **EKS Auto Mode** cluster (K8s 1.34) in us-west-2
- **kro** (EKS Managed Capability) — two RGDs orchestrate the game:
  - `dungeon-graph`: Dungeon CR → Namespace, Monster Pods, Boss Pod, Treasure Secret, ResourceQuota, NetworkPolicy
  - `attack-graph`: Attack CR → Job that patches Dungeon CR's monsterHP/bossHP
- **Argo CD** (EKS Managed Capability) — GitOps deployment from `manifests/` directory. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket gateway in `rpg-system` namespace. Rate limiting (1 attack/s/dungeon), Prometheus metrics on `/metrics`. Image in ECR (`krombat/backend`)
- **React Frontend** — TODO (issue #3)

## Game Flow
1. Create Dungeon CR with `monsters`, `difficulty`, `monsterHP: []int`, `bossHP: int`
2. kro creates namespace + pods with labels derived from HP values via CEL
3. Create Attack CR → kro spawns Job → Job patches Dungeon CR HP fields
4. kro reconciles: HP=0 → state=dead, all dead → boss=ready, bossHP=0 → victory=true

## Key Design Decisions
- **HP state lives on Dungeon CR spec** (not pod annotations) — kro owns pods and would revert external mutations
- **Attack Jobs patch the Dungeon CR**, not pods directly — kro derives all pod state from the CR
- **Backend is dumb** — only creates Dungeon/Attack CRs, all logic is in kro CEL expressions
- **No ingress/LB** — access via `kubectl port-forward` only

## Tech Stack
- Go 1.25 (backend), client-go, gorilla/websocket, prometheus/client_golang
- Terraform (EKS, VPC, capabilities, ECR, CI IAM)
- GitHub Actions CI with OIDC → AWS federation
- kro 0.8.4, Argo CD (managed), EKS Auto Mode

## Testing
- `tests/run.sh` — 27 game engine tests (dungeon lifecycle, attacks, drift correction)
- `tests/backend-api.sh` — 14 backend API tests (CRUD, validation, rate limiting, metrics)
- CI runs both on every push to main

## Important Paths
- `manifests/` — Everything Argo CD syncs (RGDs, RBAC, deployments, apps)
- `backend/` — Go service source
- `infra/` — Terraform (main.tf, ci.tf, ecr.tf)
- `tests/` — Integration test scripts
- `docs/` — Design docs and runbook

## Cluster Details
- Cluster: `krombat` in us-west-2
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/backend`
- GitHub repo: `pnz1990/krombat`

## Remaining Work
- Issue #3: React frontend SPA
