# Day 2 Exercises

Answer these 5 questions by reading the RGD YAML files in `manifests/rgds/` and using the CEL Playground at `https://learn-kro.eks.aws.dev`.

---

## Q1 — modifier-graph readyWhen

Read `manifests/rgds/modifier-graph.yaml`.

**What condition does `readyWhen` check? What happens to the Modifier CR status if this condition is not yet true?**

---

## Q2 — CEL ternary chain in modifier-graph

Open the CEL Playground. Evaluate the following expression (it is the exact expression from modifier-graph.yaml, simplified):

```
"blessing-fortune" == "curse-fortitude" ? "Curse of Fortitude: All monsters have 50% more HP, making them harder to kill." :
"blessing-fortune" == "curse-fury" ? "Curse of Fury: The boss deals double damage on counter-attacks. Be careful!" :
"blessing-fortune" == "curse-darkness" ? "Curse of Darkness: Your attacks deal 25% less damage to all enemies." :
"blessing-fortune" == "blessing-strength" ? "Blessing of Strength: Your attacks deal 50% more damage to all enemies!" :
"blessing-fortune" == "blessing-resilience" ? "Blessing of Resilience: All counter-attack damage against you is halved." :
"blessing-fortune" == "blessing-fortune" ? "Blessing of Fortune: 20% chance to land a critical hit for double damage!" :
"No modifier"
```

**What does this expression return? Why is the CEL ternary chain evaluated left-to-right?**

---

## Q3 — boss-graph includeWhen

Read `manifests/rgds/boss-graph.yaml`. Find the `lootCR` resource.

**What `includeWhen` condition controls when the Loot CR is created? What happens to the Loot CR if the boss is alive (hp > 0)?**

---

## Q4 — dungeon-graph forEach

Read the `monsterCRs` resource in `manifests/rgds/dungeon-graph.yaml`.

**`status.game.monsterHP` is set by the `dungeonInit` state node. If it contains `[50, 50, 50]`, how many Monster CRs does kro create? What is the name of the second one (index 1)?**

---

## Q5 — state node concept

Read the `combatResolve` state node in `manifests/rgds/dungeon-graph.yaml`.

**In plain English: what is a state node (`type: stateNode`) in kro's fork, and why is it used here instead of a ConfigMap? Where does it write its results?**
