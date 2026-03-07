---
description: Push changes and verify deployment via ui-test.sh
---
Run the full deploy-and-test workflow. This is mandatory after any frontend or backend change.

Current git status:
!`git status --short`

Recent commits on this branch:
!`git log origin/main..HEAD --oneline`

Steps:
1. If there are uncommitted changes, commit them now with an appropriate message before proceeding
2. Run: `./scripts/ui-test.sh`
3. Report the full result

If tests fail:
- Show which test failed and the relevant log output
- Check `test-failure.png` for a screenshot of the UI state
- Fix the root cause
- Re-run `./scripts/ui-test.sh`
- Only report success after all tests pass

If you already pushed and want to skip the push step:
- Run: `./scripts/ui-test.sh --skip-push`
