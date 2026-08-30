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
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { assertChannelRoutingConsistency } from './delivery.js';
import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { acquireStorageActivityLease } from './storage-activity.js';
import { getMessagingGroup } from './db/messaging-groups.js';
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
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  upsertSessionRouting,
  insertMessageWithContext,
  insertMessageWithContextIfNew,
  migrateMessagesInTable,
  nextEvenSeq,
  readRepoIngressFence,
  type MessageInsert,
} from './db/session-db.js';
import { log } from './log.js';
import { buildPreTurnContext } from './modules/memory/pre-turn-context.js';
import type { Session, SessionMode } from './types.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
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

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
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
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: SessionMode,
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
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

  createSession(session);
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
export function resolveTaskSession(
  agentGroupId: string,
  seriesId: string,
  routingPlatformId?: string | null,
): { session: Session; created: boolean } {
  const threadId = taskThreadId(seriesId);
  const existing = findSystemSession(agentGroupId, threadId);
  if (existing) {
    // Re-scheduling an existing series (including `scheduled-move`, which
    // re-`scheduleTask`s into the target) re-stamps: the column answers "where
    // is this series routed NOW", not "where was it first routed".
    if (routingPlatformId != null && existing.task_routing_platform_id !== routingPlatformId) {
      setTaskRoutingPlatformId(existing.id, routingPlatformId);
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

  createSession(session);
  if (routingPlatformId != null) {
    setTaskRoutingPlatformId(id, routingPlatformId);
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

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
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
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  assertChannelRoutingConsistency({ channelType, platformId });

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
      session_id: sessionId,
      // spawn_task_id intentionally omitted — preserved via COALESCE on conflict
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
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

function buildRecallRow(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  normalizedContent: string,
  inboundDb: Database.Database,
): MessageInsert | null {
  if (!isAdmissiblePreTurnTrigger({ ...message, content: normalizedContent })) return null;
  const lifecycle = resolveRecallLifecycle(inboundDb, agentGroupId, sessionId, `recall-${message.id}`);
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
  inboundDb: Database.Database,
  agentGroupId: string,
  sessionId: string,
  excludeRecallId?: string,
): RecallLifecycle {
  const session = getSession(sessionId);
  const provider = resolveProviderName(session?.agent_provider, getContainerConfig(agentGroupId)?.provider);
  let contextEpoch = 0;
  let hasContinuation = false;
  try {
    const outbound = openOutboundDb(agentGroupId, sessionId);
    try {
      const epochRow = outbound
        .prepare('SELECT value FROM session_state WHERE key = ?')
        .get(`memory_context_epoch:${provider}`) as { value: string } | undefined;
      const parsedEpoch = Number.parseInt(epochRow?.value ?? '0', 10);
      contextEpoch = Number.isSafeInteger(parsedEpoch) && parsedEpoch >= 0 ? parsedEpoch : 0;
      hasContinuation =
        outbound.prepare('SELECT 1 FROM session_state WHERE key = ? LIMIT 1').get(`continuation:${provider}`) !==
        undefined;
    } finally {
      outbound.close();
    }
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
  const pendingClear = (
    inboundDb
      .prepare(
        `SELECT content
           FROM messages_in
          WHERE kind IN ('chat', 'chat-sdk')
            AND status NOT IN ('completed', 'failed', 'cancelled')
            AND instr(lower(content), '/clear') > 0
          ORDER BY seq DESC
        `,
      )
      .all() as Array<{ content: string }>
  ).some((row) => latestUserText(row.content).toLocaleLowerCase('en-US').startsWith('/clear'));
  if (pendingClear) hasContinuation = false;

  const rows = inboundDb
    .prepare(
      `SELECT id, status, content
         FROM messages_in
        WHERE kind = 'system'
          AND id LIKE 'recall-%'
        ORDER BY seq DESC
        LIMIT 256`,
    )
    .all() as Array<{ id: string; status: string; content: string }>;
  const bootstrapAlreadyQueuedOrDelivered =
    !pendingClear &&
    inboundDb
      .prepare(
        `SELECT 1
           FROM messages_in
          WHERE kind = 'system'
            AND id LIKE 'recall-%'
            AND (? IS NULL OR id <> ?)
            AND status NOT IN ('failed', 'cancelled')
            AND json_valid(content)
            AND json_extract(content, '$.subtype') = 'recall_context'
            AND json_extract(content, '$.provider') = ?
            AND json_extract(content, '$.contextEpoch') = ?
            AND json_type(content, '$.trustedCapabilities') = 'object'
          LIMIT 1`,
      )
      .get(excludeRecallId ?? null, excludeRecallId ?? null, provider, contextEpoch) !== undefined;
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
export function sessionMessageExists(agentGroupId: string, sessionId: string, messageId: string): boolean {
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) return false;
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    return db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(messageId) !== undefined;
  } finally {
    db.close();
  }
}

export async function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
): Promise<void> {
  await writeSessionMessageInternal(agentGroupId, sessionId, message, false);
}

/** Idempotent channel-ingress variant; false means this platform id was already routed. */
export async function writeSessionMessageIfNew(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
): Promise<boolean> {
  return writeSessionMessageInternal(agentGroupId, sessionId, message, true);
}

async function writeSessionMessageInternal(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  ignoreDuplicateId: boolean,
): Promise<boolean> {
  // A session mid-archival is about to lose its directory. Re-provisioning it
  // below would resurrect the dir seconds before the reclaim removes it, and
  // the message would vanish with it. Ordinary routing never gets here —
  // findSessionForAgent filters status='active' — so this only fires on a
  // raw-session-id path, and it must be loud rather than silent.
  const statusBefore = getSession(sessionId)?.status;
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
    return await writeSessionMessageLocked(agentGroupId, sessionId, message, ignoreDuplicateId);
  } finally {
    await lease.release();
  }
}

async function writeSessionMessageLocked(
  agentGroupId: string,
  sessionId: string,
  message: SessionMessageInput,
  ignoreDuplicateId: boolean,
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
  if (sessionWasReclaimed(sessionId) && !fs.existsSync(inboundDbPath(agentGroupId, sessionId))) {
    throw new Error(`session ${sessionId} has been reclaimed; route this message to a fresh session`);
  }

  // Documented reset: operators `rm -rf` a session folder to clear a stuck
  // session. The sessions row survives, so the next message takes the
  // existing-session path and lands here with a missing inbound.db — the open
  // below would throw and the message would be logged-and-dropped forever.
  // Re-provision the folder + DBs (initSessionFolder is idempotent) so the
  // documented reset actually re-provisions instead of killing the chat.
  if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) {
    initSessionFolder(agentGroupId, sessionId);
  }

  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, sessionId, message.id, message.content);

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
  const db = openInboundDb(agentGroupId, sessionId);
  let inserted: boolean;
  try {
    const recallRow = isScheduledTask ? null : buildRecallRow(agentGroupId, sessionId, message, content, db);
    if (ignoreDuplicateId) {
      inserted = insertMessageWithContextIfNew(db, row, recallRow);
    } else {
      insertMessageWithContext(db, row, recallRow);
      inserted = true;
    }
  } finally {
    db.close();
  }

  if (!inserted) {
    log.debug('Duplicate inbound message ignored', { agentGroupId, sessionId, messageId: message.id });
    return false;
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });

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

