/**
 * Ratchet: the transitional synchronous central-DB handle may only shrink.
 *
 * `getRawDb()` / `hasTableRaw()` (src/db/connection.ts) are seam-3 scaffolding.
 * Upstream's `DbDriver` is async; the fork's ~1,150 call sites were synchronous
 * when the driver landed (PR 1), and they convert leaf-by-leaf in PRs 3-5. PR 6
 * deletes both functions and this file with them.
 *
 * Until then the two escape hatches are safe only because the fork opens ZERO
 * driver transactions (src/db/transaction-closures.test.ts is the other half of
 * that invariant): a raw statement bypasses the driver's `activeTransaction`
 * gate, so one running inside an open `BEGIN IMMEDIATE` would silently join a
 * transaction it knows nothing about. Every NEW raw call site widens that
 * window, which is why this list may lose entries and never gain them.
 *
 * The pin is the SET of file paths, not a count, so a rename cannot hide
 * growth: a renamed file is one removal plus one addition, and the addition
 * fails. Removing entries needs no ceremony — that is the direction of travel.
 *
 * Scope note: this counts any reference to either identifier in a file with
 * comments stripped, not only a static `import`. Dynamic `await import(...)`
 * destructuring and `vi.mock` factory properties are how several test files
 * reach the seam, and an import-only scan would let a PR add one of those for
 * free.
 *
 * See docs/specs/upstream-async-central-db-seam/plan.md §4.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['src', 'scripts', 'setup'] as const;

/**
 * Not callers, and excluded from the scan:
 *  - `connection.ts` defines both functions.
 *  - this file names them in its own matcher, so it would otherwise match itself.
 */
const DEFINER = 'src/db/connection.ts';
const SELF = 'src/db/raw-db-ratchet.test.ts';
const NOT_CALLERS: readonly string[] = [DEFINER, SELF];

/**
 * Every file referencing `getRawDb` or `hasTableRaw`, shrink-only.
 *
 * PR 6 removed the guard-path files from this list: the three guard
 * implementations (`guard/guard.ts`, `cli/guard.ts`,
 * `agent-to-agent/guard.ts`), `write-destinations.ts` and the wake/write
 * guard reads in `container-runner.ts`/`session-manager.ts` now reach the
 * central DB through `withRawDb` inside `withCentralSync` (the lease that
 * keeps a synchronous central read out of an open driver transaction), and the
 * eleven central `db.transaction` closures now go through `centralTransaction`
 * — so those files no longer name `getRawDb`.
 *
 * `src/test-fixtures/raw-db-fake.ts` is the one further entry, and it exists to
 * KEEP this list small: every test whose subject reaches the sync guard path
 * without opening a central DB needs a stub handle, and routing them all
 * through one shared fake means the identifier is named once instead of once
 * per test file. Migrating an existing test entry onto it removes that entry.
 *
 * PR 5b removed EIGHT entries (205 → 197): `users`, `user_dms`,
 * `pending_sender_approvals`, the orchestrator capability leaf, `progress.ts`,
 * agent-to-agent `create-agent.ts` and `steer-idempotency.ts` are wholly on
 * the driver now, and `modules/interactive/index.ts` traded `hasTableRaw` for
 * the async `hasTable`. Nine files in PR 5b's own areas KEEP their entry on
 * purpose, each for one of the two reasons the plan already names, with the
 * reason written at the export itself: a leaf export reachable from a raw
 * transaction closure (§4.2 — `orchestrator-dispatch/dispatch.ts` and the
 * `db/tasks.ts` exports its closure calls; `agent-destinations.ts`'s
 * `createDestination` / `getDestinationByName` / `getDestinationByTarget`,
 * which `ensureAgentDestinationForWiring` calls inside
 * `cli/resources/wirings.ts`'s closure), or one reachable from a synchronous
 * guard or mailbox block (§4.5 I-1 — `user_roles`'s privilege predicates,
 * `agent_group_members`'s membership predicates,
 * `pending-channel-approvals`'s `getPendingChannelApproval`,
 * `agent-message-policies`'s `getMessagePolicy`, `agent-destinations`'s
 * `hasDestination` / `getDestinations`, and `agent-route.ts`'s
 * `targetWiredToMessagingGroup`). None of them has an async twin; they convert
 * in PR 6 with their closure or inside `withCentralSync`.
 *
 * PR 5b adds NOTHING. It was expected to add one entry —
 * `src/modules/permissions/guard.ts`, joining the other guard implementations
 * above under PR 4's SQL-constant shape — and does not, because the two leaf
 * exports that guard reads (`hasAdminPrivilege`, `getPendingChannelApproval`)
 * simply stayed synchronous. That is the cheaper half of the same §4.5 rule:
 * the SQL-constant shape would have re-derived one composite predicate
 * (`equivalentSlackUserIds` × three role probes) into THREE separate guard
 * files, since `dashboard/thread-close-guard.ts` and
 * `dashboard/observatory-assign-guard.ts` call `hasAdminPrivilege` from their
 * `decide` bodies too. One synchronous export beats three hand-copied
 * authorization predicates, and §4.2 is satisfied either way: there is exactly
 * one form of each function, never two.
 *
 * PR 5c removed TWO entries (197 → 195): `src/cli/request-ledger.ts`
 * (`pruneCliRequestExecutions` converted onto `getDb()`, its only caller
 * `sweep-central/index.ts` awaits it) and `src/modules/sweep-scheduling/index.ts`
 * (its one raw call, `hasUnresolvedMoveIntent(getRawDb(), ...)`, converted to
 * `await hasUnresolvedMoveIntent(...)` with the helper itself dropping its
 * `Database.Database` param — defined in `src/dashboard/api/scheduled-shared.ts`,
 * which never called `getRawDb()` itself and so was never on this list). The
 * two test files that still exercise these areas (`request-ledger.test.ts`,
 * `sweep-scheduling/scheduling.test.ts`) keep their entries: both still call
 * `getRawDb()` directly for their own fixture scaffolding and assertions,
 * independent of the functions this PR converted. `writeAudit` / `purgeIntentBody`
 * / the PR 6-owned callers in the same file are untouched — PR 5c does not add
 * or remove anything for them.
 */
