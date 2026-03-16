# Day 3 Exercises — Guided RGD Authoring

Complete these steps in order. The goal is to add a `blessing-agility` modifier to `modifier-graph.yaml` that gives the hero a +10% dodge chance.

Do not look at the solution in `solutions/day-3-solution.yaml` until you have completed your own attempt.

---

## Part A — Design the CEL expression (30 min)

Before writing any code, design the CEL expression you will add to modifier-graph.yaml.

**Exercise A1:** Write the new CEL branch that should be inserted into the `effect` ternary chain. The effect string must read exactly:

```
Blessing of Agility: 10% chance to dodge counter-attacks.
```

*Hint: look at the existing `blessing-fortune` branch for the pattern.*

**Exercise A2:** In the CEL Playground at `https://learn-kro.eks.aws.dev`, evaluate this expression to verify your syntax is correct:

```
"blessing-agility" == "blessing-agility" ? "Blessing of Agility: 10% chance to dodge counter-attacks." : "No modifier"
```

Expected output: `"Blessing of Agility: 10% chance to dodge counter-attacks."`

**Exercise A3:** Where exactly in the ternary chain should `blessing-agility` appear? Does the order matter? Why or why not?

---

## Part B — Edit the RGD (20 min)

Edit `manifests/rgds/modifier-graph.yaml` and add the `blessing-agility` branch to the `effect` field.

**Checkpoint:** After editing, the `effect` field should have 7 named modifier branches (6 existing + your new one) plus the `'No modifier'` fallback.

**Exercise B1:** Count the lines in the `effect` expression before and after your change. How many lines did you add?

**Exercise B2:** The `multiplier` field in the modifier-graph schema is a `string` with `default="1.0"`. For `blessing-agility`, the game logic uses a percentage roll (not a multiplier on damage). Should you update the `multiplier` field in the RGD for `blessing-agility`? Why or why not?

---

## Part C — Understand the kro/backend split (20 min)

**Exercise C1:** The `effect` field in modifier-graph is a human-readable description string stored in a ConfigMap. The actual dodge roll happens in `backend/internal/handlers/handlers.go`. Why is the game logic in Go and not in CEL?

*Hint: read the constraint in AGENTS.md: "Game features and game engine MUST be kro/CEL always." Then re-read the architecture section. Is the dodge roll a game feature or game engine?*

**Exercise C2:** Is there anything in modifier-graph.yaml that the Go backend reads to decide how much dodge chance to apply? Or does the backend determine the dodge chance independently?

---

## Part D — Deploy and verify (30 min)

Follow the deploy instructions in [day-3-extend.md](../day-3-extend.md), Step 5 and Step 6.

**Exercise D1:** After deploying, create a dungeon with `blessing-agility`. Open the kro panel and click the Modifier node. Paste a screenshot or describe the `effect` value shown in the node inspector.

**Exercise D2:** Fight until a counter-attack is negated by the dodge. Describe what appears in the combat log when the dodge fires.

---

## Part E — Test and submit (20 min)

Run the full test suite:

```bash
./tests/guardrails.sh
./tests/backend-api.sh
BASE_URL=https://learn-kro.eks.aws.dev node tests/e2e/smoke-test.js
```

**Exercise E1:** Do all tests pass? If any test fails, what does the failure say and how would you fix it?

**Exercise E2:** If you were to add a new guardrail test for `blessing-agility`, what would it check? Write the one-line `grep` check.

---

## Reference solution

The reference solution for the modifier-graph.yaml change is in [solutions/day-3-solution.yaml](../solutions/day-3-solution.yaml).
