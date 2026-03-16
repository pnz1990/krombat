# Krombat — 5-Minute Conference Demo Script

**Target audience:** Kubernetes / platform engineering practitioners at a meetup, KubeCon booth, or conference lightning talk.

**Setup:** Browser open to `https://learn-kro.eks.aws.dev`. No local tooling required.

**Timing:** Each beat is 60 seconds max. Total: ~5 minutes.

---

## Pre-demo checklist (do this 5 min before going on stage)

1. Open `https://learn-kro.eks.aws.dev` in a browser tab and sign in (Google OAuth).
2. Delete any leftover dungeons from prior runs so the UI is clean.
3. Have the kubectl Terminal open (☰ → kubectl Terminal) inside a dungeon so the audience can see it immediately.
4. Increase browser font size to 125–150% for projector visibility.
5. Confirm the cluster is responding: create a test dungeon named `demo-test`, see it load, then delete it.

---

## Minute 1 — The pitch

**[Show: dungeon creation screen at `https://learn-kro.eks.aws.dev`]**

> "This is a turn-based dungeon RPG. But unlike any game you've played, its entire state lives in a single Kubernetes Custom Resource — on a real EKS cluster running in your browser right now."

> "No database. No Redis. No game server. The game engine is kro — the Kubernetes Resource Orchestrator — running CEL expressions on a Kubernetes CR."

Open the game at `https://learn-kro.eks.aws.dev`. Click **New Dungeon**, fill in the name `demo-dungeon-kubecon-2026`, select Warrior + Normal, click **Create Dungeon**. The dungeon loads.

> "I just applied a real CR to a live EKS cluster. kro is now watching it."

Open ☰ → kubectl Terminal. Type:

```
kubectl get dungeon demo-dungeon-kubecon-2026 -o yaml
```

> "Here is the full Dungeon CR that kro is reconciling right now."

> "kro created 16 resources from that one CR: a Namespace, a Hero CR, Monster CRs, a Boss CR, a Treasure CR, 9 specPatch nodes. All from a single RGD — a ResourceGraphDefinition."

---

## Minute 2 — The CR

**[Show: kubectl Terminal]**

Type:

```
kubectl get dungeon demo-dungeon-kubecon-2026
```

> "Here is the dungeon CR. Look at `spec.heroHP`, `spec.monsterHP`, `spec.bossHP`. This is not a database row. This is Kubernetes spec. kro owns it."

Type:

```
kubectl describe dungeon demo-dungeon-kubecon-2026
```

> "Every field you see here is either written by the player's action, or computed by a CEL expression inside a kro specPatch node. The backend writes `attackSeq`. kro reacts, runs CEL, and writes the result back into `spec`."

**[Point to the `[kro] What just happened?` annotation below the output]**

> "This annotation tells you exactly which RGD node fired and which CEL expression ran. That's the kro teaching layer built into this game."

---

## Minute 3 — The reconcile

**[Switch to: dungeon arena. Click Attack on a monster]**

> "I just attacked. Watch the K8s Logs tab."

**[Open: event log → K8s Logs tab]**

> "You can see the Attack CR being created, kro reconciling, and the damage written back to `spec.monsterHP`. The monster's HP dropped. All of that happened via a Kubernetes reconcile — no custom controller, no game server socket."

> "The CEL expression that computed the damage is right here in the log annotation: `monsterHP[i] = monsterHP[i] - heroDamage`. That runs inside kro's combatResolve specPatch node."

---

## Minute 4 — The resource graph

**[Open: kro panel (graph icon in event log)]**

> "This is the live resource graph — the same graph kro maintains in memory. Every node here is a resource kro created from the dungeon-graph RGD."

**[Click a node — e.g., combatResolve]**

> "Click a node to see the CEL expression that defines it. This is not pseudocode — it's the actual CEL that runs on every reconcile. kro evaluates it, gets a value, and writes it back to the Dungeon CR spec."

> "This is the ResourceGraphDefinition pattern: declare what to create, declare how to compute it in CEL, and let kro wire the whole thing together. No imperative code."

---

## Minute 5 — The payoff

**[Kill all monsters, then kill the boss. Show victory screen.]**

> "Boss defeated. kro auto-opened the Treasure CR, unlocked the door — and if you want to go deeper, Room 2 is waiting with a harder boss."

**[Show: victory banner with Run Card]**

> "Every win generates a shareable Run Card — an SVG served directly by the backend. The card shows your hero class, difficulty, turn count, and the kro concepts you unlocked. That URL is shareable on Twitter, Slack, anywhere."

> "You just played a turn-based dungeon RPG whose entire game engine is kro CEL running on Kubernetes. No game logic in the backend. No game logic in the frontend. All of it lives in this RGD — `dungeon-graph.yaml` — 400 lines of YAML with CEL expressions."

**[Show: QR code or type the URL]**

> "Scan this or go to `learn-kro.eks.aws.dev` — it's live, it's free, it's open source. The repo is `github.com/pnz1990/krombat`."

**[Show: kro GitHub]**

> "And kro itself is at `github.com/kubernetes-sigs/kro`. If you're building platform tooling on Kubernetes, kro is worth 30 minutes of your time."

---

## Fallback instructions (if the live cluster is slow)

- **Attack response is slow (>5s):** The EKS cluster may be cold-starting a node. Say: "kro is reconciling — this is the real thing, not a mock." Wait up to 15 seconds. It will come through.
- **Dungeon creation fails:** Try a different dungeon name. If the cluster is down, use a pre-recorded screen capture of a full run (keep one at `/tmp/krombat-demo-recording.mp4`).
- **K8s Logs tab empty:** Refresh the event log by clicking another entity in the arena. The WebSocket sometimes needs a nudge after a long idle.
- **Graph panel blank:** Click the graph icon twice (toggle off/on). Nodes render after the first reconcile event.

---

## Audience call to action

1. **Scan / type:** `https://learn-kro.eks.aws.dev` — play now, no account required for the tour
2. **Star:** `github.com/kubernetes-sigs/kro`
3. **Read:** `kro.run/docs` — 5-minute quickstart
4. **Watch:** The kro panel as you play — every concept has a glossary entry

---

*Script version: 2026-03 | Issue #458 | Repo: pnz1990/krombat*
