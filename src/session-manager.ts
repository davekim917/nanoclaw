/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import { AsyncLocalStorage } from 'async_hooks';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { assertChannelRoutingConsistency } from './delivery.js';
import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { stripPlatformMessageId, withoutHostFields, withPlatformMessageId } from './host-origin.js';
import { acquireStorageActivityLease } from './storage-activity.js';
import { evaluateGuardSync, withCentralSync } from './db/central-lease.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { resolveSessionServicesCentral, type SessionServicesCentral } from './capabilities.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import {
  createSession,
  findSystemSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  setTaskRoutingPlatformId,
  taskThreadId,
  updateSession,
} from './db/sessions.js';
import { insertOrAdopt } from './db/insert-or-adopt.js';
import { getAgentMailbox } from './mailbox/index.js';
import type { MailboxSession, MailboxSessionKey } from './mailbox/types.js';
// The host's registered implementation is NanoclawAgentMailbox, so every
// session() here hands the action the fork's narrowed session (plan §4.2).
// Typing the helpers with it is what lets a caller reach a fork op without a
// cast; an action written against upstream's narrower `MailboxSession` is
// still accepted, since the parameter only widens.
import {
  sessionMailboxPath,
  type MessageInsert,
  type NanoclawMailboxSession,
  type ProviderRecallState,
} from './modules/mailbox/index.js';
import { log } from './log.js';
import { buildPreTurnContext } from './modules/memory/pre-turn-context.js';
import type { Session, SessionMode } from './types.js';
import { taskFiresFresh } from './modules/scheduling/fresh-context.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Host-owned runner context, kept outside the agent-writable session directory. */
export function sessionContextPath(agentGroupId: string, sessionId: string): string {
  return sessionContextPathFor(sessionDir(agentGroupId, sessionId));
}

/**
 * The same path, derived from a session DIRECTORY rather than from DATA_DIR.
 *
 * The storage reclaim walks an injected sessions root, so it cannot go through
 * `sessionContextPath`. One definition of the layout keeps the two from
 * drifting — and they must not: the context file is a SIBLING of the session
 * directory, so removing that directory does not take it, and a reclaim that
 * misses it leaks one file per session forever.
 */
export function sessionContextPathFor(sessionPath: string): string {
  return path.join(path.dirname(sessionPath), '.context', `${path.basename(sessionPath)}.json`);
}

/**
 * Materialize the immutable context the runner receives at startup.
 *
 * The container READS this file and runs as a different UID than the host, so
 * it takes the mode of `inbound.db` and its directory the mode of the session
 * dir — the file and directory the container already reads today. Upstream's
 * 0700/0600 would be unreadable inside the container on any install whose
 * image UID differs from the host's, which is every install where
 * `buildContainerArgs` omits `--user`. Safe by upstream's own contract:
 * `runnerContext` is non-secret runner configuration, never credentials.
 */
export function writeSessionContext(agentGroupId: string, sessionId: string, mailbox: unknown): void {
  const contextPath = sessionContextPath(agentGroupId, sessionId);
  const fileMode = existingMode(sessionMailboxPath({ agentGroupId, sessionId }, 'inbound'), 0o644);
  const dirMode = existingMode(sessionDir(agentGroupId, sessionId), 0o755);
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.chmodSync(path.dirname(contextPath), dirMode);
  fs.writeFileSync(contextPath, JSON.stringify({ agentGroupId, sessionId, mailbox }));
  fs.chmodSync(contextPath, fileMode);
}

/** Mode bits of an existing path, or `fallback` when it is not there yet. */
function existingMode(target: string, fallback: number): number {
  try {
    return fs.statSync(target).mode & 0o777;
  } catch {
    return fallback;
  }
}

function mailboxKey(agentGroupId: string, sessionId: string): MailboxSessionKey {
  return { agentGroupId, sessionId };
}

/** Root directory for all thread-scoped worktrees. */
export function threadsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-threads');
}

/**
 * Sanitize a thread-id (or messaging-group-id) into a filesystem-safe slug.
 * Slack uses `1234567890.123456` (period), Discord uses `123456789012345678`
 * (digits), and platform-internal ids may have other separators. Keep it
 * minimal — replace anything not [A-Za-z0-9._-] with `_`.
 */
function fsSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Thread-scoped worktree directory. All sibling agents in the same thread
 * (e.g. helper + helper-codex) bind-mount this same host path at
 * `/workspace/worktrees` inside their containers so they collaborate on
 * the same checkout.
 *
 * Key derivation: `<thread-id>` (preferred) or `dm-<platform-id>` fallback.
 * Slack thread ids encode `slack:<channel>:<ts>` and Discord encodes
 * `discord:<guild>:<channel>:<thread>` — both globally unique, including
 * the platform prefix. So just using the thread_id alone is enough.
 *
 * For DM / non-threaded channels (thread_id=null), `dm-<platform_id>` keeps
 * the dir stable per conversation. Critically, when TWO sibling agents are
 * wired to the same channel via TWO Slack apps (`slack-example-labs` +
 * `slack-helpercodex` both seeing `slack:CTEST00004`), they share the same
 * platform_id and therefore the same worktree path — that's what makes
 * cross-bot collaboration work.
 *
 * Nested dirs (not a flat `<mg>:<thread>` key) because Docker's `-v` flag
 * uses `:` as the field separator between source:target:options. A colon in
 * the host path turns `-v src:dst` into a three-part `src:dst:opts` which
 * Docker rejects with exit 125. fsSlug strips any embedded colons too.
 */
export function threadWorktreeDir(platformId: string, threadId: string | null, workgroupId?: string): string {
  return path.join(threadStateDir(platformId, threadId, workgroupId), 'worktrees');
}

/**
 * Workgroup-namespaced thread-state base dir.
 *
 * The platform/thread key alone is ambiguous across workgroups: an identical
 * platform_id can be the same real channel via a sibling bot app (same
 * workgroup — must share) or an unrelated channel from a colliding workspace
 * (different workgroup — must NOT share; see the getChannelPeers
 * tenant-boundary tests). Adding the workgroup segment makes cross-workgroup
 * rows resolve to different directories while same-workgroup siblings keep
 * sharing.
 *
 * Legacy fallback: pre-namespace threads live at `<base>/<tid>/`. If that
 * dir exists and no workgroup-scoped dir does, keep serving it so in-flight
 * threads don't lose their worktrees on upgrade; the repo-store migration
 * relocates them and ends the fallback window.
 */
function threadStateDir(platformId: string, threadId: string | null, workgroupId?: string): string {
  const tid = threadId ?? `dm-${platformId}`;
  const legacy = path.join(threadsBaseDir(), fsSlug(tid));
  if (!workgroupId) return legacy;
  const scoped = path.join(threadsBaseDir(), `wg-${fsSlug(workgroupId)}`, fsSlug(tid));
  if (fs.existsSync(legacy) && !fs.existsSync(scoped)) {
    // Ownership check: without it, workgroup B would adopt workgroup A's
    // legacy dir on a colliding platform/thread key — the exact leak the
    // namespace exists to prevent. The marker is stamped by container spawn
    // (buildMounts) on first post-upgrade use; an unstamped dir is adoptable.
    const owner = readThreadDirOwner(legacy);
    if (owner === null || owner === workgroupId) return legacy;
  }
  return scoped;
}

const THREAD_DIR_OWNER_FILE = '.wg-owner';

/** The pre-namespace state dir for a thread key (exists only for threads
 *  created before the wg namespace or not yet migrated). */
export function legacyThreadStateDir(platformId: string, threadId: string | null): string {
  const tid = threadId ?? `dm-${platformId}`;
  return path.join(threadsBaseDir(), fsSlug(tid));
}

/**
 * Sentinel owner that matches no real workgroup id (real ids never contain
 * spaces). Stamped when DB ownership of a legacy dir is ambiguous — every
 * workgroup then resolves to its own scoped dir and nobody adopts.
 */
export const THREAD_DIR_OWNER_CONFLICT = '!! conflict';