export const RAW_DB_IMPORTERS: readonly string[] = [
  'scripts/bust-slack-profile-cache.ts',
  'scripts/delete-cli-agent.ts',
  'scripts/init-cli-agent.ts',
  'scripts/init-first-agent.ts',
  'scripts/migrate-thread-tasks-to-channel-root.ts',
  'scripts/migrate-workgroup-memory.ts',
  'scripts/reclaim-idle-thread-worktrees.ts',
  'scripts/seed-discord.ts',
  'scripts/test-v2-channel-e2e.ts',
  'scripts/test-v2-host.ts',
  'setup/migrate-v2/db.ts',
  'setup/migrate-v2/sessions.ts',
  'setup/migrate-v2/tasks.ts',
  'setup/pair-telegram.ts',
  'setup/register.ts',
  'src/agent-runner-source.test.ts',
  'src/attention-sources.test.ts',
  'src/attention-sources.ts',
  'src/capabilities.test.ts',
  'src/capabilities.ts',
  'src/channels/channel-registry.test.ts',
  'src/channels/chat-sdk-bridge-byline.test.ts',
  'src/channels/chat-sdk-bridge-recovery.test.ts',
  'src/channels/slack-hop-limit.test.ts',
  'src/channels/slack-raw-text.test.ts',
  'src/claude-md-compose.test.ts',
  'src/claude-md-compose.ts',
  'src/cli/crud-validate.test.ts',
  'src/cli/crud.test.ts',
  'src/cli/crud.ts',
  'src/cli/delivery-action.test.ts',
  'src/cli/request-ledger.test.ts',
  'src/cli/resources/destinations.test.ts',
  'src/cli/resources/groups-create-adopt.test.ts',
  'src/cli/resources/groups.test.ts',
  'src/cli/resources/groups.ts',
  'src/cli/resources/messaging-groups.test.ts',
  'src/cli/resources/programmatic-wiring.test.ts',
  'src/cli/resources/tasks.test.ts',
  'src/cli/resources/tasks.ts',
  'src/cli/resources/usage.test.ts',
  'src/cli/resources/wirings.test.ts',
  'src/command-gate.test.ts',
  'src/container-config.test.ts',
  'src/container-runner.test.ts',
  'src/container-runner.ts',
  'src/dashboard/api/auth-me.test.ts',
  'src/dashboard/api/groups.test.ts',
  'src/dashboard/api/messaging-groups.test.ts',
  'src/dashboard/api/observatory.test.ts',
  'src/dashboard/api/scheduled-assembly.test.ts',
  'src/dashboard/api/scheduled-move.test.ts',
  'src/dashboard/api/scheduled-move.ts',
  'src/dashboard/api/scheduled-mutations.test.ts',
  'src/dashboard/api/scheduled-mutations.ts',
  'src/dashboard/api/scheduled-read.test.ts',
  'src/dashboard/api/scheduled-shared.test.ts',
  'src/dashboard/api/sessions.test.ts',
  'src/dashboard/api/threads.test.ts',
  'src/dashboard/assign.test.ts',
  'src/dashboard/auth/compute-scopes.test.ts',
  'src/dashboard/auth/exchange.test.ts',
  'src/dashboard/db/dashboard-tokens.test.ts',
  'src/dashboard/db/steer-idempotency.test.ts',
  'src/dashboard/issue-brief.test.ts',
  'src/dashboard/nudge.test.ts',
  'src/dashboard/observatory-assign-guard.test.ts',
  'src/dashboard/observatory-steer.test.ts',
  'src/dashboard/session-title-sweep.test.ts',
  'src/dashboard/steer.test.ts',
  'src/dashboard/thread-close.test.ts',
  'src/dashboard/thread-close.ts',
  'src/dashboard/thread-message.test.ts',
  'src/dashboard/thread-snooze.test.ts',
  'src/db/agent-groups.test.ts',
  'src/db/backlog.ts',
  'src/db/boot-order.test.ts',
  'src/db/central-lease.ts',
  'src/db/channel-ingress-receipts.test.ts',
  'src/db/channel-ingress-receipts.ts',
  'src/db/container-configs.test.ts',
  'src/db/db-v2.test.ts',
  'src/db/denied-models.ts',
  'src/db/index.ts',
  'src/db/messaging-groups-instance.test.ts',
  'src/db/migrations/068-sessions-sweep-quiet-until.test.ts',
  'src/db/provider-health.test.ts',
  'src/db/scheduled-tasks.test.ts',
  'src/db/sessions.test.ts',
  'src/db/support-threads.ts',
  'src/db/task-thread-anchors.ts',
  'src/db/thread-titles.ts',
  'src/db/usage.test.ts',
  'src/delivery.test.ts',
  'src/delivery.ts',
  'src/group-init.settings.test.ts',
  'src/host-core.test.ts',
  'src/host-lifecycle-timers.test.ts',
  'src/host-sweep.test.ts',
  'src/mailbox-seam-unreachable-scripts.test.ts',
  'src/main.ts',
  'src/modules/agent-to-agent/agent-route-parity.test.ts',
  'src/modules/agent-to-agent/agent-route.test.ts',
  'src/modules/agent-to-agent/create-agent.test.ts',
  'src/modules/agent-to-agent/db/agent-destinations.ts',
  'src/modules/agent-to-agent/db/agent-message-policies.ts',
  'src/modules/agent-to-agent/guard.ts',
  'src/modules/agent-to-agent/message-gate.test.ts',
  'src/modules/agent-to-agent/write-destinations.test.ts',
  'src/modules/approvals/approval-resolved.test.ts',
  'src/modules/approvals/onecli-approvals.test.ts',
  'src/modules/approvals/picks.test.ts',
  'src/modules/approvals/primitive.test.ts',
  'src/modules/approvals/reason-capture.test.ts',
  'src/modules/approvals/response-handler.test.ts',
  'src/modules/bash-gate/index.test.ts',
  'src/modules/channel-auto-wire/index.test.ts',
  'src/modules/claims/self-heal.test.ts',
  'src/modules/claims/self-heal.ts',
  'src/modules/memory/pre-turn-context.test.ts',
  'src/modules/memory/pre-turn-context.ts',
  'src/modules/orchestrator-dispatch/cancellation.test.ts',
  'src/modules/orchestrator-dispatch/completion.test.ts',
  'src/modules/orchestrator-dispatch/db/agent-group-capabilities.test.ts',
  'src/modules/orchestrator-dispatch/db/tasks.test.ts',
  'src/modules/orchestrator-dispatch/db/tasks.ts',
  'src/modules/orchestrator-dispatch/dispatch.test.ts',
  'src/modules/orchestrator-dispatch/dispatch.ts',
  'src/modules/orchestrator-dispatch/integration.test.ts',
  'src/modules/orchestrator-dispatch/needs-input.test.ts',
  'src/modules/orchestrator-dispatch/progress.test.ts',
  'src/modules/orchestrator-dispatch/reconciler.test.ts',
  'src/modules/permissions/channel-approval-folder-race.test.ts',
  'src/modules/permissions/channel-approval.test.ts',
  'src/modules/permissions/db/agent-group-members.ts',
  'src/modules/permissions/db/pending-channel-approvals.ts',
  'src/modules/permissions/db/user-roles.test.ts',
  'src/modules/permissions/db/user-roles.ts',
  'src/modules/permissions/grant.test.ts',
  'src/modules/permissions/permissions.test.ts',
  'src/modules/permissions/sender-approval.test.ts',
  'src/modules/permissions/sender-decline-notify.test.ts',
  'src/modules/permissions/task-slack-subject.test.ts',
  'src/modules/permissions/user-dm-adopt.test.ts',
  'src/modules/provider-fallback/handler.test.ts',
  'src/modules/repository-workspaces/index.test.ts',
  'src/modules/repository-workspaces/index.ts',
  'src/modules/scheduling/create.test.ts',
  'src/modules/self-mod/apply.test.ts',
  'src/modules/self-mod/request.test.ts',
  'src/modules/support-threads/dispatch.test.ts',
  'src/modules/sweep-central/central.test.ts',
  'src/modules/sweep-central/session-title-sweep.test.ts',
  'src/modules/sweep-central/thread-title-retry.test.ts',
  'src/modules/sweep-claims/claims-throttle.test.ts',
  'src/modules/sweep-container-health/health.test.ts',
  'src/modules/sweep-continuation/continuation.test.ts',
  'src/modules/sweep-idle-reap/idle-reap.test.ts',
  'src/modules/sweep-orchestrator/orchestrator.test.ts',
  'src/modules/sweep-scheduled-move/index.ts',
  'src/modules/sweep-scheduled-move/scheduled-move.test.ts',
  'src/modules/sweep-scheduling/scheduling.test.ts',
  'src/modules/sweep-usage/usage.test.ts',
  'src/provider-fallback.test.ts',
  'src/provider-surfaces.test.ts',
  'src/providers/opencode.container-config.test.ts',
  'src/router.session-skip.test.ts',
  'src/router.test.ts',
  'src/router.ts',
  'src/session-manager.attachments.test.ts',
  'src/session-manager.test.ts',
  'src/state-sqlite.test.ts',
  'src/state-sqlite.ts',
  'src/storage-gc.test.ts',
  'src/storage-manager.test.ts',
  'src/storage-manager.ts',
  'src/storage-pressure-alert.test.ts',
  'src/storage-pressure-alert.ts',
  'src/templates/create-agent.test.ts',
  'src/test-fixtures/raw-db-fake.ts',
  'src/topic-title.test.ts',
  'src/workgroup-memory.integration.test.ts',
  'src/worktree-cleanup.test.ts',
  'src/worktree-cleanup.ts',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function listTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root));
  return out.sort();
}

