---
name: github-workflow
description: NanoClaw conventions for code changes, PRs, branch workflow, and saving work. Use when making code changes, opening PRs, cloning repos, or when the user asks to add a new project/group. Ship log and attribution rules are always loaded in global CLAUDE.md — this skill covers the broader workflow.
---

# GitHub Workflow

## Making Changes

1. Read the repo's `CLAUDE.md` before writing any code — it has project-specific conventions.
2. Report the current branch before starting. If on main/develop, create a feature branch first — silent edits on main cause merge headaches.
3. Make changes, then commit, push, and open a PR via `gh pr create`.
4. Share the PR link.

## Save Your Work

The workspace is temporary. Always commit and push before stopping, even if incomplete:

```
git checkout -b wip/{descriptive-name}
git add -A && git commit -m "wip: {what was done so far}"
git push origin HEAD
```

The host rescues unpushed commits to `rescue/` branches as a safety net, but don't rely on it.

## Adding a New Project

When Dave wants to add a new project:

1. Ask for: project name, description, GitHub repos (if any), key focus areas
2. Create group folder: `/workspace/project/groups/{project-name}/`
3. Create subdirectories: `logs/`, `conversations/`
4. Write a `CLAUDE.md` in the group folder with project context
5. Tell Dave the group is ready and he can map a channel to it
