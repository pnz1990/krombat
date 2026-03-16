# Day 3 — Extend (3-4 hours)

**Goal:** Write your first kro RGD by adding a new modifier type to `modifier-graph.yaml` that gives the hero a +10% dodge chance.

This day requires forking the repo and deploying your change via ArgoCD.

---

## Learning outcomes

By the end of Day 3 you will be able to:

- Author a real production kro RGD with a new CEL expression
- Deploy a kro change via ArgoCD (GitOps)
- Run the Krombat test suite and verify all tests pass
- Explain how the reconcile loop picks up a schema change and reflects it in a running game

---

## Prerequisites

- A GitHub account with permission to fork `pnz1990/krombat`
- kubectl CLI installed locally
- Access to a Kubernetes cluster where you can install kro (or use the Krombat cluster if you have access)
- If you do not have cluster access: you can still complete the RGD authoring exercise and validate the CEL expressions using the CEL Playground at `https://learn-kro.eks.aws.dev` — skip the deploy steps

---

## The exercise

You will add a new modifier type called `blessing-agility` to `modifier-graph.yaml`.

**Effect:** The hero gains a +10% chance to dodge counter-attacks.

**What needs to change:**

1. `manifests/rgds/modifier-graph.yaml` — add `blessing-agility` to the `effect` CEL ternary chain
2. `backend/internal/handlers/handlers.go` — add the game logic: when `modifier == "blessing-agility"`, add 10 to the rogue/warrior dodge roll (the backend is the game engine — see AGENTS.md)
3. `frontend/src/App.tsx` — add `"blessing-agility"` to the modifier dropdown in the dungeon creation form
4. Verify the new modifier appears in the dungeon creation UI, the kro graph panel shows the correct `effect` string, and the modifier-graph node inspector shows the CEL value

**Acceptance criteria for your PR:**

- [ ] `modifier-graph.yaml` has a `blessing-agility` branch in the `effect` CEL expression
- [ ] The `effect` string reads: `"Blessing of Agility: 10% chance to dodge counter-attacks."`
- [ ] The modifier appears in the dungeon creation form dropdown
- [ ] The kro panel shows the modifier node with `state: blessing-agility`
- [ ] All 4 test suites pass: `tests/run.sh`, `tests/guardrails.sh`, `tests/backend-api.sh`, `tests/e2e/smoke-test.js`

---

## Step 1 — Fork and clone (15 min)

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-github-username>/krombat.git
cd krombat
git checkout -b workshop-day3-blessing-agility
```

---

## Step 2 — Edit modifier-graph.yaml (20 min)

Open `manifests/rgds/modifier-graph.yaml`. Find the `effect` CEL expression (line 37). Add a new branch before the final `'No modifier'` fallback:

```yaml
effect: >-
  "${
    schema.spec.modifierType == 'curse-fortitude' ? 'Curse of Fortitude: All monsters have 50% more HP, making them harder to kill.' :
    schema.spec.modifierType == 'curse-fury' ? 'Curse of Fury: The boss deals double damage on counter-attacks. Be careful!' :
    schema.spec.modifierType == 'curse-darkness' ? 'Curse of Darkness: Your attacks deal 25% less damage to all enemies.' :
    schema.spec.modifierType == 'blessing-strength' ? 'Blessing of Strength: Your attacks deal 50% more damage to all enemies!' :
    schema.spec.modifierType == 'blessing-resilience' ? 'Blessing of Resilience: All counter-attack damage against you is halved.' :
    schema.spec.modifierType == 'blessing-fortune' ? 'Blessing of Fortune: 20% chance to land a critical hit for double damage!' :
    schema.spec.modifierType == 'blessing-agility' ? 'Blessing of Agility: 10% chance to dodge counter-attacks.' :
    'No modifier'
  }"
```

**Verify the CEL expression in the Playground:** Open the CEL Playground at `https://learn-kro.eks.aws.dev` and paste:

