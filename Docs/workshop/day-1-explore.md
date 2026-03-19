# Day 1 — Explore (2-3 hours)

**Goal:** Understand what kro is and what it does by playing Krombat and observing the resource graph.

No local cluster required. Everything runs in your browser at `https://learn-kro.eks.aws.dev`.

---

## Learning outcomes

By the end of Day 1 you will be able to:

- Describe what a ResourceGraphDefinition (RGD) is and why it exists
- Identify every node in the Krombat resource graph and what it represents
- Find kro reconcile events in the K8s log tab and explain what CEL expression fired
- Explain what `spec.schema`, `forEach`, `readyWhen`, and `status-aggregation` mean in plain English

---

## Step 1 — Log in and create your first dungeon (30 min)

1. Open `https://learn-kro.eks.aws.dev` in your browser
2. Sign in with your GitHub account
3. Click **New Dungeon** and create a dungeon with these settings:
   - Hero class: **Warrior**
   - Difficulty: **Normal**
   - Leave the dungeon name as the auto-generated name
4. The game starts. Look at the top of the screen — this is your dungeon name, which is also the name of the Dungeon Custom Resource on the live EKS cluster.

**Checkpoint:** You just ran `kubectl apply -f dungeon.yaml` against a real Kubernetes cluster. The intro tour explains what happened. Read through all 9 slides before continuing.

---

## Step 2 — Open the kro panel (20 min)

1. Inside your dungeon, click the **kro** tab in the event log panel at the bottom of the screen
2. You will see the resource graph for your dungeon rendered as a directed graph
3. Identify and label each node:

| Node color | Node type | What kro did |
|---|---|---|
| Blue (root) | Dungeon CR | You applied this — kro watches it |
| Purple | Namespace | kro created this |
| Green | Hero CR | kro created this from `heroCR` resource in dungeon-graph |
| Green | Monster CR × N | kro created one per monster via `forEach` |
| Green | Boss CR | kro created this from `bossCR` resource |
| Green | Treasure CR | kro created this |
| Green | Modifier CR | kro created this |
| Yellow | GameConfig CM | kro created this ConfigMap with dice formula and HP tables |
| Orange | State nodes | kro writes CEL-computed values to Dungeon CR `status.game` |

**Question to answer:** How many resources did kro create from your single Dungeon CR? *(See [exercises/day-1-exercises.md](exercises/day-1-exercises.md), Q1)*

---

## Step 3 — Watch kro reconcile during combat (30 min)

1. Click the **Reconcile Stream** tab in the event log panel
2. Attack a monster by clicking on it
3. Watch the stream — you will see entries like:

```
[14:22:01] configmap/my-dungeon-monster-0  MODIFIED  rv:1847
  data.entityState: alive → dead
    RGD: monster-graph
    CEL: schema.spec.hp > 0 ? "alive" : "dead"
```

4. Click **Why?** on any field to expand the CEL expression, which RGD it lives in, and the concept card
5. Kill all 3 monsters, then kill the boss

**Question to answer:** Which RGD is responsible for the `entityState` field on a monster ConfigMap? *(Q2)*

---

## Step 4 — Read the K8s log tab (20 min)

1. Click the **K8s log** tab in the event log panel
2. Each entry shows a simulated `kubectl` command with a **[kro]** annotation block
3. Find an entry for an attack action and expand the kro annotation
4. The annotation shows which RGD reconciled, which CEL expression fired, and links to the concept

**Question to answer:** What does the `combatResolve` state node write to the Dungeon CR? *(Q3)*

---

## Step 5 — Unlock kro concepts (30 min)

1. Click the **kro** tab and look at the concept glossary at the bottom
2. Continue playing — defeat the boss in Room 1, open the treasure, enter Room 2, defeat the Room 2 boss
3. As you play, new concepts unlock. Aim to unlock at least 15 concepts by the end of the run
4. After winning, click **Tell the story of this run** to generate a Markdown blog post narrating the key kro events in your dungeon

**Question to answer:** What is the difference between `readyWhen` and `includeWhen` in kro? *(Q4)*

---

## Step 6 — Use the CEL Playground (20 min)

1. Click the **CEL** button in the kro panel header (or open it from the concept glossary)
2. The playground shows a live CEL REPL connected to the current dungeon state
3. Try evaluating these expressions:

```
schema.status.game.heroHP > 0 ? "alive" : "dead"
```

```
schema.spec.difficulty == "hard" ? 3 : schema.spec.difficulty == "normal" ? 2 : 1
```

4. Modify the expression to return the number of monsters with HP > 0

**Question to answer:** What CEL function does the boss-graph use to determine `bossPhase`? *(Q5)*

---

## Day 1 exercises

Complete the five questions in [exercises/day-1-exercises.md](exercises/day-1-exercises.md). All answers can be found by inspecting the live game UI — no code reading required.

---

## Day 1 summary

You have now:
- Applied a real Kubernetes CR and watched kro orchestrate 16 resources from it
- Observed kro reconciling the resource graph in real time during combat
- Identified `forEach`, `readyWhen`, `specPatch`, and `status-aggregation` patterns in the wild
- Unlocked at least 15 of 27 kro concepts

Proceed to [Day 2 — Read the RGDs](day-2-read-the-rgds.md).
