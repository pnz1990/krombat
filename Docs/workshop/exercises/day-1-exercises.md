# Day 1 Exercises

Answer these 5 questions using the live game at `https://learn-kro.eks.aws.dev`. No code reading required — all answers can be found by inspecting the game UI.

---

## Q1 — Resource count

Create a dungeon with 3 monsters. Open the kro panel and count all nodes in the resource graph (including state nodes).

**How many resources did kro create from your single Dungeon CR?**

*Hint: The root Dungeon CR is not counted — count only the resources kro created from it.*

---

## Q2 — monster-graph entityState

Kill one of your three monsters. Open the kro panel and click the dead monster's node in the graph.

**Which field changes in the monster's ConfigMap when the monster dies? What does it change from and to? Which RGD is responsible?**

---

## Q3 — combatResolve state node

After attacking, open the K8s log tab and find the most recent attack entry. Expand the **[kro]** annotation block.

**List 3 fields that the `combatResolve` state node writes to `status.game` on the Dungeon CR after a combat turn.**

---

## Q4 — readyWhen vs includeWhen

Open the Reconcile Stream tab and watch it during an attack. Then open the kro concept glossary (kro panel footer) and look up both `readyWhen` and `includeWhen`.

**In your own words: what is the difference between `readyWhen` and `includeWhen` in kro?**

---

## Q5 — CEL Playground: boss phase

Open the CEL Playground and evaluate this expression (replace `400` with your boss's actual max HP if it differs):

```
schema.status.game.bossHP * 100 / 400 > 50 ? "phase1" : schema.status.game.bossHP * 100 / 400 > 25 ? "phase2" : "phase3"
```

**What phase is the boss in right now? At what HP threshold does it transition to phase2?**
