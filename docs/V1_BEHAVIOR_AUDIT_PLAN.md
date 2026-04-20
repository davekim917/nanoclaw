# V1 Behavior Audit — Plan

## Why this audit exists

During the v1 → v2 migration we shipped:

- Phase 5.0 container surface-area audit (mounts/env/network)
- Phase 2.11 git worktree MCP tools port (clone_repo, create_worktree, git_commit, git_push, open_pr)
- Phase 2.9 / 2.10 thread search + permalink resolver
- Channel adapter + MCP tools review
- Setup / wiring flow review

In that work I audited **what v1 exposes** (MCP tools, IPC handlers, channel adapters, setup commands, config surfaces). I did not systematically audit **what v1 guarantees** (host-side lifecycle behaviors, recovery paths, signal handling, hooks, implicit invariants the agent relies on without knowing).

The worktree auto-commit miss (v1's `cleanupThreadWorkspace` in `src/container-runner.ts`, commits dirty worktrees after every turn with `-m "auto-save: session exit"`) was a direct consequence of that classification error. It was a safety *behavior* that fires after every successful runAgent(), not an MCP tool or IPC handler — so it wasn't on any surface the prior audits enumerated. Dave noticed v2 was missing it because he remembered operating v1 and seeing it save him from compaction-induced context loss.

This is the same class of error as the "infra gaps are feature gaps" correction Dave made earlier (saved to memory as `feedback_infra_gaps_are_feature_gaps.md`). That correction was about *container surface-area* — mounts, env, network — which I then audited line-by-line. I did not re-apply the lens to *host-side lifecycle behaviors*, which is where this second class of miss lives.

**The ask:** a full behavioral audit that surfaces every v1 invariant still load-bearing in operation, with each one classified as present / partial / missing / regressed in v2. Deliverable is `docs/V1_BEHAVIOR_AUDIT.md` (a table, not a prose doc).

## Ground rules

1. **Full audit, not incremental.** Don't trust prior "this was ported" / "this was skipped" categorizations. Each behavior is checked against v1's actual code, not against memory of what was ported. Even surfaces I "know" are ported (e.g. MCP tool set, channel adapters, `.env` surface) get re-verified from the behavior side.

2. **Read the code, don't just grep.** Grep surfaces candidates; reading reveals invariants. For files dense with lifecycle/recovery/hook logic, read end-to-end — don't just jump to grep hit points. Cross-file reference tracing (caller → callee → caller of caller) is required when a behavior is split across files.

3. **No pre-emptive disclaimers.** The prior "v1 is big, some things only visible by reading" hedge was excusing incomplete work. Read enough to be confident, and when something is unclear, trace the call graph until it isn't.

4. **Treat `fix:` / `safety:` / `recover:` / `auto-` / `rollback` / `prevent:` / `guard:` / `ensure:` / `defense:` commits as load-bearing by default.** Each of those commits documents a behavior that exists because v1 broke without it. For each, ask: "does v2 have the fix, or did v2 regress to the pre-fix state?"

5. **Upstream/v2 is not ground truth.** Upstream doesn't carry our fork's bug-fix history. A behavior present in v1 but not upstream is still load-bearing for our fork.

6. **Operator memory supplements reading.** Some invariants are only visible from having operated v1 long enough to depend on them. After the reading-based audit produces its table, Dave reviews and supplements with behaviors I couldn't find in code (things that "worked magically" in v1 that he notices were specific guarantees).

## Scope — all six categories

### 1. Host-side lifecycle + recovery + signal handling

Files (read end-to-end, not just grep hits):

- `/home/ubuntu/nanoclaw/src/index.ts` — main loop, process handlers, signal dispatch, cursor rollback, in-flight message recovery, `shutdown()`, `messageLoopShuttingDown` flag semantics, PreCompact bridge, group-queue integration
- `/home/ubuntu/nanoclaw/src/container-runner.ts` — all `cleanup*` functions, `prepareThreadWorkspace`, `cleanupThreadWorkspace`, `cleanupOrphanWorktrees`, `buildVolumeMounts`, container lifecycle, auto-commit paths
- `/home/ubuntu/nanoclaw/src/group-queue.ts` — queue semantics, `shutdown()`, grace periods, in-flight tracking, concurrency bounds
- `/home/ubuntu/nanoclaw/src/db.ts` — recovery (`recoverPendingMessages`, `getOrRecoverCursor`), cursor semantics, migration rollback, `saveState()`
- `/home/ubuntu/nanoclaw/src/task-scheduler.ts` — scheduled task lifecycle, SIGTERM backup, failure retries
- `/home/ubuntu/nanoclaw/src/session-commands.ts` — `/compact`, `/clear`, `/resume`, pre-compact message injection
- `/home/ubuntu/nanoclaw/src/ipc.ts` — IPC handler bodies (many are host-side behaviors wrapped as IPC; Phase 2.11 only ported git ones)
- `/home/ubuntu/nanoclaw/src/remote-control.ts` — session lifecycle, SIGTERM handling, reconciliation
- `/home/ubuntu/nanoclaw/src/auth-approvals.ts`, `/home/ubuntu/nanoclaw/src/access.ts`, `/home/ubuntu/nanoclaw/src/user-dm.ts` — approval flow guarantees, DM resolution fallbacks
- `/home/ubuntu/nanoclaw/src/router.ts` — inbound routing guarantees, drop conditions, channel adapter contract
- `/home/ubuntu/nanoclaw/src/worktree-cleanup.ts` — what it commits/skips/removes

### 2. Container-side behaviors

Files (read end-to-end):

- `/home/ubuntu/nanoclaw/container/agent-runner/src/index.ts` — hooks (PreCompact, PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, Notification), secret injection, turn handling, prompt formatting, compact triggering, task-script execution
- `/home/ubuntu/nanoclaw/container/agent-runner/src/mcp-tools.ts` (if exists) or wherever MCP tool implementations live
- Anything under `/home/ubuntu/nanoclaw/container/agent-runner/src/` that touches lifecycle: `close.ts`, `cleanup.ts`, signal handlers, output writers

### 3. Cross-cutting invariants

Behaviors that span host + container:

- Auto-commit on turn end (host fires cleanup, container's work is in scope)
- Credential injection (config → container-runner env → container uses)
- Session resume semantics (host sets continuation, container honors)
- PreCompact flow (container hook → host indexing)
- Approval flow (container requests → host delivers DM → host resolves)

For each: verify the full end-to-end path works in v2, not just that both endpoints exist.

### 4. Re-validation of prior audit conclusions

For each area I previously claimed was ported:

- **Phase 5.0 container surface** — mounts, env, network, plugins. Re-verify each line of v1's `buildVolumeMounts` is either present in v2's equivalent OR explicitly out-of-scope for a documented reason.
- **Phase 2.11 git worktrees** — MCP tool surface was ported; behavior around worktree lifecycle (auto-commit miss found) needs full re-check.
- **Phase 2.9 / 2.10 archive + thread search** — verify write path fires in v2 on every message, read path returns same results, permalink parsing handles same URL shapes.
- **Channel adapters** — Slack, Discord. Verify multi-workspace Slack overlay doesn't break the adapter's expectations.
- **Setup / wiring** — v2 uses `/init-first-agent` + `/manage-channels`; check whether v1 had initialization behaviors (first-run setup, ownership grant, default isolation) that our flow skips.
- **MCP tools** — each tool present in both: does v2's implementation guarantee the same behavior on error paths / edge cases?

### 5. Git log mining

```bash
cd /home/ubuntu/nanoclaw
git log --all --format="%h %s" | grep -iE "^[a-f0-9]+ (fix|safety|recover|auto|rollback|prevent|guard|ensure|defense|hotfix|repair)(\(|:)"
```

Scan the full v1 history (~2 years). For each matching commit:

1. Read the commit body — commit message often explains the invariant
2. Read the diff — what actual guarantee was added
3. Check v2 — is the fix present, or is v2 running pre-fix behavior?

Expected volume: likely 100–300 matching commits. Most will be trivial (typo, dep bump). The load-bearing ones will cluster around: delivery, session lifecycle, cursor management, approval flows, container spawning, signal handling.

**Execution mode: cluster scan** (per 2026-04-20 scope decision). Group matching commits by touched file/subsystem. Spot-check the load-bearing clusters (delivery, session lifecycle, cursor mgmt, approvals, container spawn, signals). Skip trivial clusters (deps, typos, logs). Trades ~20% coverage loss on low-value commits for ~70% time savings.

### 6. Chat transcript self-check

Scan the current conversation's transcripts at `/home/ubuntu/.claude/projects/-home-ubuntu-nanoclaw/*.jsonl` for specific capability names Dave mentioned to me. For each: did I claim to port it? If so, verify against v2 code. This catches the class of miss where I said "done" but was actually shallow.

## Methodology (per-behavior loop)

For each candidate behavior identified in scope above:

1. **Identify** — grep surfaces it, OR reading the file reveals it, OR the commit log names it.
2. **Understand** — read the function and its callers/callees. What state does it depend on? What does it guarantee? When does it fire? What breaks without it?
3. **Look for v2 equivalent** — grep v2, read the target area. Is the behavior present? Partial? Different? Missing?
4. **Classify** with severity:
   - **CRITICAL** — user-visible data/work loss if absent (worktree auto-commit was this)
   - **HIGH** — silent degradation of reliability or correctness
   - **MEDIUM** — edge-case or rare-path regression
   - **LOW** — cosmetic / non-load-bearing
   - **N/A** — intentionally removed because v2's architecture makes it unnecessary, with the reason documented
5. **Record** in the output table.

## Output format

`docs/V1_BEHAVIOR_AUDIT.md` with a single table:

| v1 source | Behavior | v1 rationale | v2 status | Severity | Port plan |
|---|---|---|---|---|---|
| `src/container-runner.ts:1143` `cleanupThreadWorkspace` | Auto-commit dirty worktrees at turn end | Protect against compaction-induced context loss + mid-turn kill | **Fixed in `eb90165`** (was missing) | CRITICAL | Done |
| ... | ... | ... | ... | ... | ... |

Sorted by severity descending. Every row has a file:line v1 anchor so the audit is auditable itself.

## Execution notes for the post-compact session

- Start by re-reading THIS plan file in full.
- Confirm scope with Dave before executing (he may add categories based on operational memory).
- Track progress with TaskCreate entries per scope category — one in_progress at a time, not parallel.
- Append findings to `docs/V1_BEHAVIOR_AUDIT.md` incrementally as each category completes, so a mid-session compact doesn't lose all output.
- No code changes during the audit — deliverable is the document. Port work is a separate follow-up after Dave reviews and prioritizes.

## What this audit is NOT

- Not a re-architecture proposal. The goal is gap identification against v1 parity, not "is v2's design right."
- Not a feature wishlist. Things that would be nice but that v1 didn't do are out of scope.
- Not a test-coverage audit. Missing tests are not behaviors; they're absence of verification.
- Not a security review. That's a distinct exercise.
