---
name: update-skills
description: Safely refresh installed channel and provider skills from their long-lived branches without overwriting newer or customized local behavior. Use after an upstream NanoClaw update or when installed adapter/provider code may be stale.
---

# About

Each skill is a self-installing additive unit: its folder under
`.claude/skills/<name>/` carries its own apply steps (`SKILL.md`), and
channel/provider skills fetch code files from a long-lived branch (`channels`,
`providers`).

Those branch copies are update candidates, not automatically authoritative.
An installed file may contain newer trunk integration or operator
customizations that the branch does not. Never re-run an apply until a
candidate comparison proves that it will not remove required local behavior.

Run `/update-skills` in Claude Code.

## How it works

**Preflight**: checks for a clean working tree and the upstream remote.

**Detection**: reads the channel and provider barrels to list which skills have copied code into your tree, and lists the operational/utility skills present under `.claude/skills/`.

**Selection**: presents the installed skills and lets you pick which to re-apply.

**Compatibility preview**: compares every candidate branch file with the live
copy and blocks destructive or stale replays.

**Re-apply**: invokes only the skills whose candidate payload clears that
preview. Then validates with build + tests.

---

# Goal
Help users pull the latest skill code from upstream without losing local
customizations and without merging any branch.

# Operating principles
- Never proceed with a dirty working tree.
- Treat local customization behavior as the release-blocking invariant.
- Never call an overwrite idempotent merely because repeating it produces the
  same branch copy. Idempotence does not prove compatibility.
- Re-apply a skill through its own apply step only after the candidate payload
  proves it will preserve newer local integration and custom behavior.
- Credentials, wiring, and DB state stay untouched.
- Keep token usage low: detect installed skills with `git` and barrel reads; let each skill's apply do its own fetching.

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first, then stop.

Check remotes:
- `git remote -v`

If `origin` does not point at a NanoClaw upstream (or you want to verify it has the skill branches), confirm with the user before continuing. The default upstream is `https://github.com/nanocoai/nanoclaw.git`.

Fetch the branches that carry skill code:
- `git fetch origin channels providers --prune`

# Step 1: Detect installed skills

**Channels** — read `src/channels/index.ts` and collect each `import './<name>.js';` line, excluding `cli`. Each `<name>` maps to the `/add-<name>` skill.

**Providers** — read `src/providers/index.ts` the same way; each imported provider maps to its `/add-<name>` skill.

**Operational and utility skills** — list the folders under `.claude/skills/`. These copy no code into the tree, so "re-applying" them just re-reads their instructions; only include them if the user specifically wants to re-run a workflow.

Build the candidate list from the channels and providers actually wired into the barrels — those are the skills whose copied code can be refreshed from upstream.

# Step 2: Present results

If no channel or provider skills are installed:
- Tell the user there are no code-carrying skills to update. List any operational skills present for reference.
- Stop here.

If installed channel/provider skills are found:
- Show the list (e.g. `slack`, `discord`, `opencode`).
- Use AskUserQuestion with `multiSelect: true` to let the user pick which skills to re-apply.
  - One option per installed channel/provider (e.g. "Re-apply Slack (/add-slack)").
  - Add an option: "Skip — don't update any skills now".
- If the user selects Skip, stop here.

# Step 3: Preview each selected payload

Process one skill at a time. Read its complete `SKILL.md` and collect every path
owned by its copy directives or shell `git show` commands. For each path:

1. Confirm the path exists on the candidate branch. A candidate missing a file
   required by the current installer or registration tests is `BLOCK`.
2. Compare the candidate bytes with the live file without overwriting it:
   `cmp -s <(git show origin/<branch>:<path>) <path>`.
3. For every difference, inspect the complete candidate-to-live diff and the
   live file's relevant non-merge history. Classify live-only changes as:
   - required local customization or newer trunk integration;
   - an obsolete implementation with a proven candidate replacement; or
   - ambiguous.
4. Build a preservation row for every functional live-only change:

   ```
   intent + provenance | integration point | preservation requirement | targeted verification
   ```

Any candidate that would delete a required or ambiguous live-only change is
`BLOCK`; skip that skill and report it as "refresh correctly skipped: candidate
would regress local behavior." Do not invoke its add skill, copy a subset
blindly, or describe the live code as stale.

A candidate may proceed only when all differences are additive or every
removed behavior has a proven compatible replacement and targeted
verification. Generic build and full-suite success do not replace this
comparison.

# Step 4: Re-apply each cleared skill

For each selected skill (process one at a time):

1. Tell the user which compatibility-cleared skill is being re-applied.
2. Invoke the corresponding `/add-<name>` skill using the Skill tool.
   - Its apply runs its own pre-flight, fetches the latest files from upstream (`git fetch origin <branch>` + `git show origin/<branch>:path > path`), overwrites the copied-in code, and installs any pinned dependency.
   - Re-applying is additive: it refreshes only that skill's own files. The barrel import line is left in place if already present, and `.env` credentials and DB wiring are untouched.
3. If a skill's apply reports a problem (a missing upstream file, a failing dependency install), record it and continue with the remaining skills.

# Step 5: Validation

After all selected skills are re-applied:
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)
- If the re-apply changed any files under `container/` (`git diff --name-only -- container/` is non-empty), rebuild the agent image so new sessions pick up the new code: `./container/build.sh`. Skill code that lives in the container (e.g. a provider's runtime) keeps running the old image until this is done — the rebuild is what makes the fix live, not the file copy. If nothing under `container/` changed (e.g. only a channel adapter was re-applied), skip it.

Each channel/provider skill copies in its own registration test; those run as part of `pnpm test` and assert the barrel still registers the adapter against the freshly fetched code.

Also run every targeted verification recorded in Step 3. A skipped or failed
preservation check is a failed refresh even when the generic suite passes.

If build fails:
- Show the error.
- Only fix issues clearly caused by the refreshed code (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

# Step 6: Summary

Show:
- Skills re-applied (list)
- Skills correctly skipped because their candidate would regress local behavior
- Skills skipped or that reported other problems (if any)
- New HEAD: `git rev-parse --short HEAD`

If the service is running, remind the user to restart it to pick up the refreshed code.
