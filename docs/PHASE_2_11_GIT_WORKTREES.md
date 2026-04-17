# Phase 2.11 — Git Repos & Per-Thread Worktrees

**Status:** spec only, 2026-04-17. Promoted from T3.6 ("evaluate after
running v2") because it's a daily-use showstopper, not a
nice-to-have. Container runs; bot replies in Slack/Discord. But Axie-2
can't do real engineering work yet — it can't clone, work on, or PR
against Illysium repos the way Axie v1 does.

## Problem

v2 currently has no story for repo work. If an agent runs `git clone`
inline in a session, it clones into `/workspace/agent/<repo>` which IS
mounted and IS writable — but every session gets its own clone, no
sharing, no fetch-before-work, no parallel per-thread workspaces, no
commit/push/PR flow, no GC. v1 had all of this and Dave uses it every
day.

## v1 architecture (reference — verified from code read)

### Storage

| Kind | Path | Owner |
|---|---|---|
| Canonical repo | `groups/<group>/<repo>/` | One per group; shared across threads |
| Per-thread worktree | `data/worktrees/<group>/<threadId>/<repo>/` | One per (thread × repo) |

### Container mounts (v1, for threaded non-main channels)

- `data/worktrees/<group>/<threadId>` → `/workspace/worktrees` (RW)
- Each canonical `.git` dir → same host-absolute path inside container (RO)
  — required so worktree `.git` pointer files (which embed host paths)
  resolve correctly at read time.

### IPC tools (container → host, all run host-side under `withGroupMutex`)

| Tool | What it does |
|---|---|
| `clone_repo(url, name?)` | GitHub-only. Clones into `groups/<sourceGroup>/<repoName>/`. Idempotent. 120s timeout. |
| `create_worktree(repo, threadId, branch?)` | Runs `git fetch origin`, sets `origin/HEAD --auto`, then checks out existing branch or creates new from `origin/HEAD`. Default branch: `thread-<threadId>-<repo>`. Idempotent — returns existing worktree if valid; rebuilds if corrupt. `git check-ref-format` validation on branch names. |
| `git_commit(repo, threadId, message)` | Stages with `git add -A`, commits with `--no-verify` as `agent@nanoclaw.local` / `agent`. Pre-removes stale `.git/index.lock`. Returns short SHA. |
| `git_push(repo, threadId)` | `git push -u origin <current-branch>`. 60s timeout. |
| `open_pr(repo, threadId, title, body?)` | `gh pr create --title X --body Y`. Returns PR URL. |

Direct `git clone` from the agent is blocked. Agent prompt instructs
it to use the tools instead.

### Cleanup cron (6 hours, plus 60s after startup)

For each `(group, threadId, repo)` worktree:
1. Skip if dirty (`git status --porcelain` non-empty)
2. Skip if unpushed commits (`git log HEAD --not --remotes` non-empty)
3. Skip if detached HEAD
4. **Remove** if `gh pr list --head <branch> --state merged` returns a
   hit OR `git ls-remote --heads origin <branch>` is empty
5. Warn (do not delete) if >30 days old with no merged PR
6. Prune empty thread dirs (`rmdir`)

### Access gating

**Implicit via path scoping.** `sourceGroup` is derived from the caller's
context; the handler writes into `groups/<sourceGroup>/` only. Agents
can't reach other groups' repos because nothing mounts them.

### Non-obvious nuances

- `.git` mirrored RO at host-absolute path is the single biggest reason
  v1 uses IPC. Worktree `.git` files embed host paths.
- `--no-verify` is deliberate — prevents rogue hooks in the canonical
  repo from breaking agent flows.
- Branch name default includes threadId for concurrent-thread safety.
- v1's "main" channel bypasses worktrees and works directly in the
  canonical repo. Irrelevant for v2 (we always use per-thread).

## v2 target architecture

### Key insight: IPC is eliminated

Canonical repos are already mounted at `/workspace/agent/<repo>` (RW)
in every v2 container. Worktrees can be created **inside the
container** because:

1. `git worktree add /workspace/worktrees/<repo> <ref>` with `cwd =
   /workspace/agent/<repo>` succeeds — both are writable mounts visible
   to the container.
2. The `.git` pointer file git writes inside the worktree embeds the
   *container* path (`/workspace/agent/<repo>/.git/worktrees/<name>`),
   which resolves naturally inside the container. No host-absolute
   mirror mount needed.
3. All git operations (fetch, commit, push, `gh pr create`) run inside
   the container, which already has `git` and `gh` (Phase 1.5) and
   whatever credentials OneCLI injects.

### Storage (v2)

| Kind | Host path | Container path | Mode |
|---|---|---|---|
| Canonical repo | `groups/<folder>/<repo>/` | `/workspace/agent/<repo>/` | RW (already mounted as `/workspace/agent`) |
| Per-thread worktree | `data/v2-sessions/<ag>/<sess>/worktrees/<repo>/` | `/workspace/worktrees/<repo>/` | RW (already inside `/workspace`) |

**Lifecycle ties:**
- Canonical repo: per-agent-group, survives forever until explicitly
  removed.
- Worktree: per-session. Since v2 uses `session_mode='per-thread'`, a
  thread maps to one session, and the session dir persists across
  container restarts within that thread. Worktree survives container
  idle/wake cycles. When a thread is eventually archived / session
  cleaned, worktree goes with it.

This is slightly different from v1 (worktrees lived under
`data/worktrees/<group>/<threadId>/` independent of any session
concept). v2's tie-to-session is acceptable because in v2 a thread IS
a session, and sessions don't churn under normal conditions. Cron
cleanup still runs but the "PR merged → remove worktree" action
targets a path under the session dir.

### MCP tools (container-side, all new — no host IPC)

Location: `container/agent-runner/src/mcp-tools/git-worktrees.ts`
(new).

Tool names mirror v1 exactly for maximum prompt-compat:

1. `clone_repo({ url, name? })` → clones into
   `/workspace/agent/<name>/`. GitHub-only (keep the `hostname ===
   'github.com'` guard). Idempotent. 120s timeout.
2. `create_worktree({ repo, branch? })` — runs `git fetch origin` at
   `cwd=/workspace/agent/<repo>`, then `git remote set-head origin
   --auto`, then creates worktree at `/workspace/worktrees/<repo>`.
   Default branch: `thread-<sessionId>-<repo>` (using v2's session ID
   in place of v1's threadId for uniqueness). `git check-ref-format`
   validation. Idempotent.
3. `git_commit({ repo, message })` — `git add -A` + `git commit
   --no-verify -m "<msg>"` as `agent@nanoclaw.local`, at
   `cwd=/workspace/worktrees/<repo>`. Returns short SHA. Pre-removes
   `.git/index.lock`.
4. `git_push({ repo })` — `git push -u origin <current-branch>`. 60s
   timeout.
5. `open_pr({ repo, title, body? })` — `gh pr create`. Returns URL.

All tools validate `repo` against path traversal and existence. All
tools scope to the caller's agent group via the existing
`/workspace/agent` mount — no ACL logic needed (path mount IS the ACL).

### Block direct `git clone`

Replicate v1's pattern: in the agent's prompt / tool-instructions,
tell it to use `clone_repo` instead of `git clone`. Not worth
intercepting shell calls — just instruct the model.

### Mutex

v1 used `withGroupMutex` to serialize clone/fetch for a group (avoid
two concurrent clones of the same repo, avoid fetch races). In v2,
multiple concurrent containers can exist for the same agent group
(different threads). Options:

- **Option A (simple):** rely on `git`'s own locking (`.git/index.lock`
  etc.) — good enough for clone/fetch races; might cause transient
  errors that retry handles.
- **Option B (proper):** file-based lock at
  `/workspace/agent/.git-mutex` — container-side, via `flock(1)` or
  `proper-lockfile` node lib.

Start with A; promote to B if we see lock collisions in practice.

### Cleanup

Port v1's `src/worktree-cleanup.ts` to v2's `src/host-sweep.ts` or a
new `src/worktree-cleanup.ts`. Same logic: 6-hour cron, skip dirty /
unpushed / detached, remove on merged PR or branch-gone-on-origin,
warn at 30 days stale.

For v2, iterate `data/v2-sessions/<ag>/<sess>/worktrees/<repo>/`
instead of `data/worktrees/<group>/<threadId>/<repo>/`. Need to walk
all sessions. That's already feasible via `getAllAgentGroups()` +
glob.

### Credentials — resolved (pre-flight 2026-04-17)

**Decision: Option 1 (OneCLI transparent proxy) + `GH_TOKEN`
placeholder.** Validated end-to-end. No real token ever enters the
container env.

Verified facts:

- OneCLI 1.1.0 vault already had `GitHub` (personal) and
  `GitHub-Illysium` secrets with `hostPattern=api.github.com` and
  `injectionConfig: { headerName: "Authorization", valueFormat:
  "token {value}" }`.
- `GET /api/container-config?agent=<identifier>` returns a per-agent
  `HTTPS_PROXY` URL (the proxy-side auth uses the agent's own token,
  not the default agent's). Confirmed by diffing responses for
  `ag-1776402507183-cf39lq` (Axie-2) vs the no-agent default call.
- `applyContainerConfig` in the SDK also mounts the gateway CA at
  `/tmp/onecli-gateway-ca.pem` and sets `NODE_EXTRA_CA_CERTS` — so
  any TLS client that honors `SSL_CERT_FILE` or that env var
  transparently trusts the proxy's MITM cert.
- `curl --cacert /tmp/onecli-gateway-ca.pem https://api.github.com/user`
  via the proxy returns `200 OK` with no local token present — proves
  the proxy injection fires for generic HTTPS clients.
- `gh` short-circuits locally if `GH_TOKEN`/`GITHUB_TOKEN` is unset,
  so it never hits the proxy at all — OneCLI injection can't help on
  its own. Fix: set `GH_TOKEN=placeholder-for-proxy-injection` in the
  container env. `gh` then sends a request (with the placeholder in
  its `Authorization` header), the OneCLI proxy rewrites the header
  using the vault secret, and GitHub sees the real token. Confirmed:
  `gh api user` returned `davekim917` for Axie-2 (assigned to
  `GitHub`) and the expected Illysium-scoped identity for illie-v2
  (assigned to `GitHub-Illysium`).
- Same mechanic OneCLI already uses for `CLAUDE_CODE_OAUTH_TOKEN=placeholder`.

Per-group tokens in v2: each agent_group's OneCLI agent is assigned
the right GitHub secret. Already done for the first two:

| Agent group | OneCLI agent ID | Assigned GitHub secret |
|---|---|---|
| main (Axie-2) | `7c6390f4-78ac-4800-8cb8-fa7c0619a4d1` | `GitHub` (personal) |
| illie-v2 | `a05be189-187e-48eb-bb79-b40a034eddfb` | `GitHub-Illysium` |

`container-runner.ts` change: add one line —
`args.push('-e', 'GH_TOKEN=placeholder-for-proxy-injection')`.
Do **not** add any path to read the real token out of OneCLI and
into the env.

Open follow-ups (not blockers): the Illysium token returned no orgs
— likely a user-scoped PAT without `read:org` scope. Fine for cloning
and PR-opening against specific repos that Dave owns or has been
added to. Flag for Dave to rotate if we need org listing later.

### Blocked `git clone` error messaging

When the agent attempts `git clone` at bash, v1 returns an error
message pointing at `create_worktree`. v2 can't easily intercept bash
commands, but we can note it in the system prompt appended per-agent
group.

## Files to touch

| File | Change |
|---|---|
| `container/agent-runner/src/mcp-tools/git-worktrees.ts` | New. Implements the 5 tools. |
| `container/agent-runner/src/mcp-tools/index.ts` | Register `gitWorktreeTools`. |
| `container/agent-runner/src/mcp-tools/types.ts` | No change (existing `McpToolDefinition` shape suffices). |
| `src/worktree-cleanup.ts` | New host-side module. Port of v1's logic, adapted for v2 paths. |
| `src/index.ts` | Kick off `startWorktreeCleanup()` at startup (post-DB init). |
| `src/container-runner.ts` | Inject `GITHUB_TOKEN` env var from OneCLI if option 2. No change if option 1. |
| `groups/<folder>/CLAUDE.md` (host-side template via `group-init.ts`) | Add the "use clone_repo/create_worktree, never git clone" directive. |
| `docs/MIGRATION_FROM_V1.md` | Promote T3.6 → Phase 2.11. Update parity checklist. |
| `container/skills/gitnexus-index-setup/SKILL.md` (port from v1) | If not already present, port so agents run `gitnexus analyze` when index is stale. |

## Order of work

1. ~~**Pre-flight: validate OneCLI can inject `GITHUB_TOKEN`**~~ **Done
   2026-04-17.** Option 1 chosen. See "Credentials — resolved" above.
   T3.6 is unblocked.
2. **Wire `container-runner.ts`**: add
   `args.push('-e', 'GH_TOKEN=placeholder-for-proxy-injection')` in
   the env-building block alongside the other
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY`/`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
   lines. One-liner.
3. **Build MCP tools** in `container/agent-runner/src/mcp-tools/git-worktrees.ts`.
3. **Register** in `mcp-tools/index.ts`.
4. **Sync into illysium-v2 group's `agent-runner-src/` mount** (same
   pattern as earlier tool pushes during this migration).
5. **Rebuild container image** if the base image needs a tweak. Likely
   it doesn't — `git` and `gh` are already there from Phase 1.5.
6. **Smoke test:** `@illie-v2` → `clone_repo` → `create_worktree` →
   edit a file via bash → `git_commit` → `git_push` → `open_pr`.
   Verify on GitHub that the PR actually exists.
7. **Port cleanup cron.** Add to `host-sweep.ts` or dedicated module.
   Verify: create a worktree, merge its PR on GitHub, wait for cron
   (or trigger manually), verify worktree dir is removed.
8. **Update docs.** Migration doc: T3.6 → 2.11, parity checklist.
9. **Tier-2 polish:** add gitnexus-index-setup skill to
   `container/skills/` so agents auto-rebuild stale indexes.

## Testing plan

**Smoke (minimum to close):**
- Clone a small Illysium repo via `clone_repo`.
- Create a worktree via `create_worktree`, verify it's at
  `/workspace/worktrees/<repo>/`.
- Edit a README line via bash inside the worktree.
- Commit via `git_commit`.
- Push via `git_push`.
- Open a PR via `open_pr`; verify URL is returned and PR exists on GitHub.
- After merging the PR on GitHub, trigger cleanup; verify worktree dir is removed.

**Parity (v1 vs v2 against same repo):**
- On a test Illysium repo, have Axie v1 run its normal flow and Axie-2
  v2 run the same steps. Compare: branch names, commit authors, PR
  shape, cleanup timing. No regressions on shape.

**Concurrency:**
- Two threads simultaneously @-mention Axie-2 asking it to work on the
  same repo. Verify both get their own worktrees (different branch
  names), no index.lock collisions, both commits succeed.

## Open questions (to resolve during implementation)

1. ~~**OneCLI GitHub token injection.**~~ Resolved — see "Credentials"
   above. Proxy works for `curl`/raw HTTPS natively; `gh` needs a
   placeholder `GH_TOKEN` to not short-circuit locally.
2. ~~**Per-group GitHub tokens.**~~ Resolved — each agent_group's
   OneCLI agent gets the right secret assigned. Done for Axie-2 and
   illie-v2.
3. **`git worktree` inside the container — does it actually resolve
   the `.git` pointer correctly?** Should work because everything's in
   container paths. But verify early — this is the assumption that
   lets us drop the IPC mirror-mount.
4. **Cleanup cadence.** 6h works for v1 but v2 has a 60s host-sweep.
   Should cleanup piggyback on that (gated by timestamp) or stay
   standalone?
5. **Cleanup scope when a session is actively running a container.**
   Adding a `git worktree remove --force` while the container is mid-
   `git commit` could cause confusion. Options: (a) acquire a
   worktree-level lock; (b) skip cleanup if the session's container is
   running (v2 knows this via session state).
6. **Branch name when no threadId.** v1 used `thread-<threadId>-<repo>`.
   v2 uses `session-<sessionId>-<repo>`? Or match v1 by using
   `thread-<threadId>` where threadId = the platform thread? The v2
   platform thread ID is a big composite string (e.g.
   `slack:C08N..:1776...`) — not git-branch-name-safe. Sanitize.

## Out of scope for first cut

- Non-GitHub hosts (gitlab, bitbucket). Match v1.
- Repo registry / explicit allowlist. Path scoping is enough.
- Streaming commit progress back to Slack/Discord during long ops.
- Auto-detection of stale gitnexus index. Keep agent-driven via skill.
- Handling `git fetch` failures gracefully (warn, continue is v1's
  pattern — match).
- Worktree rebase / pull. Agent can do this via bash for now.

## Success criteria

Dave can say `@illie-v2 clone https://github.com/illysium/<repo>, make
a one-line change to README, commit as "test", push, and open a PR`
and see a real PR on GitHub. Worktree persists across container
restart in the same thread. PR merge on GitHub results in worktree GC
within one cron cycle. Other threads working on the same repo don't
interfere.
