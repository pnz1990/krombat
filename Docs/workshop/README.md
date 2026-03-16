# kro Workshop — Learn Kubernetes Resource Orchestration by Playing a Dungeon RPG

This is a self-paced 3-day workshop that teaches [kro (Kubernetes Resource Orchestrator)](https://github.com/kubernetes-sigs/kro) using Krombat as a live teaching environment.

Krombat is a turn-based dungeon RPG where all game state lives in Kubernetes Custom Resources on a real EKS cluster. Nine production-grade kro ResourceGraphDefinitions orchestrate the entire resource graph. You will play the game, read the RGDs, and extend one.

No local cluster required for Day 1 or Day 2. Day 3 requires forking the repo and deploying via ArgoCD.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| A modern browser | Chrome or Firefox recommended |
| A GitHub account | Required to log in and save your profile |
| kubectl CLI | Required for Day 3 only |
| Basic Kubernetes familiarity | You know what a Pod, ConfigMap, and CRD are |
| ~8 hours total | Day 1: 2-3h, Day 2: 2-3h, Day 3: 3-4h |

---

## What you will learn

By the end of this workshop you will be able to:

- Explain what a ResourceGraphDefinition (RGD) is and why it exists
- Read real production kro RGDs and understand every CEL expression
- Use `readyWhen`, `includeWhen`, `forEach`, and `specPatch` in practice
- Write your first kro RGD from scratch and deploy it via ArgoCD
- Describe the kro reconcile loop and how CEL expressions drive derived state

---

## The teaching environment

All exercises use the live Krombat deployment at `https://learn-kro.eks.aws.dev`. You do not need to run anything locally for Day 1 and Day 2.

The game exposes everything you need inside the browser:

- **kro panel** — the live resource graph for your dungeon, updated in real time as you play
- **Reconcile Stream tab** — raw kro watch events showing every field change and the CEL expression that drove it
- **K8s log tab** — annotated kubectl commands with kro commentary for each event
- **CEL Playground** — an in-browser REPL where you can evaluate CEL expressions from the RGDs
- **Concept glossary** — 27 kro concepts that unlock as you play

---

## Schedule

| Day | Title | Duration | Goal |
|---|---|---|---|
| 1 | [Explore](day-1-explore.md) | 2-3 hours | Understand what kro is doing by playing the game |
| 2 | [Read the RGDs](day-2-read-the-rgds.md) | 2-3 hours | Read all 9 RGDs and understand every CEL expression |
| 3 | [Extend](day-3-extend.md) | 3-4 hours | Write your first kro RGD by adding a new modifier type |

---

## Exercises and solutions

| File | Purpose |
|---|---|
| [exercises/day-1-exercises.md](exercises/day-1-exercises.md) | 5 questions answered by inspecting the live resource graph |
| [exercises/day-2-exercises.md](exercises/day-2-exercises.md) | 5 CEL expression exercises using the in-browser CEL Playground |
| [exercises/day-3-exercises.md](exercises/day-3-exercises.md) | Guided RGD authoring exercise with scaffolded steps |
| [solutions/day-3-solution.yaml](solutions/day-3-solution.yaml) | Reference solution for the Day 3 RGD exercise |

---

## Help and feedback

- Use the **?** button inside the game for in-game help on any mechanic
- Open the kro concept glossary (kro panel footer) to look up any term
- Post questions or share your run blog post in [GitHub Discussions](https://github.com/kubernetes-sigs/kro/discussions)
- File issues against this repo for workshop content bugs
