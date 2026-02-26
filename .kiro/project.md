# Kubernetes RPG — Project Context

## What This Is
A turn-based dungeon RPG where the entire game state lives in Kubernetes, orchestrated by kro ResourceGraphDefinitions on Amazon EKS. Demonstrates Kubernetes as a general-purpose state machine.

## Architecture
- **EKS Auto Mode** cluster (K8s 1.34) in us-west-2
- **kro** (EKS Managed Capability) — two RGDs orchestrate the game:
  - `dungeon-graph`: Dungeon CR → Namespace, Monster Pods, Boss Pod, Treasure Secret, ResourceQuota, NetworkPolicy. Status exposes livingMonsters, bossState, victory, loot — all computed via CEL
  - `attack-graph`: Attack CR → Job that patches Dungeon CR's monsterHP/bossHP
- **Argo CD** (EKS Managed Capability) — GitOps deployment from `manifests/` directory. GitHub webhook for ~6s sync
- **Go Backend** — REST API + WebSocket gateway in `rpg-system` namespace. ONLY interacts with Dungeon and Attack CRs (game.k8s.example). Never reads Pods, Secrets, Jobs, or any native K8s objects. Rate limiting (1 attack/s/dungeon), Prometheus metrics on `/metrics`. Image in ECR
- **React Frontend** — 8-bit D&D-inspired SPA with pixel art styling (Press Start 2P font). Nginx reverse-proxies `/api/` to backend. Derives all state from Dungeon CR (spec.monsterHP, status.bossState, status.loot). Image in ECR

## Game Flow
1. Create Dungeon CR with `monsters`, `difficulty`, `monsterHP: []int`, `bossHP: int`
2. kro creates namespace + pods with labels derived from HP values via CEL
3. Create Attack CR → kro spawns Job → Job patches Dungeon CR HP fields
4. kro reconciles: HP=0 → state=dead, all dead → boss=ready, bossHP=0 → victory=true
5. Victory → treasure loot from `status.loot` (CEL-computed)

## Key Design Decisions
- **CRs as the only interface** — backend and frontend ONLY touch Dungeon and Attack CRs. kro is the abstraction layer for all native K8s objects
- **HP state lives on Dungeon CR spec** (not pod annotations) — kro owns pods and would revert external mutations
- **Attack Jobs patch the Dungeon CR**, not pods directly — kro derives all pod state from the CR via CEL
- **Backend is dumb** — only creates Dungeon/Attack CRs, all logic is in kro CEL expressions
- **No ingress/LB** — access via `kubectl port-forward` only

## Development Rules
- **NEVER run applications locally** — all builds and testing happen through Docker containers
- **NEVER use `go run`, `npm start`, `npm run dev`, or similar local dev servers**
- **All images are built via Docker** and pushed to ECR through GitHub Actions CI
- **Deployments happen via Argo CD** — push manifests to Git, Argo CD syncs to cluster
- **To test changes**: push to Git → CI builds image → `kubectl rollout restart deployment/<name> -n rpg-system`
- **Local validation only**: `go build` to check compilation, `python3 -c "import yaml; ..."` to validate YAML

## Tech Stack
- Go 1.25 (backend), client-go dynamic client only, gorilla/websocket, prometheus/client_golang
- React 19 + TypeScript + Vite (frontend), nginx for serving + API proxy
- Terraform (EKS, VPC, capabilities, ECR, CI IAM)
- GitHub Actions CI with OIDC → AWS federation
- kro 0.8.4, Argo CD (managed), EKS Auto Mode

## Testing
- `tests/run.sh` — 27 game engine tests (dungeon lifecycle, attacks, drift correction)
- `tests/backend-api.sh` — 14 backend API tests (CRUD, validation, rate limiting, metrics)
- CI runs both on every push to main

## Important Paths
- `manifests/` — Everything Argo CD syncs (RGDs, RBAC, deployments, apps)
- `backend/` — Go service source + Dockerfile
- `frontend/` — React SPA source + Dockerfile + nginx.conf
- `infra/` — Terraform (main.tf, ci.tf, ecr.tf)
- `tests/` — Integration test scripts
- `scripts/` — Utility scripts (watch-dungeon.sh tmux dashboard)
- `docs/` — Design docs and runbook

## Cluster Details
- Cluster: `krombat` in us-west-2
- ECR: `569190534191.dkr.ecr.us-west-2.amazonaws.com/krombat/{backend,frontend}`
- GitHub repo: `pnz1990/krombat`
- All 14 issues closed ✅
