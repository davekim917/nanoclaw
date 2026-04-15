---
name: gitnexus-index-setup
description: "Ensure a GitNexus index exists and is current before modifying code. The repo-readiness-guard hook triggers this automatically on Edit/Write when the index is missing or stale. Without a current index, the post-commit blast radius hook silently no-ops and changes go unvalidated. Follow this skill whenever the guard fires or when starting work on any repo that might not be indexed."
---

# GitNexus Index Setup

The post-commit verification hook depends on a current GitNexus index to produce blast radius checklists. When the index is missing or stale, that hook silently skips — meaning code changes go unvalidated. This skill ensures the index is ready before you start modifying code.

## Check index state

```bash
cat <repo-path>/.gitnexus/meta.json 2>/dev/null
```

Compare `lastCommit` in meta.json against `git rev-parse HEAD`:

- **No `.gitnexus/` directory** — index doesn't exist yet
- **`lastCommit` doesn't match HEAD** — index is stale
- **Matches HEAD** — index is current, proceed with work

## Create or refresh

```bash
cd <repo-path> && npx gitnexus analyze
```

If the repo previously had embeddings (`stats.embeddings > 0` in meta.json), preserve them:

```bash
npx gitnexus analyze --embeddings
```

Then continue with the user's request.
