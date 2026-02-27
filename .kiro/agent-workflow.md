# Agent Git Workflow

Multiple AI agents work on this repo in parallel. To avoid conflicts, **never commit directly to main**. Always use feature branches and PRs.

## Workflow

```bash
# 1. Start from latest main
git checkout main
git pull origin main

# 2. Create a feature branch (use issue number)
git checkout -b issue-<number>-<short-description>
# Example: git checkout -b issue-45-fix-equip-state

# 3. Make changes, commit as needed
git add <files>
git commit -m "fix: description (#<issue-number>)"

# 4. Before pushing, rebase on latest main
git fetch origin main
git rebase origin/main
# Resolve any conflicts if needed

# 5. Push branch and open PR
git push origin issue-<number>-<short-description>
gh pr create --title "fix: description (#<issue-number>)" --body "Closes #<issue-number>"

# 6. Wait for CI (build + integration tests run on PRs)
gh pr checks <pr-number> --watch

# 7. Merge (squash merge preferred)
gh pr merge <pr-number> --squash --delete-branch
```

## Rules

1. **Never push directly to main** — always use a branch + PR
2. **Always rebase before pushing** — `git fetch origin main && git rebase origin/main`
3. **One issue per branch** — keeps PRs focused and reviewable
4. **Branch naming**: `issue-<number>-<short-description>` (e.g., `issue-45-fix-equip-state`)
5. **Commit messages**: `type: description (#issue)` (e.g., `fix: equip state persistence (#45)`)
6. **Close issues via PR**: Include `Closes #<number>` in PR body
7. **If rebase has conflicts**: Resolve them, don't force-push over others' work
8. **After merge**: Switch back to main and pull before starting next task

## CI on PRs

- **Build & Push Images** — builds Docker images (validates they compile), only pushes to ECR on main merge
- **Integration Tests** — runs full test suite against the live cluster
- Both must pass before merging

## Quick Reference

```bash
# Start new work
git checkout main && git pull && git checkout -b issue-XX-description

# Finish and submit
git fetch origin main && git rebase origin/main && git push origin HEAD
gh pr create --title "type: description (#XX)" --body "Closes #XX"

# After merge
git checkout main && git pull
```
