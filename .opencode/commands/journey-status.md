---
description: Show current Playwright journey test pass/fail status
subtask: true
---
Check the current state of all journey tests.

First, show the live pod status to confirm the cluster is reachable:
!`kubectl get pods -n rpg-system --no-headers 2>&1 | head -10`

Then run the journey tests and report results:

```bash
cd tests/e2e/journeys && npx playwright test --reporter=list 2>&1
```

After running, provide:
1. A pass/fail summary table for all 10 journeys
2. The names of any specific failing tests within each journey
3. A recommended next journey to work on based on current status (prioritize journeys that are partially passing or closest to completion)
4. Whether the checklist in AGENTS.md needs updating based on what you found