export function readThreadDirOwner(stateDir: string): string | null {
  try {
    return fs.readFileSync(path.join(stateDir, THREAD_DIR_OWNER_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Stamp workgroup ownership on a thread-state dir (idempotent, creator-only). */
export function stampThreadDirOwner(stateDir: string, workgroupId: string): void {
  const file = path.join(stateDir, THREAD_DIR_OWNER_FILE);
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${workgroupId}\n`);
  } catch {
    /* advisory marker — never block a spawn on it */
  }
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/**
 * Claude Code's project-dir name hash for the container cwd. v2's cwd is
 * `/workspace/agent` (set in container/agent-runner/src/index.ts:42 as `CWD`
 * and passed to the SDK via poll-loop), which hashes to `-workspace-agent`.
 * v1 used `/workspace/group` → `-workspace-group`; do not copy-paste that
 * constant without verifying the current cwd. If the cwd ever changes,
 * regenerate by launching claude-code once in the new cwd and reading the
 * created `~/.claude/projects/<dir>/` name.
 */
export const CLAUDE_CODE_PROJECTS_DIR = '-workspace-agent';

/**
 * Per-session `projects/<hash>/` dir on the host. Mounted INTO each container's
 * `/home/node/.claude/projects/<hash>/` as a nested bind mount on top of the
 * group-shared `.claude` parent. Isolates the SDK's per-session state —
 * `<session_id>.jsonl` transcripts, `sessions-index.json`, and any other files
 * the SDK writes under its active project dir — so concurrent sessions in the
 * same agent group don't race and silently clobber each other's resume state.
 */
export function sessionClaudeProjectsDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.claude-projects', CLAUDE_CODE_PROJECTS_DIR);
}

/**
 * Recognized legacy Claude-native memory source for this agent group.
 *
 * `/migrate-memory` inventories this path and, after verified cutover, replaces
 * it with a compatibility view of the workgroup canon. It is never a separate
 * runtime memory authority.
 */
export function groupClaudeMemoryDir(agentGroupId: string): string {
  return path.join(
    DATA_DIR,
    'v2-sessions',
    agentGroupId,
    '.claude-shared',
    'projects',
    CLAUDE_CODE_PROJECTS_DIR,
    'memory',
  );
}

/**
 * Pre-create the per-session `projects/<hash>/` dir on the host with uid 1001
 * ownership BEFORE docker mounts it.
 *
 * This is load-bearing — v1 learned it the hard way (comment at v1
 * container-runner.ts:1675-1681). The parent `/home/node/.claude` is a bind
 * mount; if the inner `projects/<hash>/` path doesn't already exist on the host
 * when docker starts the container, the daemon creates the missing
 * intermediates AS ROOT. The container runs as uid 1001 and can't write inside
 * a root-owned dir, so SDK session jsonls appear to save in-memory but vanish
 * on exit. The next `resume: <session_id>` then fails silently (no file found)
 * and the agent starts fresh with no prior context.
 *
 * chown is best-effort — on platforms that can't chown (or when the process
 * isn't root) we log and continue; the subsequent write attempt will fail
 * loudly if ownership is wrong, which beats the silent-amnesia failure mode.
 */
export function prepareSessionClaudeDir(agentGroupId: string, sessionId: string): void {
  const projectsDir = sessionClaudeProjectsDir(agentGroupId, sessionId);
  fs.mkdirSync(projectsDir, { recursive: true });
  const memoryDir = groupClaudeMemoryDir(agentGroupId);
  fs.mkdirSync(memoryDir, { recursive: true });

  // Creates dirs and copies NOTHING. Do not reintroduce a copy from the
  // group-shared `.claude-shared/projects/<hash>/` dir.
  //
  // Until 2026-08-20 this function migrated forward from the pre-per-session
  // layout, where every session in a group wrote its transcripts into that one
  // shared dir. The copy was deliberately unfiltered — session ownership of a
  // given `.jsonl` cannot be recovered from the filename, because the SDK's
  // sdk_session_id diverges from the on-disk name after compact-boundary
  // rotations — and that is the detail that made it look load-bearing at a
  // glance and kept it alive this long.
  //
  // It was dead. The shared dirs stopped being written on 2026-04-21, and zero
  // sessions in the central DB were created before that date, so the migration
  // had no beneficiaries left and the source can never be replenished. What it
  // did have was a cost: ~9MB of transcripts no session owned, copied into
  // every session that ever spawned, ~23GB across this install.

  try {
    fs.chownSync(projectsDir, 1001, 1001);
    fs.chownSync(path.dirname(projectsDir), 1001, 1001);
    fs.chownSync(memoryDir, 1001, 1001);
  } catch (err) {
    log.debug('Could not chown session .claude dir to uid 1001 — continuing', {
      agentGroupId,
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export async function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: SessionMode,
): Promise<{ session: Session; created: boolean }> {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = await findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = await findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  // Agent-shared sessions have no mg binding by definition — they're the
  // single session shared across all messaging groups for this agent. Force
  // null on creation so findSessionByAgentGroup's `messaging_group_id IS
  // NULL` lookup re-finds them on subsequent calls (and so foreign-mg
  // callers don't accidentally treat them as "their" mg session).
  const sessionMessagingGroupId = sessionMode === 'agent-shared' ? null : messagingGroupId;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: sessionMessagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  // The lookup above yields (async driver), so two concurrent first messages
  // for the same target can both see no session and both insert; the unique
  // active-session index lets exactly one win and the loser adopts it. `reload`
  // repeats the exact lookup this function opened with.
  const { row: resolved, created } = await insertOrAdopt(session, createSession, () =>
    sessionMode === 'agent-shared'
      ? findSessionByAgentGroup(agentGroupId)
      : messagingGroupId
        ? findSessionForAgent(agentGroupId, messagingGroupId, sessionMode === 'shared' ? null : threadId)
        : Promise.resolve(undefined),
  );
  if (!created) return { session: resolved, created: false };
  initSessionFolder(agentGroupId, id);
  log.info('Session created', {
    id,
    agentGroupId,
    messagingGroupId: sessionMessagingGroupId,
    threadId: lookupThreadId,
    sessionMode,
  });

  return { session, created: true };
}

/** Find or create the per-agent-group session used for scheduled tasks. */
/**
 * Find or create the isolated session for one task series (thread
 * `system:tasks:<seriesId>`).
 *
 * `routingPlatformId` is the series' ROUTING STAMP — the
 * `messaging_groups.platform_id` this task was scheduled against, which the
 * `ncl tasks` surface documents as "where an unaddressed reply lands". Callers
 * that hold it (the two sites that write the task's `messages_in` row with the
 * same `platform_id`: `createTask` in `src/cli/resources/tasks.ts` and
 * `scheduleTask` in `src/db/scheduled-tasks.ts`) pass it so the console can
 * show a task in the channel it is routed to instead of an "Unrouted tasks"
 * bucket. Callers with no routing (`--isolated`, a host caller with no
 * `--messaging-group`, `createScheduledTask`'s template path) pass nothing and
 * the column stays NULL — absent is honest.
 *
 * `messaging_group_id` stays NULL and MUST stay NULL. It is the discriminator
 * `src/delivery.ts` uses to recognize a task session (`task_log` run-log
 * appends, `isTaskSessionPost`); the routing stamp is a separate column
 * precisely so this one is never tempted into carrying it. See migration 056.
 */
export async function resolveTaskSession(
  agentGroupId: string,
  seriesId: string,
  routingPlatformId?: string | null,
): Promise<{ session: Session; created: boolean }> {
  const threadId = taskThreadId(seriesId);
  const existing = await findSystemSession(agentGroupId, threadId);
  if (existing) {
    // Re-scheduling an existing series (including `scheduled-move`, which
    // re-`scheduleTask`s into the target) re-stamps: the column answers "where
    // is this series routed NOW", not "where was it first routed".
    if (routingPlatformId != null && existing.task_routing_platform_id !== routingPlatformId) {
      await setTaskRoutingPlatformId(existing.id, routingPlatformId);
      existing.task_routing_platform_id = routingPlatformId;
    }
    return { session: existing, created: false };
  }

  const id = generateId();
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  // Same race as `resolveSession`: two scheduling operations on one series can
  // both yield at the lookup; the unique active-session index lets one insert
  // win, and the loser adopts it.
  const { row: resolved, created } = await insertOrAdopt(session, createSession, () =>
    findSystemSession(agentGroupId, threadId),
  );
  if (!created) {
    // Re-stamp the adopted winner exactly as the cache-hit branch above does —
    // the column answers "where is this series routed NOW".
    if (routingPlatformId != null && resolved.task_routing_platform_id !== routingPlatformId) {
      await setTaskRoutingPlatformId(resolved.id, routingPlatformId);
      resolved.task_routing_platform_id = routingPlatformId;
    }
    return { session: resolved, created: false };
  }
  if (routingPlatformId != null) {
    await setTaskRoutingPlatformId(id, routingPlatformId);
    session.task_routing_platform_id = routingPlatformId;
  }
  initSessionFolder(agentGroupId, id);
  log.info('Task session created', { id, agentGroupId, seriesId, routingPlatformId: routingPlatformId ?? null });

  return { session, created: true };
}

/**
 * Create the session folder and initialize both DBs.
 *
 * Deliberately does NOT call `prepareSessionClaudeDir` — the transcript copy
 * it performs belongs to the spawn path (`getSessionClaudeMounts`, called from
 * `buildMounts`), which already runs it before every container start. Sessions
 * are minted for non-waking accumulate traffic too, and copying the group's
 * whole shared transcript set into a session that never wakes cost 20GB on one
 * agent group. Both DBs are small and needed immediately for those writes.
 */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  // prepare() is the single provisioning path: it creates whichever mailbox
  // files are absent, with upstream's baseline schema plus the fork's tables,
  // columns, triggers and index. Legacy-shape migrations on an EXISTING file
  // run at that session's first session() instead, never here.
  getAgentMailbox().prepare(mailboxKey(agentGroupId, sessionId));
}

/** Destroy one session's implementation-owned mailbox after its container stops. */
export async function destroySessionMailbox(agentGroupId: string, sessionId: string): Promise<void> {
  await getAgentMailbox().destroy(mailboxKey(agentGroupId, sessionId));
  fs.rmSync(sessionContextPath(agentGroupId, sessionId), { force: true });
}

/**
 * Detects same-key session() nesting, which is forbidden: implementations may
 * serialize session() per key, so a nested call may deadlock. Tracked per async context so
 * legitimately concurrent top-level sessions on the same key don't trip it.
 */
const activeMailboxKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** Run one host operation against a session mailbox. The implementation owns persistence.
 *
 * Never call this (directly or via helpers like writeSessionMessage) from
 * inside another withMailboxSession action on the same session — finish the
 * open session first. See AgentMailbox.session in src/mailbox/types.ts.
 */
export function withMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
): Promise<T> {
  return runMailboxSession(agentGroupId, sessionId, action, true) as Promise<T>;
}

/**
 * Test-only: how many mailbox sessions the CURRENT async context holds open.
 *
 * The nesting guard's own store, read rather than thrown on. Seam 2's R-10
 * asserts depth 0 at every `killContainer`/`wakeContainer` call site: a kill
 * respawns through `onExit` and clears status through `delivery.ts`, both of
 * which open a session on the same key, so holding one across it deadlocks
 * (invariant I-3). Asserting `ctx.mailbox === null` is not the same assertion —
 * a duty could open its own session and kill inside the callback.
 */
export function _mailboxSessionDepthForTesting(): number {
  return activeMailboxKeys.getStore()?.size ?? 0;
}

/** Run against an already-provisioned mailbox without creating storage. */
export function withExistingMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
): Promise<T | undefined> {
  return runMailboxSession(agentGroupId, sessionId, action, false);
}

async function runMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
  provision: boolean,
): Promise<T | undefined> {
  const store = getAgentMailbox();
  const key = mailboxKey(agentGroupId, sessionId);
  const keyId = `${agentGroupId}/${sessionId}`;
  const held = activeMailboxKeys.getStore();
  if (held?.has(keyId)) {
    throw new Error(`Nested mailbox session for ${keyId} — serialized implementations would deadlock here`);
  }
  if (provision) store.prepare(key);
  else if (!(await store.exists(key))) return undefined;
  return activeMailboxKeys.run(new Set(held).add(keyId), () =>
    // One cast, here and nowhere else. `mailbox/compose.ts` registers
    // NanoclawAgentMailbox, whose session() hands the action the fork's
    // narrowed session; upstream's `AgentMailbox` interface can only promise
    // the narrower `MailboxSession`, and TypeScript checks that parameter
    // contravariantly. A different implementation registered here would break
    // this, which is exactly what `compose.ts` being the singular slot rules out.
    store.session(key, action as (mailbox: MailboxSession) => T | Promise<T>),
  );
}