function currentImporters(): string[] {
  return listTsFiles()
    .filter((rel) => !NOT_CALLERS.includes(rel))
    .filter((rel) =>
      /\bgetRawDb\b|\bhasTableRaw\b/.test(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))),
    );
}

describe('the raw central-DB handle only shrinks', () => {
  it('scans a tree that actually contains the seam', () => {
    // Guards the scanner itself: a broken walk would report an empty set and
    // pass the shrink assertion below while checking nothing.
    const files = listTsFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(DEFINER);
    expect(files).toContain(SELF);
  });

  it('getRawDb/hasTableRaw referrers are exactly the pinned set', () => {
    const current = new Set(currentImporters());
    const pinned = new Set(RAW_DB_IMPORTERS);
    const added = [...current].filter((f) => !pinned.has(f)).sort();
    expect(
      added,
      'a NEW file reaches the transitional synchronous central-DB handle. The seam only shrinks: ' +
        'convert the site to the async DbDriver (getDb()) instead of widening the raw allowlist. ' +
        'See docs/specs/upstream-async-central-db-seam/plan.md §4.1.',
    ).toEqual([]);
  });

  it('records removals so the pin cannot rot into a stale list', () => {
    const current = new Set(currentImporters());
    const removed = RAW_DB_IMPORTERS.filter((f) => !current.has(f));
    expect(
      removed,
      'these pinned files no longer touch the raw handle — delete them from RAW_DB_IMPORTERS in this commit',
    ).toEqual([]);
  });

  it('pins real paths', () => {
    const missing = RAW_DB_IMPORTERS.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)));
    expect(missing).toEqual([]);
  });

  it('is sorted and free of duplicates, so two PRs merge instead of colliding', () => {
    expect(RAW_DB_IMPORTERS).toEqual([...RAW_DB_IMPORTERS].sort());
    expect(new Set(RAW_DB_IMPORTERS).size).toBe(RAW_DB_IMPORTERS.length);
  });
});