```
schema.spec.modifierType == 'blessing-agility' ? 'Blessing of Agility: 10% chance to dodge counter-attacks.' : 'No modifier'
```

The output should be `"No modifier"` (because your current dungeon does not use `blessing-agility`). That is correct — the expression is valid.

---

## Step 3 — Add the game logic in handlers.go (30 min)

Open `backend/internal/handlers/handlers.go`. Find the section that applies modifier effects to combat (search for `"blessing-fortune"` or `"blessing-resilience"`).

Add the dodge logic for `blessing-agility`. When the modifier is `blessing-agility`, add 10 to the hero's dodge roll in the counter-attack resolution block. The backend is the game engine: all combat math lives here.

> **Tip:** Study how `blessing-resilience` halves incoming counter-attack damage to understand the pattern. Your `blessing-agility` dodge logic should roll a random number and skip the counter-attack damage if the roll beats 90 (10% chance).

---

## Step 4 — Add to the frontend dropdown (15 min)

Open `frontend/src/App.tsx`. Find the modifier dropdown in the dungeon creation form (search for `"blessing-fortune"`). Add `blessing-agility` as a new option:

```tsx
<option value="blessing-agility">Blessing of Agility (+10% dodge)</option>
```

---

## Step 5 — Deploy via ArgoCD (30 min)

If you have write access to the Krombat cluster:

```bash
# Commit your changes
git add manifests/rgds/modifier-graph.yaml backend/internal/handlers/handlers.go frontend/src/App.tsx
git commit -m "feat: add blessing-agility modifier (#workshop-day3)"

# Push to your fork
git push origin workshop-day3-blessing-agility

# Open a PR to your fork's main branch (not the upstream)
# ArgoCD will sync when you merge to your main branch

# After merge, delete the old RGD to force schema regeneration:
kubectl --context <your-context> delete rgd modifier-graph
# ArgoCD recreates it from the new YAML within ~6 seconds
```

If you are deploying to your own cluster (not Krombat):

```bash
# Install kro first: https://kro.run/docs/getting-started/installation
# Then apply the RGD:
kubectl apply -f manifests/rgds/modifier-graph.yaml

# Verify kro picked it up:
kubectl get rgd modifier-graph -o yaml | grep -A5 "status:"
```

---

## Step 6 — Verify in the game (20 min)

1. Open `https://learn-kro.eks.aws.dev` (or your own deployment)
2. Click **New Dungeon**
3. Confirm `Blessing of Agility` appears in the modifier dropdown
4. Create a dungeon with `blessing-agility`
5. Open the kro panel — the Modifier node should show `state: blessing-agility`
6. Click the Modifier node — the inspector should show `effect: Blessing of Agility: 10% chance to dodge counter-attacks.`
7. Fight the boss — you should occasionally see "Dodge!" in the combat log when the counter-attack is negated

---

## Step 7 — Run the test suite (20 min)

```bash
# From the repo root:
./tests/guardrails.sh
./tests/backend-api.sh
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/smoke-test.js
```

All tests must pass before your PR can be considered complete.

---

## Day 3 exercises

Complete the guided steps in [exercises/day-3-exercises.md](exercises/day-3-exercises.md).

The reference solution is in [solutions/day-3-solution.yaml](solutions/day-3-solution.yaml). Only look at it after completing your own attempt.

---

## Day 3 summary

You have now:
- Written a real kro RGD CEL expression from scratch
- Deployed it via ArgoCD (GitOps)
- Verified the reconcile loop picked up the schema change and reflected it in the live game
- Run the full test suite and confirmed all tests pass

**You have completed the kro workshop.** You now have the foundation to author your own kro RGDs for real production use cases.

---

## Next steps

- Read the [kro documentation](https://kro.run/docs) for the full feature set
- Browse the other 8 RGDs in `manifests/rgds/` — each one demonstrates a different kro pattern
- Join the [kro community](https://github.com/kubernetes-sigs/kro/discussions) and share what you built
- Use the blog post generator (victory screen → **Tell the story of this run**) to share your Day 3 result