/**
 * Write the current chat/thread routing for a session into its inbound.db.
 *
 * The container uses this to preserve thread_id when an explicitly named
 * destination resolves to the conversation this session is bound to.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export async function writeSessionRouting(agentGroupId: string, sessionId: string): Promise<void> {
  // Resolved INSIDE the session. The route is read from the central DB and the
  // funnel below yields before the upsert, so a session rewired or closed in
  // that window would otherwise be stamped with the route it had on entry.
  // The session read is a driver call and yields once; the upsert follows it
  // with no further yield. Routing has no write guard — a stale stamp is
  // refreshed on the next wake — so that yield is tolerable here where it is
  // not in `writeSessionMessage`.
  const resolveRoute = async (): Promise<
    { channelType: string | null; platformId: string | null; threadId: string | null } | undefined
  > => {
    const session = await getSession(sessionId);
    if (!session) return undefined;

    let channelType: string | null = null;
    let platformId: string | null = null;
    if (session.messaging_group_id) {
      const mg = await getMessagingGroup(session.messaging_group_id);
      if (mg) {
        channelType = mg.channel_type;
        platformId = mg.platform_id;
      }
    }

    assertChannelRoutingConsistency({ channelType, platformId });
    return { channelType, platformId, threadId: session.thread_id };
  };

  // Cheap short-circuit: a session that is already gone needs no mailbox
  // opened. The authoritative read is the one inside the callback.
  if (!(await resolveRoute())) return;

  // Existing-only. Routing is refreshed on every wake, and a session whose
  // mailbox is gone has nothing to route to; provisioning one here would
  // resurrect a reclaimed directory (invariant I-10). The old code expressed
  // the same rule as an existsSync on inbound.db.
  const written = await withExistingMailboxSession(agentGroupId, sessionId, async (mailbox) => {
    const route = await resolveRoute();
    if (!route) return undefined;
    mailbox.upsertSessionRouting({
      channel_type: route.channelType,
      platform_id: route.platformId,
      thread_id: route.threadId,
      session_id: sessionId,
      // spawn_task_id intentionally omitted — preserved via COALESCE on conflict
    });
    return route;
  });
  if (!written) return;
  log.debug('Session routing written', {
    sessionId,
    channelType: written.channelType,
    platformId: written.platformId,
    threadId: written.threadId,
  });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export interface SessionMessageInput {
  id: string;
  kind: string;
  timestamp: string;
  platformId?: string | null;
  channelType?: string | null;
  /** Trusted central-DB route identity; needed because agent-shared sessions intentionally persist no MG binding. */
  messagingGroupId?: string | null;
  threadId?: string | null;
  content: string;
  processAfter?: string | null;
  recurrence?: string | null;
  /**
   * 1 = this message should wake the agent (the default); 0 = accumulate
   * as context only, don't wake. Host's countDueMessages gates on this
   * column; the container still reads all prior messages as context when
   * a trigger-1 message does arrive.
   */
  trigger?: 0 | 1;
  /**
   * For agent-to-agent inbound: the source session id that emitted the
   * outbound message which became this inbound row. Used as the return
   * path so the target's reply routes back to that exact session.
   */
  sourceSessionId?: string | null;
  /**
   * 1 = only deliver on the container's first poll (fresh start).
   * Dying containers (past first poll) skip these rows.
   */
  onWake?: 0 | 1;
}

function latestUserText(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string') text = parsed.text;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Plain-text content is valid.
  }
  const marker = '[Latest message]\n';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex !== -1) text = text.slice(markerIndex + marker.length);
  let previous: string;
  do {
    previous = text;
    text = text.replace(/^\s*<@[!&]?[\w-]+(\|[^>]*)?>\s*/, '');
    text = text.replace(/^\s*@[\w-]+\s+/, '');
  } while (previous !== text);
  return text.trim();
}

/** Host equivalent of the runner's `isAdmissibleTrigger`. */
export function isAdmissiblePreTurnTrigger(message: SessionMessageInput): boolean {
  if ((message.trigger ?? 1) !== 1) return false;
  if (message.kind === 'system') return false;
  if (
    (message.kind === 'chat' || message.kind === 'chat-sdk') &&
    latestUserText(message.content).toLocaleLowerCase('en-US').startsWith('/clear')
  ) {
    return false;
  }
  return true;
}

/**
 * The four recall reads a pre-turn context is built from.
 *
 * Every caller now passes its open `NanoclawMailboxSession`, which satisfies
 * this structurally. It is still named rather than taking the whole session
 * type, because these four are the entire dependency the recall builder has —
 * and saying so is what keeps a fifth from being reached for by accident.
 */
interface RecallSource {
  readProviderRecallState(provider: string): ProviderRecallState;
  listOpenChatContents(): Array<{ content: string }>;
  listRecentRecallRows(limit: number): Array<{ id: string; status: string; content: string }>;
  hasMatchingBootstrapRecall(excludeRecallId: string | null, provider: string, contextEpoch: number): boolean;
}

/**
 * The one central-DB fact a recall row needs: which provider's bootstrap and
 * epoch the pair is built for. Resolved by the caller BEFORE it opens the
 * mailbox session, so the recall build and the paired insert stay one
 * synchronous block — the write guard is proved immediately before the row
 * lands, with nothing awaited in between (seam-3 plan §4.5). A provider read a
 * few milliseconds earlier is the same value the block used to read inline:
 * provider changes take effect at the group's next restart, not mid-write.
 */
export interface RecallCentral {
  provider: string;
  services: SessionServicesCentral;
}

export async function resolveRecallCentral(agentGroupId: string, sessionId: string): Promise<RecallCentral> {
  const session = await getSession(sessionId);
  return {
    provider: resolveProviderName(session?.agent_provider, (await getContainerConfig(agentGroupId))?.provider),
    services: await resolveSessionServicesCentral(agentGroupId),
  };
}

function buildRecallRow(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  normalizedContent: string,
  mailbox: RecallSource,
  central: RecallCentral,
): MessageInsert | null {
  if (!isAdmissiblePreTurnTrigger({ ...message, content: normalizedContent })) return null;
  // A scheduled fire that starts fresh resets the provider before it is prompted, like a queued /clear.
  const resetPending = message.kind === 'task' && taskFiresFresh(normalizedContent);
  const lifecycle = resolveRecallLifecycle(
    mailbox,
    agentGroupId,
    sessionId,
    central.provider,
    `recall-${message.id}`,
    resetPending,
  );
  return {
    id: `recall-${message.id}`,
    kind: 'system',
    timestamp: message.timestamp,
    platformId: message.platformId ?? null,
    channelType: message.channelType ?? null,
    threadId: message.threadId ?? null,
    content: JSON.stringify({
      subtype: 'recall_context',
      ...buildPreTurnContext({
        agentGroupId,
        sessionId,
        messagingGroupId: message.messagingGroupId,
        threadId: message.threadId,
        kind: message.kind,
        trigger: message.trigger ?? 1,
        normalizedContent,
        provider: lifecycle.provider,
        contextEpoch: lifecycle.contextEpoch,
        includeBootstrap: lifecycle.includeBootstrap,
        seenEvidenceFingerprints: lifecycle.seenEvidenceFingerprints,
        servicesCentral: central.services,
      }),
    }),
    processAfter: message.processAfter ?? null,
    recurrence: null,
    trigger: 0,
    sourceSessionId: message.sourceSessionId ?? null,
    onWake: message.onWake ?? 0,
  };
}

