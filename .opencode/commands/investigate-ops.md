---
description: Full ops sweep — cluster health, pod/RGD status, backend errors, leaderboard summary
---
Run a full operational health check for the krombat cluster. Cover all of the following:

1. **Pod health** — `kubectl get pods -n rpg-system` and `kubectl get pods -n kro`. Note any non-Running or high-restart pods.

2. **RGD status** — `kubectl get rgd`. All 9 should be `Active`. Flag any that are not.

3. **Dungeon state** — `kubectl get dungeons -A`. List all active dungeons with owner labels. Flag any in ERROR or non-Ready state.

4. **Recent warning events** — `kubectl get events -A --sort-by=.lastTimestamp | grep -v Normal`. Explain any warnings.

5. **Backend error logs (last 6h)** — Parse structured JSON logs from `kubectl logs -n rpg-system -l app=rpg-backend --since=6h`. Report:
   - Status code breakdown (200/4xx/5xx/429)
   - Any ERROR or WARN level entries
   - Slow requests (>1s), excluding WebSocket connections to `/api/v1/events`
   - Suspicious 404 paths (scanner probes, etc.)

6. **kro controller logs (last 1h)** — `kubectl logs -n kro <kro-pod> --since=1h`. Flag any errors or reconciliation failures.

7. **Leaderboard summary** — Parse the `krombat-leaderboard` ConfigMap in `rpg-system`. Report outcome breakdown (victory/defeat/in-progress) and note any unusual patterns.

8. **AWS credentials check** — Try `aws --region us-west-2 sts get-caller-identity`. If credentials are expired, note it and skip CloudWatch steps rather than failing.

**IMPORTANT**: Always pass `--context arn:aws:eks:us-west-2:<AWS_ACCOUNT_ID>:cluster/krombat` on every kubectl command.

After gathering all data, produce a concise summary with:
- Overall health status (green / yellow / red)
- Any actionable findings with suggested next steps
- Anything that warrants a new GitHub issue (repo: pnz1990/krombat)
