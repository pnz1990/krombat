---
description: Full structured workflow to fix a bug issue
---
Fix bug issue #$ARGUMENTS in pnz1990/krombat using the full structured workflow.

**Step 1 — Fetch the issue**
```
gh issue view $ARGUMENTS --repo pnz1990/krombat
```

**Step 2 — Branch**
```
git checkout main && git pull origin main
git checkout -b issue-$ARGUMENTS-<short-description>
```

**Step 3 — Identify the root cause**
Read the relevant code paths. For combat bugs, look at:
- `manifests/rgds/attack-graph.yaml` — the bash Job logic
- `frontend/src/App.tsx` — polling, state derivation
- `backend/internal/handlers/handlers.go` — routing

For action bugs (equip, item, door, treasure):
- `manifests/rgds/action-graph.yaml`
- `frontend/src/App.tsx` item action handlers

Explain your root cause analysis before writing any code.

**Step 4 — Fix**
Make the minimal targeted change. Prefer editing existing files over creating new ones.
Reference the Key Lessons in AGENTS.md before touching loot, boss state, or room transitions.

**Step 5 — Verify**
Run: `./scripts/ui-test.sh`
Only proceed to Step 6 after all tests pass.

**Step 6 — PR**
```
git fetch origin main && git rebase origin/main
git push origin issue-$ARGUMENTS-<short-description>
gh pr create --title "fix: <description> (#$ARGUMENTS)" --body "Closes #$ARGUMENTS"
```

Report the PR URL when done.
