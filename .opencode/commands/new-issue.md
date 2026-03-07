---
description: Start work on a GitHub issue (fetch, branch, plan)
---
Fetch the details of GitHub issue #$ARGUMENTS from pnz1990/krombat using the gh CLI:

```
gh issue view $ARGUMENTS --repo pnz1990/krombat
```

Then:
1. Pull the latest main: `git checkout main && git pull origin main`
2. Create a feature branch: `git checkout -b issue-$ARGUMENTS-<short-description>` where <short-description> is a 2-4 word kebab-case summary of the issue title
3. Summarize the issue clearly
4. Propose a concrete implementation plan — list the files you expect to change and why — before making any edits

Do not make any code changes until the plan has been presented.
