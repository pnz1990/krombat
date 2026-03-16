# Speaker Notes — Common Audience Questions

Use this as a Q&A cheat sheet after the 5-minute demo. Each entry has a short answer (for a quick follow-up) and a long answer (for a breakout / hallway conversation).

---

## Q1: Is this a real Kubernetes cluster or a simulation?

**Short:** It's a real EKS cluster in `us-west-2`. Every attack creates a real Kubernetes CR.

**Long:** The cluster is Amazon EKS Auto Mode running Kubernetes 1.34. kro is installed via Helm. Every dungeon is a real Custom Resource in the `default` namespace. Argo CD syncs the RGDs from the GitHub repo. The attack sequence uses the Kubernetes API — `client.Resource(dungeonGVR).Namespace(ns).Create(ctx, attackCR, ...)` — to create a real Attack CR which kro then reconciles.

---

## Q2: What is kro exactly?

**Short:** kro is a Kubernetes controller that lets you declare a graph of resources — and CEL expressions to compute their values — in a single YAML file called a ResourceGraphDefinition.

**Long:** kro watches for instances of your RGD (which it registers as a CRD automatically) and creates all the child resources defined in the graph. It evaluates CEL expressions to compute field values, handle conditional inclusion, manage readiness gates, and (in this fork) write computed values back into the parent spec via `specPatch`. The upstream project is at `github.com/kubernetes-sigs/kro`.

---

## Q3: Why Kubernetes for a game? Isn't this overkill?

**Short:** Yes — that's the point. If kro can run a real-time game engine, it can definitely run your platform's provisioning workflows.

**Long:** Krombat is a teaching tool, not a production game. The point is to make kro's reconcile loop *viscerally tangible*. When you attack a monster and see the HP drop in the K8s log tab, you've just watched a Kubernetes reconcile loop complete a state transition in real time. That mental model — spec → reconcile → new spec — is exactly what you need to understand kro for real use cases like provisioning multi-tenant environments, managing feature flag rollouts, or orchestrating complex service graphs.

---

## Q4: What is CEL and why does kro use it?

**Short:** CEL (Common Expression Language) is a Google-designed expression language used in Kubernetes admission webhooks, Envoy, and now kro. It's safe, deterministic, and sandboxed — ideal for declaring computed values in a controller.

**Long:** CEL was designed for policy evaluation in security-critical contexts. It has no side effects, no I/O, no loops (only comprehensions over finite collections). kro uses CEL to express "given this spec, what should the child resource look like?" — for example `bossHP <= maxBossHP * 0.5 ? "phase2" : "phase1"`. Because CEL is declarative and deterministic, kro can re-evaluate it on every reconcile without risk. The Kubernetes API machinery uses CEL in ValidatingAdmissionPolicy — kro extends that pattern to resource graph orchestration.

---

## Q5: How does the game engine work without backend logic?

**Short:** The Go backend computes combat math (dice rolls, damage) and patches the Dungeon CR spec. kro picks up the patch, runs CEL specPatch nodes, and writes derived state (boss phase, entity states, loot) back into spec.

**Long:** The architecture has a clear split: the Go backend is the game engine (dice, damage calculation, HP mutations, loot drops, room transitions). It patches `spec.heroHP`, `spec.bossHP`, etc. via the Kubernetes API. kro then reconciles: it evaluates CEL specPatch nodes (`combatResolve`, `actionResolve`) that compute derived state — `bossPhase`, `entityState` for each monster, `treasureState` — and writes those back into spec. The frontend reads only from `spec` (not `status`) because status can be stale after room transitions. This is a real kro limitation you'd encounter in production too, and the game surfaces it explicitly in the InsightCards.

---

## Q6: What is a specPatch node?

**Short:** A specPatch is a kro RGD resource that writes CEL-computed values back into the parent CR's spec, rather than creating a new child resource.

**Long:** Normally, kro resources create or update child Kubernetes objects (Namespaces, ConfigMaps, CRDs, etc.). A specPatch resource instead patches fields back onto the parent CR's spec. This lets kro act as a pure CEL state machine: you write `spec.attackSeq`, kro evaluates `combatResolve.specPatch` which computes `heroHP_after = heroHP - damage`, and writes `spec.heroHP = heroHP_after`. The game uses 9 specPatch nodes in dungeon-graph. This feature is a krombat-patched fork extension; the upstream kro community discussion is ongoing.

---

## Q7: How do you handle concurrent players?

**Short:** Each player gets their own Dungeon CR in their own Namespace. Complete isolation — no shared state.

**Long:** When a player creates a dungeon, the backend creates a Dungeon CR in the `default` namespace (namespaced by dungeon name). kro creates a child Namespace per dungeon, and all child resources (Hero, Monsters, Boss, Treasure) live in that child Namespace. There is no shared game state between players. The cluster currently handles ~50 concurrent players before the kro controller becomes a bottleneck — at that point, horizontal scaling of the kro controller pod would be the next step.

---

## Q8: What happens to my dungeon after I close the browser?

**Short:** It stays in the cluster for 4 hours, then the Dungeon Reaper CronJob deletes it.

**Long:** A CronJob runs every 10 minutes and deletes Dungeon CRs older than 4 hours. This keeps the cluster clean without requiring any user action. The reaper is a simple Kubernetes Job that lists Dungeon CRs and deletes those past the TTL — no custom controller needed. Dungeons are also deleted immediately when you click the delete button in the UI.

---

## Q9: Is kro production-ready?

**Short:** kro is in active development and not yet v1.0. It's safe to experiment with in non-critical workloads. Several companies are running it in staging environments today.

**Long:** kro is a CNCF sandbox project (as of 2025). The API is stabilizing but not yet guaranteed stable across minor versions. The specPatch extension used by krombat is a fork-specific feature, not yet in upstream. For production use, evaluate kro for low-blast-radius use cases first: provisioning ephemeral environments, managing dev cluster resources, or building internal developer platforms where a reconcile failure is recoverable. The upstream roadmap is at `github.com/kubernetes-sigs/kro/issues`.

---

## Q10: How do I run this myself / contribute?

**Short:** The repo is `github.com/pnz1990/krombat` — open an issue or send a PR. The live cluster at `learn-kro.eks.aws.dev` is always running.

**Long:** The full infrastructure is Terraform (EKS, ECR, Argo CD). The backend is Go, the frontend is React. CI builds Docker images and pushes to ECR on every merge to main — Argo CD then syncs within ~6 seconds. To contribute a new kro teaching concept, add a slide to `KRO_CONCEPTS` in `KroTeach.tsx` and a matching `InsightCard` trigger in `handlers.go`. If you want to propose a new kro CEL function for upstream, see the `AGENTS.md` section on upstream kro contribution workflow.

---

*Notes version: 2026-03 | Issue #458 | Repo: pnz1990/krombat*