interface ParsedRecallContext {
  provider?: unknown;
  contextEpoch?: unknown;
  trustedCapabilities?: unknown;
  memoryEvidence?: {
    core?: Array<{ fingerprint?: unknown }>;
    excerpts?: Array<{ fingerprint?: unknown }>;
  };
  conversationEvidence?: {
    excerpts?: Array<{ fingerprint?: unknown }>;
  };
}

interface RecallLifecycle {
  provider: string;
  contextEpoch: number;
  includeBootstrap: boolean;
  seenEvidenceFingerprints: string[];
}

function parseRecallContext(content: string): ParsedRecallContext | null {
  try {
    const parsed = JSON.parse(content) as ParsedRecallContext & { subtype?: unknown };
    return parsed && parsed.subtype === 'recall_context' ? parsed : null;
  } catch {
    return null;
  }
}

function recallFingerprints(context: ParsedRecallContext): string[] {
  const rows = [
    ...(context.memoryEvidence?.core ?? []),
    ...(context.memoryEvidence?.excerpts ?? []),
    ...(context.conversationEvidence?.excerpts ?? []),
  ];
  return rows
    .map((row) => row.fingerprint)
    .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string' && fingerprint.length > 0);
}

/**
 * Resolve bootstrap/delta state from the existing provider continuation and
 * recall rows. This is deliberately bounded and adds no lifecycle ledger.
 */
function resolveRecallLifecycle(
  mailbox: RecallSource,
  agentGroupId: string,
  sessionId: string,
  provider: string,
  excludeRecallId?: string,
  resetPending = false,
): RecallLifecycle {
  let contextEpoch = 0;
  let hasContinuation = false;
  try {
    // Reached through the session's own outbound handle now, not a second
    // open of the same file. The catch is unchanged and load-bearing: an
    // unreadable outbound.db means "admit a fresh bootstrap", never a throw
    // that would drop the inbound message.
    ({ contextEpoch, hasContinuation } = mailbox.readProviderRecallState(provider));
  } catch (error) {
    log.warn('Unable to read provider recall lifecycle; admitting a fresh bootstrap', {
      agentGroupId,
      sessionId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A /clear already queued ahead of this message will reset the provider
  // before the message is prompted. The runner owns the epoch write, so the
  // host cannot observe that future epoch yet; treat the pending boundary as
  // fresh now so same-batch follow-ups carry full canon and unsuppressed
  // relevant evidence into the reset context.
  const pendingClear =
    resetPending ||
    mailbox
      .listOpenChatContents()
      .some((row) => latestUserText(row.content).toLocaleLowerCase('en-US').startsWith('/clear'));
  if (pendingClear) hasContinuation = false;

  const rows = mailbox.listRecentRecallRows(256);
  const bootstrapAlreadyQueuedOrDelivered =
    !pendingClear && mailbox.hasMatchingBootstrapRecall(excludeRecallId ?? null, provider, contextEpoch);
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.id === excludeRecallId) continue;
    const parsed = parseRecallContext(row.content);
    if (!parsed || parsed.provider !== provider || parsed.contextEpoch !== contextEpoch) {
      continue;
    }
    if (hasContinuation && (row.status === 'completed' || row.status === 'processing')) {
      for (const fingerprint of recallFingerprints(parsed)) seen.add(fingerprint);
    }
  }

  return {
    provider,
    contextEpoch,
    includeBootstrap: !bootstrapAlreadyQueuedOrDelivered,
    seenEvidenceFingerprints: [...seen],
  };
}

/** Read-only replay guard used before router side effects. */
export async function sessionMessageExists(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  // A read, so existing-only: no mailbox means the message is provably not
  // there, and a replay guard must never be the thing that creates a session.
  return (
    (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.inboundHasMessage(messageId))) ??
    false
  );
}

/**
 * A caller's precondition, handed to the WRITER so the writer can prove it.
 *
 * `true` proceeds; `false` or `{ ok: false, reason }` refuses and nothing is
 * written. Must be synchronous — that is the entire point. The writer calls it
 * inside the mailbox action, after every await it performs, with no await
 * between the call and the insert. An async guard would reintroduce exactly the
 * window it exists to close.
 */
export type WriteGuardResult = boolean | { ok: false; reason: string };
export type WriteGuard = () => WriteGuardResult;

export interface WriteSessionMessageOptions {
  /**
   * Re-proved by the writer immediately before the insert.
   *
   * Callers used to prove their preconditions themselves and then call this
   * function, which awaits — `acquireStorageActivityLease`, the reclaim-journal
   * import, both mailbox funnels — before the row lands. Every one of those is
   * a window in which the proof goes stale, and no amount of care at the call
   * site can close a window inside the callee. So the proof moves to where the
   * write is.
   */
  guard?: WriteGuard;
  /**
   * Keep the host-only `origin` and `event` fields in the content. Every other
   * chat write has them removed (withoutHostFields), so the runner's `origin="host"`
   * and `event="..."` markers (container/agent-runner/src/formatter.ts) can only
   * come from the host's own notes: a person or a peer agent controls `sender`
   * and `senderId` in content they author, but never a field that survives this
   * writer. The one caller is notifyAgent (modules/approvals/primitive.ts).
   */
  hostOrigin?: boolean;
  /**
   * The platform-native id of the specific inbound message this write
   * represents (e.g. a Slack `ts`). Stamped into content as PLATFORM_MSG_ID_FIELD
   * (host-origin.ts) so the runner can render `platform_msg_id` on it — but
   * only for this call: every write, regardless of this option, first strips
   * any `platformMsgId` the caller's own content already carries
   * (stripPlatformMessageId), so a chat write can never forge or echo one.
   * The one caller is the router's own routed-message write (router.ts),
   * which is the sole place that knows the id is genuine.
   */
  platformMessageId?: string;
}

/** Thrown when a write's guard refuses at the last instant. No row is written. */
export class SessionWriteRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`session write refused: ${reason}`);
    this.name = 'SessionWriteRefusedError';
  }
}

/**
 * Evaluate a guard and normalize its answer.
 *
 * Called ONLY from inside a `withCentralSync` block — the one wrapping the
 * mailbox insert action, with nothing awaited between here and the insert,
 * and the pre-extract ask. `evaluateGuardSync` is the runtime half of the
 * guard contract (seam 3 §4.5 I-1): a guard that hands back a promise — cast,
 * or accidentally `async` — is a contract violation, not a verdict, and it is
 * reported as a refusal so the caller's `SessionWriteRefusedError` contract
 * ("nothing was written") holds for it too.
 */