interface DueTaskForAdmission {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  process_after: string | null;
  source_session_id: string | null;
  on_wake: 0 | 1;
}

interface PendingUpgradeForAdmission extends DueTaskForAdmission {
  status: 'pending' | 'processing';
}

/**
 * Pair non-task turns that were already live when the automatic pre-turn
 * context contract was activated. Containers are absent when this runs (the
 * migration and startup gates prove that first), so a row left in processing
 * can safely return to pending. Scheduled tasks stay untouched: their existing
 * due-time seam admits context immediately before execution.
 */
export function admitPendingUpgradeContexts(db: Database.Database, agentGroupId: string, sessionId: string): number {
  const pending = db
    .prepare(
      `SELECT id, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after,
              source_session_id, on_wake
         FROM messages_in
        WHERE status IN ('pending', 'processing')
          AND trigger = 1
          AND kind NOT IN ('system', 'task')
          AND NOT EXISTS (
            SELECT 1
              FROM messages_in AS recall
             WHERE recall.id = 'recall-' || messages_in.id
          )
        ORDER BY seq`,
    )
    .all() as PendingUpgradeForAdmission[];

  let admitted = 0;
  for (const message of pending) {
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
      db,
    );
    if (!recall) continue;

    const inserted = db.transaction(() => {
      const stillUnpaired = db
        .prepare(
          `SELECT 1
             FROM messages_in
            WHERE id = ?
              AND status IN ('pending', 'processing')
              AND trigger = 1
              AND kind NOT IN ('system', 'task')
              AND NOT EXISTS (
                SELECT 1
                  FROM messages_in AS recall
                 WHERE recall.id = 'recall-' || messages_in.id
              )`,
        )
        .get(message.id);
      if (!stillUnpaired) return false;

      const recallSeq = nextEvenSeq(db);
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content,
            process_after, recurrence, series_id, trigger, source_session_id, on_wake)
         VALUES
           (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content,
            @processAfter, NULL, @id, 0, @sourceSessionId, @onWake)`,
      ).run({ ...recall, seq: recallSeq });
      const changed = db
        .prepare(
          `UPDATE messages_in
              SET seq = ?, status = 'pending'
            WHERE id = ?
              AND status IN ('pending', 'processing')
              AND trigger = 1`,
        )
        .run(recallSeq + 2, message.id).changes;
      if (changed !== 1) throw new Error(`pending upgrade turn ${message.id} changed during context admission`);
      return true;
    })();
    if (inserted) admitted++;
  }
  return admitted;
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
export function reconcilePendingUpgradeContexts(
  centralDb: Database.Database,
  workgroupIds: string[],
  dataDir = DATA_DIR,
): { sessions: number; admitted: number; mtimesRestored: number } {
  replayUpgradeMtimeManifest(dataDir, centralDb);

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
      targets.push({ id: row.id, agentGroupId: row.agent_group_id, inboundPath, stat });
    }
  }
  if (targets.length === 0) return { sessions: 0, admitted: 0, mtimesRestored: 0 };

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
  for (const target of targets) {
    const inbound = openInboundDbRaw(target.inboundPath);
    let admittedHere = 0;
    try {
      migrateMessagesInTable(inbound);
      sessions++;
      admittedHere = admitPendingUpgradeContexts(inbound, target.agentGroupId, target.id);
      admitted += admittedHere;
    } finally {
      inbound.close();
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
  // Deleted ONLY on full success. An exception here escapes to startup, which
  // exits; the manifest is then the only record of what this pass bumped, so a
  // `finally` that removes it would destroy the recovery it exists for.
  fs.rmSync(upgradeMtimeManifestPath(dataDir), { force: true });
  if (mtimesRestored > 0) {
    log.info('Session migration pass left the idle clock untouched', { sessions, mtimesRestored });
  }
  return { sessions, admitted, mtimesRestored };
}

/**
 * Put a crashed provider turn behind its retry deadline without exposing the
 * old pair to a warm poller. The existing recall row is retained as a
 * no-schema admission marker, but both rows become non-triggering and share
 * the future process_after. Due admission replaces that recall from current
 * host state before restoring trigger=1.
 *
 * Rows without a recall keep their current trigger value. In particular, an
 * ordinary trigger=0 accumulated chat row cannot become a provider turn merely
 * because generic crash cleanup touched its id.
 */
export function deferMessageForFreshContextRetry(db: Database.Database, messageId: string, backoffSec: number): void {
  const processAfter = new Date(Date.now() + backoffSec * 1000).toISOString();
  db.transaction(() => {
    const recallId = `recall-${messageId}`;
    const hasRecall =
      db.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'system' LIMIT 1").get(recallId) !== undefined;
    const changed = db
      .prepare(
        `UPDATE messages_in
            SET tries = tries + 1,
                process_after = ?,
                trigger = CASE WHEN ? THEN 0 ELSE trigger END
          WHERE id = ? AND status = 'pending'`,
      )
      .run(processAfter, hasRecall ? 1 : 0, messageId).changes;
    if (changed === 1 && hasRecall) {
      db.prepare("UPDATE messages_in SET process_after = ?, trigger = 0 WHERE id = ? AND kind = 'system'").run(
        processAfter,
        recallId,
      );
    }
  }).immediate();
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
 */
export function admitDueTaskContexts(db: Database.Database, agentGroupId: string, sessionId: string): number {
  // An active repository ingress fence means this session must admit nothing:
  // the whole point is that no new turn starts while its mounts change. The
  // admission below sets trigger = 1, which a fenced row may never carry, so
  // proceeding aborts the sweep for this session on the fence guard. Release
  // has its own admission path (admitTaggedRows) and replays the deferred rows
  // with their original triggers, so skipping here defers rather than drops.
  if (readRepoIngressFence(db)?.state === 'active') return 0;

  // Legacy rows predate inert scheduling and were stored trigger=1. Demote
  // only unpaired live tasks before selecting due work; already-admitted
  // pairs remain wakeable and untouched.
  db.prepare(
    `UPDATE messages_in
        SET trigger = 0
      WHERE kind = 'task'
        AND status = 'pending'
        AND trigger = 1
        AND NOT EXISTS (
          SELECT 1
            FROM messages_in AS recall
           WHERE recall.id = 'recall-' || messages_in.id
        )`,
  ).run();

  const due = db
    .prepare(
      `SELECT id, kind, timestamp, platform_id, channel_type, thread_id, content, process_after,
              source_session_id, on_wake
         FROM messages_in
        WHERE status = 'pending'
          AND trigger = 0
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          AND (
            kind = 'task'
            OR EXISTS (
              SELECT 1
                FROM messages_in AS recall
               WHERE recall.id = 'recall-' || messages_in.id
                 AND recall.kind = 'system'
                 AND recall.trigger = 0
            )
          )
        ORDER BY seq`,
    )
    .all() as DueTaskForAdmission[];

  let admitted = 0;
  for (const task of due) {
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
        db,
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

    const inserted = db.transaction(() => {
      const stillDue = db
        .prepare(
          `SELECT 1
             FROM messages_in
            WHERE id = ?
              AND status = 'pending'
              AND trigger = 0
              AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
              AND (
                kind = 'task'
                OR EXISTS (
                  SELECT 1
                    FROM messages_in AS recall
                   WHERE recall.id = 'recall-' || messages_in.id
                     AND recall.kind = 'system'
                     AND recall.trigger = 0
                )
              )`,
        )
        .get(task.id);
      if (!stillDue) return false;
      db.prepare("DELETE FROM messages_in WHERE id = ? AND kind = 'system'").run(recall.id);

      const recallSeq = nextEvenSeq(db);
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content,
            process_after, recurrence, series_id, trigger, source_session_id, on_wake)
         VALUES
           (@id, @seq, @kind, @timestamp, 'pending', @platformId, @channelType, @threadId, @content,
            @processAfter, NULL, @id, 0, @sourceSessionId, @onWake)`,
      ).run({ ...recall, seq: recallSeq });
      const changed = db
        .prepare(
          `UPDATE messages_in
              SET seq = ?, trigger = 1, on_wake = 0
            WHERE id = ? AND status = 'pending' AND trigger = 0`,
        )
        .run(recallSeq + 2, task.id).changes;
      if (changed !== 1) throw new Error(`due turn ${task.id} changed during context admission`);
      return true;
    })();
    if (inserted) admitted++;
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
function extractAttachmentFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  if (!isSafeAttachmentName(messageId)) {
    log.warn('Rejecting unsafe inbound message id', { messageId });
    return contentStr;
  }

  const inboxRoot = path.join(sessionDir(agentGroupId, sessionId), 'inbox');
  // Resolved lazily on the first attachment that actually carries bytes, so a
  // message whose attachments have no inline `data` never creates an inbox dir.
  // ensureContainedInboxDir refuses a pre-placed symlink at the inbox root or
  // the per-message subdir before any write lands outside the sandbox (#2828).
  let inboxDir: string | null = null;
  let inboxResolved = false;

  let changed = false;
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
    log.debug('Saved attachment to inbox', { messageId, filename, size: att.size });
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  try {
    migrateMessagesInTable(db);
  } catch (err) {
    // close() releases the storage-activity marker; without this a failed
    // migration leaks both the handle and the marker, and a leaked marker
    // makes this session unreclaimable until the next host start.
    db.close();
    throw err;
  }
  return db;
}

/** Open a session's inbound DB, run `fn`, and always close it. */
export function withInboundDb<T>(agentGroupId: string, sessionId: string, fn: (db: Database.Database) => T): T {
  const db = openInboundDb(agentGroupId, sessionId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 *
 * Needs the read-write open — the readonly handle the delivery poll uses
 * can't INSERT. This is a host-side write to the container-owned outbound.db,
 * but it's safe even with a container running: both sides open with DELETE
 * journal + busy_timeout, and the even host seq stays out of the container's
 * odd-seq space.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  const db = openOutboundDbRw(agentGroupId, sessionId);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      new Date().toISOString(),
      message.kind,
      message.platformId,
      message.channelType,
      message.threadId,
      message.content,
    );
  } finally {
    db.close();
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
function _emitContainerStateEvent(sessionId: string, containerStatus: 'running' | 'idle' | 'stopped'): void {
  const sess = getSession(sessionId);
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
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
  _emitContainerStateEvent(sessionId, 'running');
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
  _emitContainerStateEvent(sessionId, 'idle');
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
  _emitContainerStateEvent(sessionId, 'stopped');
}
