# Testing Workflow for Kiro Agent

## When Making Frontend or Backend Changes

**ALWAYS** run the automated test workflow after pushing changes. Never claim success without verification.

### Standard Workflow

1. **Make code changes**
2. **Commit changes** (but don't push yet if you want to batch)
3. **Run deploy-and-test script:**
   ```bash
   ./scripts/ui-test.sh
   ```

This script will:
- Push changes to Git
- Wait for Argo CD to sync (5min timeout)
- Wait for deployments to be ready (5min timeout)
- Port-forward the frontend service
- Run curl test to verify UI responds
- Run Playwright smoke tests (5 automated checks)
- Show logs if anything fails

### If Tests Fail

1. **Check the output** - script shows which test failed
2. **Review logs** - frontend and backend logs are displayed
3. **Check screenshot** - `test-failure.png` shows UI state
4. **Fix the issue** and run again
5. **Repeat until all tests pass**

### Quick Test (Skip Push)

If you already pushed and just want to re-test:
```bash
./scripts/ui-test.sh --skip-push
```

### Manual Testing

If you need to manually inspect the UI:
```bash
kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000
# Open http://localhost:3000 in browser
```

### Smoke Tests Include

1. ✓ UI loads without errors
2. ✓ Main content is present (Kubernetes RPG/KROMBAT/Dungeon text)
3. ✓ No JavaScript console errors
4. ✓ React app rendered successfully
5. ✓ Backend API is reachable

### Common Issues

**Argo CD sync timeout:**
- Check: `kubectl get application krombat -n argocd`
- May need to manually sync in Argo CD UI

**Deployment timeout:**
- Check: `kubectl get pods -n rpg-system`
- Check: `kubectl describe pod <pod-name> -n rpg-system`

**UI not responding:**
- Check frontend logs: `kubectl logs -n rpg-system deployment/rpg-frontend`
- Check if service exists: `kubectl get svc -n rpg-system`

**Backend API not reachable:**
- Check backend logs: `kubectl logs -n rpg-system deployment/rpg-backend`
- Check if backend is running: `kubectl get pods -n rpg-system -l app=rpg-backend`

## Rule for Agent

**Never report "done" or "try it out" without running `./scripts/ui-test.sh` first.**

If tests fail, analyze the error, fix the code, and run again. Only report success after tests pass.