function refusalFrom(guard: WriteGuard | undefined): string | null {
  if (!guard) return null;
  let verdict: WriteGuardResult;
  try {
    verdict = evaluateGuardSync(guard);
  } catch (err) {
    // A THROWN guard is a refusal. Letting it propagate out of the mailbox
    // action would surface as the funnel's own error rather than a refusal,
    // and the caller's contract — `SessionWriteRefusedError` means nothing was
    // written — would be silently unavailable for the one case where the
    // precondition could not even be evaluated. A guard that cannot answer has
    // not said yes.
    return `guard threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (verdict === true) return null;
  if (verdict === false) return 'guard refused';
  return verdict.reason;
}

export async function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  options: WriteSessionMessageOptions = {},
): Promise<void> {
  await writeSessionMessageInternal(
    agentGroupId,
    sessionId,
    message,
    false,
    options.guard,
    options.hostOrigin === true,
    options.platformMessageId,
  );
}

/** Idempotent channel-ingress variant; false means this platform id was already routed. */
export async function writeSessionMessageIfNew(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  options: WriteSessionMessageOptions = {},
): Promise<boolean> {
  return writeSessionMessageInternal(
    agentGroupId,
    sessionId,
    message,
    true,
    options.guard,
    options.hostOrigin === true,
    options.platformMessageId,
  );
}

async function writeSessionMessageInternal(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  ignoreDuplicateId: boolean,
  guard: WriteGuard | undefined,
  hostOrigin: boolean,
  platformMessageId: string | undefined,
): Promise<boolean> {
  // A session mid-archival is about to lose its directory. Re-provisioning it
  // below would resurrect the dir seconds before the reclaim removes it, and
  // the message would vanish with it. Ordinary routing never gets here —
  // findSessionForAgent filters status='active' — so this only fires on a
  // raw-session-id path, and it must be loud rather than silent.
  const statusBefore = (await getSession(sessionId))?.status;
  if (statusBefore === 'archiving') {
    throw new Error(`session ${sessionId} is being archived; route this message to a fresh session`);
  }

  // The check above is a read, so on its own it loses the write-after-check
  // race: a writer that has passed it and opened inbound.db but not yet
  // written produces NO observable signal — no unconsumed row, no mtime change
  // — so the reclaim's open-work and mtime-equality guards both see a quiet
  // session, archive it, and rmSync the directory out from under the open fd.
  // The insert then lands in an unlinked inode: accepted, acknowledged, and
  // absent from the rescue archive.
  //
  // The storage-activity lease is the existing two-sided lock for exactly this
  // (`storage-activity.ts`): the reclaim runs its whole archive-and-delete
  // inside tryRunWithStorageCleanupClaim, which refuses to act while any
  // activity marker is present, and acquire double-checks the claim after
  // planting its marker. Either the reclaim sees our marker and skips, or we
  // see its claim and wait for it to finish.
  const lease = await acquireStorageActivityLease(sessionDir(agentGroupId, sessionId), `inbound-${sessionId}`);
  try {
    return await writeSessionMessageLocked(
      agentGroupId,
      sessionId,
      message,
      ignoreDuplicateId,
      guard,
      hostOrigin,
      platformMessageId,
    );
  } finally {
    await lease.release();
  }
}

async function writeSessionMessageLocked(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  ignoreDuplicateId: boolean,
  guard: WriteGuard | undefined,
  hostOrigin: boolean,
  platformMessageId: string | undefined,
): Promise<boolean> {
  // Waiting for the claim above can mean waiting out a reclaim that archived
  // and deleted this session while we queued. Re-provisioning it here would
  // resurrect a session nothing polls, so this has to be decided AFTER the
  // wait — and it has to be decided from something a reclaim cannot fake.
  //
  // Three earlier attempts compared a property sampled before the wait against
  // the same property after it, and each was wrong in a different direction.
  // `status` equality passes when a session was already `closed` on arrival.
  // Adding directory existence refuses brand-new sessions. An `inbound.db`
  // existence flip misses `true -> false -> true`, and is blind when the file
  // was already absent at sample time. Neither field is an identity: a row is
  // `closed` for reasons other than reclaim — rotation closes the predecessor
  // of a lineage, and those rows may never have had a directory at all — and a
  // path can be deleted and recreated.
  //
  // The reclaim journal is the identity. It is appended, fsynced, before the
  // directory is removed, on every path that removes one, and no path removes
  // a line. A session id is never reused, so the answer only ever goes
  // false -> true, once. See `sessionWasReclaimed`.
  //
  // The line records the reclaim's INTENT, not its completion: it is written
  // at storage-manager.ts:1207, before the archiving->closed CAS at :1215,
  // and that CAS can fail — in which case :1221 logs and deliberately keeps
  // the directory ("removing it is not our call"). A crash before the rmSync
  // at :1230 leaves the same shape. So the line alone would brick a session
  // that is still live. inbound.db answers the second half — the reclaim
  // removes the whole directory, and nothing in the lease recreates that file
  // (the lease mkdirs only the session ROOT, which is why the root's
  // existence is useless here).
  //
  // Both terms are read now, once, from current state. Neither is a sample
  // compared against its own earlier value, which is what made status
  // equality, status+directory and the inbound.db flip fail in three
  // different directions. And the flip's ABA — a second writer re-provisioning
  // inside the window — is closed rather than papered over: the recreate it
  // needed was the old guard letting that second writer through to
  // `initSessionFolder` below. The only other in-process creator,
  // `initStubSessionFolder` (db/scheduled-tasks.ts:98), runs on a freshly
  // generated id. Remove the leak and the interleave has no producer.
  //
  // One composition is deliberate: a CAS-lost session that an operator THEN
  // `rm -rf`s satisfies both terms and is refused, even though a reset is
  // meant to re-provision. That is the honest answer — the rescue archive was
  // published before the CAS lost, so the content is kept, and refusing is
  // both the safe direction and a loud one.
  //
  // Not reclaimed and no directory means a brand-new session, a rotation
  // predecessor (deliberately `closed`, may never have had a directory), or
  // the documented operator `rm -rf`. All three re-provision below, as they
  // must.
  const { sessionWasReclaimed } = await import('./storage-manager.js');
  if (sessionWasReclaimed(sessionId) && !fs.existsSync(sessionMailboxPath({ agentGroupId, sessionId }, 'inbound'))) {
    throw new Error(`session ${sessionId} has been reclaimed; route this message to a fresh session`);
  }

  // Documented reset: operators `rm -rf` a session folder to clear a stuck
  // session. The sessions row survives, so the next message takes the
  // existing-session path and lands here with a missing inbound.db — the open
  // below would throw and the message would be logged-and-dropped forever.
  // Re-provision the folder + DBs (initSessionFolder is idempotent) so the
  // documented reset actually re-provisions instead of killing the chat.
  if (!fs.existsSync(sessionMailboxPath({ agentGroupId, sessionId }, 'inbound'))) {
    initSessionFolder(agentGroupId, sessionId);
  }

  // THE GUARD, ASKED BEFORE THE BYTES LAND TOO.
  //
  // `extractAttachmentFiles` below decodes inline base64 into the target
  // session's mounted `inbox`, which its container reads — so the extraction is
  // itself a delivery, and it happens before the mailbox action where the guard
  // used to run for the first time. A precondition already false here should
  // never write those bytes at all.
  //
  // Cheap to ask twice: the guard is synchronous by contract, and the second
  // ask inside the insert is the one that closes the window this function's own
  // awaits open. Under the lease, because the guard's reads are raw.
  const refusedBeforeExtract = await withCentralSync(() => refusalFrom(guard), 'write guard before extract');
  if (refusedBeforeExtract !== null) {
    log.warn('Session write refused by its guard before extracting attachments', {
      agentGroupId,
      sessionId,
      messageId: message.id,
      reason: refusedBeforeExtract,
    });
    throw new SessionWriteRefusedError(refusedBeforeExtract);
  }

  // Extract base64 attachment data, save to inbox, replace with file paths
  // The host-only fields survive only a host note (WriteSessionMessageOptions.hostOrigin).
  const strippedContent = hostOrigin ? message.content : withoutHostFields(message.content, message.kind);
  // platformMsgId has its own, independent trust rule (host-origin.ts):
  // stripped from whatever the caller's content claims, on every write
  // regardless of hostOrigin, then reapplied only when this write's own
  // caller passed platformMessageId explicitly.
  const withoutClaimedPlatformMsgId = stripPlatformMessageId(strippedContent, message.kind);
  const messageContent =
    platformMessageId !== undefined
      ? withPlatformMessageId(withoutClaimedPlatformMsgId, message.kind, platformMessageId)
      : withoutClaimedPlatformMsgId;
  const { content, writtenPaths } = extractAttachmentFiles(agentGroupId, sessionId, message.id, messageContent);

  // Scheduled occurrences are always inert until the due-time admission seam
  // builds current recall and flips them wakeable. Keep this invariant even if
  // a future caller uses the general session writer instead of insertTaskRow.
  const isScheduledTask = message.kind === 'task';
  const row = {
    id: message.id,
    kind: message.kind,
    timestamp: message.timestamp,
    platformId: message.platformId ?? null,
    channelType: message.channelType ?? null,
    threadId: message.threadId ?? null,
    content,
    processAfter: message.processAfter ?? null,
    recurrence: message.recurrence ?? null,
    trigger: isScheduledTask ? (0 as const) : (message.trigger ?? 1),
    sourceSessionId: message.sourceSessionId ?? null,
    onWake: message.onWake ?? 0,
  };
  // One session for the whole write: the recall lifecycle reads and the paired
  // insert are one logical step against this session's mailbox, and the pair
  // must be decided from the same snapshot the insert lands in.
  //
  // EXISTING-ONLY first, and that is the point. The provisioning funnel runs
  // `prepare()`, which runs `ensureSchema(..., 'outbound')` — it opens the
  // CONTAINER-owned outbound.db read-write and executes DDL. Routine ingress
  // runs while that container is live and writing the same file across the
  // mount, and pre-seam this path only ever opened inbound.db, so taking the
  // provisioning funnel per message made the host a second writer for no gain.
  //
  // Nothing is lost by skipping `prepare()` here. Both branches above already
  // provision explicitly when they must, so the mailbox exists by this line;
  // and the inbound repair `prepare()` would do is done by `session()` itself
  // on either funnel — the first touch of a path in a process runs upstream's
  // `migrateMessagesInTable` plus `ensureNanoclawInboundSchema`, which creates
  // and migrates `session_routing`. What is skipped is exactly the write to
  // the file the host does not own.
  //
  // The provisioning fallback is the reclaim race between the check above and
  // this open, and it keeps this path's behavior identical to what it replaced.
  //
  // Callers must not already hold a session on this key: both funnels throw on
  // same-key nesting. Every host caller was audited for this in the ingress
  // batch; delivery action handlers in particular run with no session open
  // (plan §4.5b, invariant I-9).
  // The recall's one central read happens here, with the other awaits, so the
  // action below never yields: the provider is data the pair is built for, not
  // a precondition the guard proves.
  const recallCentral = isScheduledTask ? null : await resolveRecallCentral(agentGroupId, sessionId);

  // THE GUARD POINT. Inside the mailbox action, after every await this function
  // performs — the storage-activity lease, the reclaim-journal import, the
  // provider read, the funnel's own open, the central lease — and with nothing
  // awaited between it and the insert below. A caller's precondition proved
  // out here is proved at the instant the row lands, which is the only instant
  // that matters. The block handed to `withCentralSync` is deliberately NOT
  // async: the funnel admits promises, and a yield between the guard and the
  // insert would reopen exactly the window this closes — `withCentralSync`
  // refuses a promise-returning block at runtime, and
  // `src/db/central-lease.test.ts` pins that no `await` sits between
  // `evaluateGuardSync` and the insert inside it.
  //
  // The lease is taken AROUND the mailbox action, not inside it (plan §4.1):
  // the guard's reads are raw, and the lease is what keeps them out of an
  // open driver transaction. A sync block never has to REFUSE a legitimate
  // write because a transaction happened to be open — it waits its turn.
  //
  // The refusal is carried out rather than thrown from inside the action: the
  // mailbox session should close normally, and the caller's error is raised
  // once, after it does.
  let refusedReason: string | null = null;
  const insertUnderLease = (mailbox: NanoclawMailboxSession): boolean => {
    refusedReason = refusalFrom(guard);
    if (refusedReason !== null) return false;
    const recallRow =
      recallCentral === null ? null : buildRecallRow(agentGroupId, sessionId, message, content, mailbox, recallCentral);
    if (ignoreDuplicateId) return mailbox.insertMessageWithContextIfNew(row, recallRow);
    mailbox.insertMessageWithContext(row, recallRow);
    return true;
  };
  const insert = (mailbox: NanoclawMailboxSession): Promise<boolean> =>
    withCentralSync(() => insertUnderLease(mailbox), 'writeSessionMessage insert');
  const inserted =
    (await withExistingMailboxSession(agentGroupId, sessionId, insert)) ??
    (await withMailboxSession(agentGroupId, sessionId, insert));

  // A refusal is loud. `void` has no room for a result, and a silent return
  // would let a caller that forgets to check believe it wrote — the dangerous
  // default. Every existing caller already treats a failed write as an
  // exception, so this composes with what they do today.
  if (refusedReason !== null) {
    // The bytes went in before this point, so the refusal has something to
    // undo. The caller's own cleanup cannot reach these — it knows only the
    // files it forwarded, not the ones decoded from inline `data` here.
    removeExtractedAttachments(writtenPaths);
    log.warn('Session write refused by its guard at the insert', {
      agentGroupId,
      sessionId,
      messageId: message.id,
      reason: refusedReason,
    });
    throw new SessionWriteRefusedError(refusedReason);
  }

  if (!inserted) {
    log.debug('Duplicate inbound message ignored', { agentGroupId, sessionId, messageId: message.id });
    return false;
  }

  await updateSession(sessionId, { last_active: new Date().toISOString() });

  // Push an inbox-board SSE notification — the session's last_inbound_at and
  // attention_state just changed. Lazy-imported because the dashboard module
  // can't be loaded eagerly here (init order between session-manager and the
  // dashboard wiring), and a missing module must not break message routing.
  void import('./dashboard/api/events.js')
    .then((mod) =>
      mod.emitSessionEvent({
        session_id: sessionId,
        agent_group_id: agentGroupId,
        kind: 'inbound',
      }),
    )
    .catch(() => {
      /* dashboard module not initialized — tests + early boot */
    });
  return true;
}

/**
 * Pair non-task turns that were already live when the automatic pre-turn
 * context contract was activated. Containers are absent when this runs (the
 * migration and startup gates prove that first), so a row left in processing
 * can safely return to pending. Scheduled tasks stay untouched: their existing
 * due-time seam admits context immediately before execution.
 */
export async function admitPendingUpgradeContexts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<number> {
  // The one central read, before the first inbound read: the loop below is one
  // synchronous pass over a single snapshot of the unpaired rows.
  const central = await resolveRecallCentral(agentGroupId, sessionId);
  // Under the lease: `buildRecallRow`'s pre-turn context carries a lease-only
  // central read (seam 3 §4.5), and the pass is synchronous anyway.
  return withCentralSync(() => {
    let admitted = 0;
    for (const message of mailbox.listUnpairedPendingUpgradeRows()) {
      const recall = buildRecallRow(
        agentGroupId,
        sessionId,
        {
          id: message.id,
          kind: message.kind,
          timestamp: message.timestamp,
          platformId: message.platform_id,
          channelType: message.channel_type,
          threadId: message.thread_id,
          content: message.content,
          processAfter: message.process_after,
          trigger: 1,
          sourceSessionId: message.source_session_id,
          onWake: message.on_wake,
        },
        message.content,
        mailbox,
        central,
      );
      if (!recall) continue;
      if (mailbox.admitPendingUpgradeRow(recall, message.id)) admitted++;
    }
    return admitted;
  }, 'admitPendingUpgradeContexts');
}

/**
 * Crash-replay record for the startup migration pass. Written and fsynced
 * BEFORE any DDL runs, deleted once the pass restores what it touched.
 */
export const UPGRADE_MTIME_MANIFEST = 'pending-upgrade-mtimes.json';
/**
 * How long after the manifest was written a bumped mtime is still attributable
 * to that pass. Anything later is real traffic and keeps its clock.
 */
const UPGRADE_MTIME_REPLAY_WINDOW_MS = 10 * 60 * 1000;

interface UpgradeMtimeManifest {
  writtenAtMs: number;
  entries: Array<{ path: string; sessionId?: string; atimeMs: number; mtimeMs: number }>;
}

/** Filesystem timestamps round; the manifest's clock and the file's need slack. */
const UPGRADE_MTIME_EDGE_TOLERANCE_MS = 2000;
/** Signals this pass never writes — if one moved after the manifest, work happened. */
const UNTOUCHED_ACTIVITY_FILES = ['outbound.db', 'archive.db', '.heartbeat'];

/**
 * Did anything that ISN'T the migration pass record activity for this session
 * after the manifest was written? The bumped-mtime window alone cannot tell a
 * DDL write from a message that landed two minutes later; these can.
 */
function sawRealActivityAfter(
  inboundPath: string,
  sinceMs: number,
  sessionId: string | undefined,
  centralDb: Database.Database | undefined,
): boolean {
  const dir = path.dirname(inboundPath);
  for (const name of UNTOUCHED_ACTIVITY_FILES) {
    try {
      // Floor before comparing. `sinceMs` is a Date.now() reading — integer
      // milliseconds — while statSync reports mtimeMs as a float carrying the
      // filesystem's sub-millisecond precision. A file touched microseconds
      // BEFORE the manifest was written therefore compares as after it
      // (1234.567 > 1234), and the pass reads its own quiescent session as
      // live traffic. Measured on this host: 36.6% of writes landing in the
      // same millisecond as the following Date.now() produce that phantom.
      // The consequence is not cosmetic — a phantom here skips the mtime
      // restore, so the session keeps the clock the DDL bumped and stops
      // aging out, which is the fleet-wide archival freeze this manifest
      // exists to prevent. Flooring can only remove false positives: a write
      // that genuinely lands in a later millisecond still floors above
      // `sinceMs`.
      if (Math.floor(fs.statSync(path.join(dir, name)).mtimeMs) > sinceMs) return true;
    } catch {
      // Absent signal file.
    }
  }
  if (!centralDb || !sessionId) return false;
  try {
    const row = centralDb.prepare('SELECT last_active FROM sessions WHERE id = ?').get(sessionId) as
      | { last_active: string | null }
      | undefined;
    return row?.last_active ? Date.parse(row.last_active) > sinceMs : false;
  } catch {
    return false;
  }
}

function upgradeMtimeManifestPath(dataDir: string): string {
  return path.join(dataDir, UPGRADE_MTIME_MANIFEST);
}

function writeUpgradeMtimeManifest(dataDir: string, manifest: UpgradeMtimeManifest): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const fd = fs.openSync(upgradeMtimeManifestPath(dataDir), 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Restore mtimes a previous, interrupted migration pass bumped.
 *
 * Deliberately conservative on both ends: a file whose mtime is still what the
 * manifest recorded was never touched, and a file bumped past the replay
 * window saw real traffic after the pass — neither is restored.
 */
export function replayUpgradeMtimeManifest(dataDir = DATA_DIR, centralDb?: Database.Database): number {
  const manifestPath = upgradeMtimeManifestPath(dataDir);
  let manifest: UpgradeMtimeManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as UpgradeMtimeManifest;
  } catch {
    return 0;
  }
  let restored = 0;
  for (const entry of manifest.entries ?? []) {
    try {
      const current = fs.statSync(entry.path);
      if (current.mtimeMs <= entry.mtimeMs) continue;
      if (current.mtimeMs < manifest.writtenAtMs - UPGRADE_MTIME_EDGE_TOLERANCE_MS) continue;
      if (current.mtimeMs > manifest.writtenAtMs + UPGRADE_MTIME_REPLAY_WINDOW_MS) continue;
      // The window says "this could be the pass". Untouched evidence says
      // whether it actually was — a message that landed inside the window is
      // real activity and its clock is not ours to rewind.
      if (sawRealActivityAfter(entry.path, manifest.writtenAtMs, entry.sessionId, centralDb)) continue;
      fs.utimesSync(entry.path, entry.atimeMs / 1000, entry.mtimeMs / 1000);
      restored += 1;
    } catch {
      // Session archived or removed since the manifest was written.
    }
  }
  fs.rmSync(manifestPath, { force: true });
  if (restored > 0) log.info('Restored session mtimes from an interrupted migration pass', { restored });
  return restored;
}

/**
 * Run the lazy session-DB migration over every session of the given
 * workgroups, and admit any pending pre-turn contexts.
 *
 * The mtime bookkeeping is load-bearing, not cosmetic. Session reclaim reads
 * `max(newest file mtime, central last_active)` as the idle clock, so the DDL
 * this pass runs once per schema-adding deploy used to reset the clock for
 * EVERY session at once — 5,027 files in 90 seconds on 2026-08-15, which froze
 * archival fleet-wide until the whole cohort aged out together. A migration is
 * bookkeeping, not session activity: the pre-pass mtime is restored afterward.
 * A session that ADMITS work here is genuinely active and keeps its new clock.
 */
export async function reconcilePendingUpgradeContexts(
  centralDb: Database.Database,
  workgroupIds: string[],
  dataDir = DATA_DIR,
): Promise<{ sessions: number; admitted: number; mtimesRestored: number; skipped: number; stubsRemoved: number }> {
  replayUpgradeMtimeManifest(dataDir, centralDb);

  let stubsRemoved = 0;
  const targets: Array<{ id: string; agentGroupId: string; inboundPath: string; stat: fs.Stats }> = [];
  for (const workgroupId of [...new Set(workgroupIds)].sort()) {
    const rows = centralDb
      .prepare(
        `SELECT s.id, s.agent_group_id
           FROM sessions s
           JOIN agent_groups a ON a.id = s.agent_group_id
          WHERE a.workgroup_id = ?
          ORDER BY s.agent_group_id, s.id`,
      )
      .all(workgroupId) as Array<{ id: string; agent_group_id: string }>;
    for (const row of rows) {
      const inboundPath = path.join(dataDir, 'v2-sessions', row.agent_group_id, row.id, 'inbound.db');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(inboundPath);
      } catch {
        continue;
      }
      // A 0-byte inbound.db is provably never-provisioned: `ensureSchema` is
      // the only host-side creator and it writes the schema in the same call
      // that creates the file, and SQLite writes nothing to a fresh file until
      // that first schema write. So this is the residue of a failed open, not
      // a session — before this fix, `new Database(path)` created the file and
      // the schema migration then threw, leaving the stub behind. Removing it
      // restores the two-signal reclaimed state (reclaimed AND no inbound.db)
      // the stub was defeating.
      if (stat.size === 0) {
        log.warn('Removed empty inbound.db stub left by a failed open of a reclaimed session', {
          sessionId: row.id,
          agentGroupId: row.agent_group_id,
          path: inboundPath,
        });
        try {
          fs.rmSync(inboundPath, { force: true });
          stubsRemoved += 1;
        } catch (err) {
          log.error('Could not remove an empty inbound.db stub', { sessionId: row.id, path: inboundPath, err });
        }
        continue;
      }
      targets.push({ id: row.id, agentGroupId: row.agent_group_id, inboundPath, stat });
    }
  }
  if (targets.length === 0) return { sessions: 0, admitted: 0, mtimesRestored: 0, skipped: 0, stubsRemoved };

  // One fsync for the whole pass, before the first ALTER TABLE. A crash any
  // time after this point is recoverable on the next start.
  writeUpgradeMtimeManifest(dataDir, {
    writtenAtMs: Date.now(),
    entries: targets.map((target) => ({
      path: target.inboundPath,
      sessionId: target.id,
      atimeMs: target.stat.atimeMs,
      mtimeMs: target.stat.mtimeMs,
    })),
  });

  let sessions = 0;
  let admitted = 0;
  let mtimesRestored = 0;
  let skipped = 0;
  for (const target of targets) {
    let admittedHere = 0;
    // Per-target isolation. This pass runs on the startup path and its caller
    // exits the process on a throw, so one unreadable session DB used to take
    // the whole fleet down (2026-09-01: a stub inbound.db crash-looped the host
    // seven times). A bad session DB is that session's problem; the pass owns
    // every other session and the manifest bookkeeping below.
    try {
      // Existing-only: `targets` was built from a successful stat of each
      // inbound.db, so `undefined` here means the session vanished between
      // that stat and now — nothing to admit, and never something to
      // re-provision on the startup path (invariant I-10). The legacy
      // migrations the raw open used to run by hand are what session() runs on
      // its first touch of a path.
      await withExistingMailboxSession(target.agentGroupId, target.id, async (mailbox) => {
        sessions++;
        admittedHere = await admitPendingUpgradeContexts(mailbox, target.agentGroupId, target.id);
        admitted += admittedHere;
      });
    } catch (err) {
      log.error('Session inbound DB unreadable during startup reconciliation; skipping session', {
        sessionId: target.id,
        agentGroupId: target.agentGroupId,
        path: target.inboundPath,
        err,
      });
      skipped += 1;
      // A failed session keeps whatever clock it has. `admitPendingUpgradeContexts`
      // commits ONE TRANSACTION PER MESSAGE, so a throw on a later row leaves
      // earlier admissions committed — and `admittedHere` is still 0, because
      // the assignment never ran. Restoring here would therefore rewind the
      // clock over real, durable work and report an active session as idle to
      // the reclaim. The two errors are not symmetric: a clock left bumped at
      // worst delays this one session's reclaim until the next pass, while a
      // clock rewound over committed rows can hand a session with admitted
      // work to the archiver. Keep the bumped clock.
      continue;
    }
    if (admittedHere > 0) continue;
    try {
      if (fs.statSync(target.inboundPath).mtimeMs === target.stat.mtimeMs) continue;
      fs.utimesSync(target.inboundPath, target.stat.atimeMs / 1000, target.stat.mtimeMs / 1000);
      mtimesRestored += 1;
    } catch {
      // Session removed underneath the pass.
    }
  }
  // Deleted once the loop has run to the end. A per-target failure is handled
  // inline (skipped, and its clock deliberately left alone), so it leaves
  // nothing for the manifest to recover. Only a failure OUTSIDE this loop — the
  // central DB query, the manifest write — still escapes to startup, which
  // exits; the manifest is then the only record of what this pass bumped, so a
  // `finally` that removes it would destroy the recovery it exists for.
  fs.rmSync(upgradeMtimeManifestPath(dataDir), { force: true });
  if (mtimesRestored > 0) {
    log.info('Session migration pass left the idle clock untouched', { sessions, mtimesRestored });
  }
  return { sessions, admitted, mtimesRestored, skipped, stubsRemoved };
}

/**
 * Put a crashed provider turn behind its retry deadline without exposing the
 * old pair to a warm poller.
 *
 * A thin pass-through to the module's admission op — kept here because the
 * sweep and the recovery paths reach it through this file's vocabulary, not
 * because any SQL lives here any more.
 */
export function deferMessageForFreshContextRetry(
  mailbox: NanoclawMailboxSession,
  messageId: string,
  backoffSec: number,
): void {
  mailbox.deferForFreshContextRetry(messageId, backoffSec);
}

/**
 * Admit due scheduled occurrences and paired crash retries through the same
 * fresh recall seam as channel and agent ingress.
 *
 * Scheduled rows are persisted with trigger=0, so neither a warm poller nor
 * the cold-wake query can claim them before this host-owned step. Admission
 * builds current context, then atomically appends the recall row and moves the
 * existing turn immediately after it while flipping trigger=1. Identity,
 * status, tries, series, recurrence, content, and routing stay on the original
 * row. A repeated sweep sees the paired trigger and is a no-op. Ordinary
 * trigger=0 accumulated chat has no recall marker and is never promoted.
 * Deferred on-wake rows keep on_wake=1 only until this host-owned barrier;
 * admission clears it on both halves so a fresh container that was concurrently
 * started by real inbound can still consume the now-safe pair on a later poll.
 *
 * What stays here is the POLICY — which rows get a recall and what it says.
 * Every statement it commits lives in the mailbox module's admission ops.
 */
export async function admitDueTaskContexts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<number> {
  // The one central read a recall needs, taken BEFORE the first inbound read so
  // the admission itself is one synchronous pass: fence check, legacy
  // demotion, due-row select and each paired admission see a single snapshot.
  const central = await resolveRecallCentral(agentGroupId, sessionId);
  // Under the lease: the recall rows read one lease-only central fact each
  // (seam 3 §4.5); the dashboard's run-now caller already holds the lease.
  return withCentralSync(
    () => admitDueTaskContextsFor(mailbox, agentGroupId, sessionId, central),
    'admitDueTaskContexts',
  );
}

/**
 * The synchronous half of `admitDueTaskContexts`, for a caller whose mailbox
 * action must not yield (the dashboard's run-now mutation proves its verdict
 * and mutates in one block). Such a caller resolves the central facts with
 * `resolveRecallCentral` before opening its session.
 */
export function admitDueTaskContextsFor(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
  central: RecallCentral,
): number {
  // An active repository ingress fence means this session must admit nothing:
  // the whole point is that no new turn starts while its mounts change. The
  // admission below sets trigger = 1, which a fenced row may never carry, so
  // proceeding aborts the sweep for this session on the fence guard. Release
  // has its own admission path (admitTaggedRows) and replays the deferred rows
  // with their original triggers, so skipping here defers rather than drops.
  if (mailbox.readRepoIngressFence()?.state === 'active') return 0;

  // Legacy rows predate inert scheduling and were stored trigger=1. Demote
  // only unpaired live tasks before selecting due work; already-admitted
  // pairs remain wakeable and untouched.
  mailbox.demoteUnpairedLegacyTasks();

  let admitted = 0;
  for (const task of mailbox.listDueAdmissionRows()) {
    let recall: MessageInsert;
    try {
      recall = buildRecallRow(
        agentGroupId,
        sessionId,
        {
          id: task.id,
          kind: task.kind,
          timestamp: task.timestamp,
          platformId: task.platform_id,
          channelType: task.channel_type,
          threadId: task.thread_id,
          content: task.content,
          processAfter: task.process_after,
          trigger: 1,
          sourceSessionId: task.source_session_id,
          onWake: 0,
        },
        task.content,
        // The open session IS the recall source: it exposes the same four
        // reads the adapter used to wrap, on the handle already in hand.
        mailbox,
        central,
      )!;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      log.warn('Due context admission failed; leaving turn inert for retry', {
        agentGroupId,
        sessionId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!recall) {
      log.warn('Due context admission produced no pair; leaving turn inert for inspection', {
        agentGroupId,
        sessionId,
        taskId: task.id,
        kind: task.kind,
      });
      continue;
    }

    if (mailbox.admitDueRow(recall, task.id)) admitted++;
  }
  return admitted;
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the session's inbox directory and replace with `localPath`.
 *
 * Both `messageId` and `att.name` originate in untrusted input. WhatsApp
 * passes `msg.key.id` through raw (and that field is client generated, so a
 * peer can craft it), and other adapters may follow. The session dir is
 * mounted writable into the container, so a compromised agent can also
 * pre-place a symlink at `inbox/<future msgId>/` and wait for a chat message
 * with a matching id to redirect the host's write.
 *
 * Defenses, mirrored from the outbound side:
 *   1. basename check on `messageId` and `filename`.
 *   2. lstat of the inbox dir to refuse pre-placed symlinks.
 *   3. realpath-based containment under the session inbox root.
 *   4. `wx` flag on writeFileSync to refuse following a pre-existing symlink
 *      at the target file path or overwriting any existing file.
 */
interface ExtractedAttachments {
  content: string;
  /** Absolute paths this call created, so a refused write can take them back. */
  writtenPaths: string[];
}

function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): ExtractedAttachments {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return { content: contentStr, writtenPaths: [] };
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return { content: contentStr, writtenPaths: [] };

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return { content: contentStr, writtenPaths: [] };
  }

  const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  // Resolved lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  // ensureContainedInboxDir refuses a pre-placed symlink at the inbox root or
  // the per-message subdir before any write lands outside the sandbox (#2828).
  let inboxDir: string | null = null;
  let inboxResolved = false;

  let changed = false;
  const writtenPaths: string[] = [];
  for (const att of attachments) {
    if (typeof att.data !== 'string') continue;

    const rawName = deriveAttachmentName(att);
    const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
    if (filename !== rawName) {
      log.warn('Refused unsafe attachment filename, would escape inbox', {
        messageId,
        rawName,
        replacement: filename,
      });
    }

    if (!inboxResolved) {
      inboxDir = ensureContainedInboxDir(inboxRoot, messageId, { messageId });
      inboxResolved = true;
    }
    // Unsafe inbox (symlink / escape) — no attachment can be written safely.
    if (!inboxDir) break;

    const filePath = path.join(inboxDir, filename);
    const attachmentBytes = Buffer.from(att.data as string, 'base64');
    try {
      // wx = exclusive create. Refuses to follow a pre existing symlink or
      // overwrite any existing file. The host expects to be the sole writer
      // of these attachments.
      fs.writeFileSync(filePath, attachmentBytes, { flag: 'wx' });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        // A host crash can land after the exclusive file write but before the
        // messages_in insert. Accept only an identical, regular file inside
        // the already-validated inbox directory so the exact platform replay
        // can finish without weakening the symlink/overwrite defenses.
        try {
          const existing = fs.lstatSync(filePath);
          const realFile = fs.realpathSync(filePath);
          if (
            existing.isFile() &&
            !existing.isSymbolicLink() &&
            isPathInside(inboxDir, realFile) &&
            fs.readFileSync(realFile).equals(attachmentBytes)
          ) {
            log.debug('Reusing identical inbox attachment from interrupted ingress', {
              messageId,
              filename,
            });
          } else {
            log.warn('Inbox attachment target already exists, refusing to overwrite', {
              messageId,
              filename,
            });
            continue;
          }
        } catch {
          log.warn('Inbox attachment target could not be verified, refusing to reuse', {
            messageId,
            filename,
          });
          continue;
        }
      } else {
        throw err;
      }
    }

    att.name = filename;
    att.localPath = `inbox/${messageId}/${filename}`;
    delete att.data;
    changed = true;
    writtenPaths.push(filePath);
    log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
  }

  return { content: changed ? JSON.stringify(parsed) : contentStr, writtenPaths };
}

/**
 * Take back attachment bytes this writer wrote for a message it then refused.
 *
 * The bytes are the side effect a refusal cannot otherwise undo: they land in
 * the target session's mounted `inbox`, which its container reads, with or
 * without a row pointing at them. The caller's own cleanup cannot cover these —
 * it only knows about files IT forwarded, not the ones this function decoded
 * out of inline `data`.
 *
 * Best-effort, and the refusal stands either way: failing to tidy up must never
 * turn a refused write into a successful one. The message directory goes only
 * if it is actually empty, so a concurrent writer's file is never taken with it.
 */
function removeExtractedAttachments(writtenPaths: string[]): void {
  const dirs = new Set<string>();
  for (const file of writtenPaths) {
    try {
      fs.rmSync(file, { force: true });
      dirs.add(path.dirname(file));
    } catch (err) {
      log.warn('Could not remove an inbox attachment after the write was refused', { file, err });
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Non-empty or already gone; tidying, not the guarantee.
    }
  }
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox message id', { messageId });
    return undefined;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return undefined;

  let realOutboxDir: string;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox directory', { messageId, outboxDir });
      return undefined;
    }
    realOutboxDir = fs.realpathSync(outboxDir);
  } catch (err) {
    log.warn('Failed to inspect outbox directory', { messageId, err });
    return undefined;
  }

  const files: OutboundFile[] = [];
  for (const filename of filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('Refused unsafe outbox filename, would escape outbox', { messageId, filename });
      continue;
    }

    const filePath = path.join(outboxDir, filename);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        log.warn('Rejecting unsafe outbox file', { messageId, filename });
        continue;
      }
      const realFilePath = fs.realpathSync(filePath);
      if (!isPathInside(realOutboxDir, realFilePath)) {
        log.warn('Rejecting outbox file outside message directory', { messageId, filename });
        continue;
      }
      files.push({ filename, data: fs.readFileSync(realFilePath) });
    } catch {
      log.warn('Outbox file not found', { messageId, filename });
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe outbox cleanup message id', { messageId });
    return;
  }

  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return;
  try {
    const stat = fs.lstatSync(outboxDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log.warn('Rejecting unsafe outbox cleanup directory', { messageId, outboxDir });
      return;
    }
    const realOutboxBase = fs.realpathSync(path.join(sessionDir(agentGroupId, sessionId), 'outbox'));
    const realOutboxDir = fs.realpathSync(outboxDir);
    if (!isPathInside(realOutboxBase, realOutboxDir)) {
      log.warn('Rejecting outbox cleanup outside session outbox', { messageId, outboxDir });
      return;
    }
    fs.rmSync(realOutboxDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  }
}

/**
 * Push an inbox-board `session_event` for a container-state transition.
 * Looks up agent_group_id by sessionId because the three markContainer*
 * helpers are called from places that don't all carry that context.
 * Best-effort: lookup miss or unavailable dashboard module → no emit.
 */
/**
 * Exported for the fenced finish in container-runner, which writes the
 * `stopped` status inside a central transaction (DB calls only) and emits the
 * dashboard event after it commits.
 */
export async function _emitContainerStateEvent(
  sessionId: string,
  containerStatus: 'running' | 'idle' | 'stopped',
): Promise<void> {
  const sess = await getSession(sessionId);
  if (!sess) return;
  void import('./dashboard/api/events.js')
    .then((mod) =>
      mod.emitSessionEvent({
        session_id: sessionId,
        agent_group_id: sess.agent_group_id,
        kind: 'container_state',
        container_status: containerStatus,
      }),
    )
    .catch(() => {
      /* dashboard module not initialized */
    });
}

/** Mark a container as running for a session. */
export async function markContainerRunning(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
  await _emitContainerStateEvent(sessionId, 'running');
}

/** Mark a container as idle for a session. */
export async function markContainerIdle(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'idle' });
  await _emitContainerStateEvent(sessionId, 'idle');
}

/** Mark a container as stopped for a session. */
export async function markContainerStopped(sessionId: string): Promise<void> {
  await updateSession(sessionId, { container_status: 'stopped' });
  await _emitContainerStateEvent(sessionId, 'stopped');
}
