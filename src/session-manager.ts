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
// Helpers take the fork's narrowed session type (the registered NanoclawAgentMailbox), so callers need no cast.
import {
  sessionMailboxPath,
  type MessageInsert,
  type NanoclawMailboxSession,
  type ProviderRecallState,
} from './modules/mailbox/index.js';
import { log } from './log.js';
import {
  buildLiveWorkDigest,
  deliveredLiveWorkFingerprint,
  liveWorkRecallField,
  type LiveWorkDigest,
} from './live-work-digest.js';
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
 * The same path from a session DIRECTORY (the reclaim walks an injected root). The file is a SIBLING of the
 * session dir, so a reclaim that misses it leaks one file per session.
 */
export function sessionContextPathFor(sessionPath: string): string {
  return path.join(path.dirname(sessionPath), '.context', `${path.basename(sessionPath)}.json`);
}

/**
 * Non-secret runner context. Takes the modes of `inbound.db` and the session dir, not upstream's 0700/0600: the
 * container runs as a different UID wherever `--user` is omitted and must be able to read it.
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

export function threadsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-threads');
}

/** Replace anything outside [A-Za-z0-9._-] with `_` (no colons: Docker's `-v` splits on `:`). */
function fsSlug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Thread-scoped worktrees shared by every sibling agent in the thread, keyed by `<thread-id>` or
 * `dm-<platform-id>`, so two bot apps on one channel share a checkout. Nested dirs, never a `<mg>:<thread>` key:
 * Docker's `-v` treats `:` as a field separator.
 */
export function threadWorktreeDir(platformId: string, threadId: string | null, workgroupId?: string): string {
  return path.join(threadStateDir(platformId, threadId, workgroupId), 'worktrees');
}

/**
 * Workgroup-namespaced: an identical platform/thread key can be an unrelated channel in another workgroup, which
 * must NOT share. A pre-namespace legacy dir is still served when no scoped dir exists, until migrated.
 */
function threadStateDir(platformId: string, threadId: string | null, workgroupId?: string): string {
  const tid = threadId ?? `dm-${platformId}`;
  const legacy = path.join(threadsBaseDir(), fsSlug(tid));
  if (!workgroupId) return legacy;
  const scoped = path.join(threadsBaseDir(), `wg-${fsSlug(workgroupId)}`, fsSlug(tid));
  if (fs.existsSync(legacy) && !fs.existsSync(scoped)) {
    // Ownership check, or workgroup B adopts A's legacy dir on a colliding key; an unstamped dir is adoptable.
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

/** Matches no real workgroup id (real ids have no spaces): stamped when ownership is ambiguous, so nobody adopts. */
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

/** Claude Code's project-dir hash for the container cwd `/workspace/agent`; regenerate if the cwd changes. */
export const CLAUDE_CODE_PROJECTS_DIR = '-workspace-agent';

/**
 * Per-session SDK state (transcripts, sessions index), nested-mounted so concurrent sessions in a group cannot
 * clobber each other's resume state.
 */
export function sessionClaudeProjectsDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.claude-projects', CLAUDE_CODE_PROJECTS_DIR);
}

/** Legacy Claude-native memory source; after `/migrate-memory` cutover a compatibility view, never an authority. */
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
 * Pre-create the per-session dir as uid 1001 BEFORE docker mounts it: docker would create missing intermediates
 * AS ROOT, transcripts would silently fail to persist, and resume would start fresh. chown is best-effort.
 */
export function prepareSessionClaudeDir(agentGroupId: string, sessionId: string): void {
  const projectsDir = sessionClaudeProjectsDir(agentGroupId, sessionId);
  fs.mkdirSync(projectsDir, { recursive: true });
  const memoryDir = groupClaudeMemoryDir(agentGroupId);
  fs.mkdirSync(memoryDir, { recursive: true });

  // Creates dirs and copies NOTHING: do not reintroduce a copy from the group-shared `.claude-shared/projects/`.

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
  // Agent-shared sessions have no mg binding: null, so findSessionByAgentGroup's `IS NULL` lookup re-finds them.
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

  // Two concurrent first messages can both miss the lookup; the unique active-session index lets one insert win
  // and the loser adopts it.
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
 * The isolated session for one task series (`system:tasks:<seriesId>`). `routingPlatformId` is the series'
 * routing stamp (NULL when unrouted). `messaging_group_id` MUST stay NULL: delivery uses it to recognize a task
 * session.
 */
export async function resolveTaskSession(
  agentGroupId: string,
  seriesId: string,
  routingPlatformId?: string | null,
): Promise<{ session: Session; created: boolean }> {
  const threadId = taskThreadId(seriesId);
  const existing = await findSystemSession(agentGroupId, threadId);
  if (existing) {
    // Re-stamp: the column answers where the series is routed NOW.
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

  // Same race as `resolveSession`: one insert wins, the loser adopts.
  const { row: resolved, created } = await insertOrAdopt(session, createSession, () =>
    findSystemSession(agentGroupId, threadId),
  );
  if (!created) {
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
 * Deliberately does NOT prepare the Claude dir: sessions are minted for non-waking traffic too, and that is
 * spawn-path work.
 */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  // The single provisioning path; legacy-shape migrations run at an existing file's first session(), never here.
  getAgentMailbox().prepare(mailboxKey(agentGroupId, sessionId));
}

/** Destroy one session's implementation-owned mailbox after its container stops. */
export async function destroySessionMailbox(agentGroupId: string, sessionId: string): Promise<void> {
  await getAgentMailbox().destroy(mailboxKey(agentGroupId, sessionId));
  fs.rmSync(sessionContextPath(agentGroupId, sessionId), { force: true });
}

/**
 * Detects same-key session() nesting, which may deadlock (implementations may serialize per key). Per async
 * context, so concurrent top-level sessions on one key don't trip it.
 */
const activeMailboxKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/** Never call this (directly or via helpers) inside another action on the same session: that may deadlock. */
export function withMailboxSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
): Promise<T> {
  return runMailboxSession(agentGroupId, sessionId, action, true) as Promise<T>;
}

/** Test-only: mailbox sessions the CURRENT async context holds open (must be 0 around kill/wake). */
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
    // The one cast: `mailbox/compose.ts` registers NanoclawAgentMailbox, whose session() yields the narrowed type.
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
  // Resolved INSIDE the session so a session rewired or closed during the funnel's yield is not stamped with a
  // stale route; a stale stamp is refreshed on the next wake anyway.
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

  // Existing-only: provisioning here would resurrect a reclaimed directory.
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
 * Opens and closes the DB per call: never reuse a long-lived connection (see the invariants at the top).
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
  /** 1 (default) wakes the agent; 0 accumulates as context only. */
  trigger?: 0 | 1;
  /** Agent-to-agent return path: the source session whose outbound row became this inbound row. */
  sourceSessionId?: string | null;
  /** 1 = deliver only on the container's first poll; a dying container skips it. */
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

/** The four recall reads a pre-turn context needs, named so a fifth is not reached for by accident. */
interface RecallSource {
  readProviderRecallState(provider: string): ProviderRecallState;
  listOpenChatContents(): Array<{ content: string }>;
  listRecentRecallRows(limit: number): Array<{ id: string; status: string; content: string }>;
  hasMatchingBootstrapRecall(excludeRecallId: string | null, provider: string, contextEpoch: number): boolean;
}

/**
 * Resolved by the caller BEFORE opening the mailbox session, so the recall build and the paired insert stay one
 * synchronous block with nothing awaited before the row lands. Provider changes take effect at the next restart.
 */
export interface RecallCentral {
  provider: string;
  services: SessionServicesCentral;
  liveWork: LiveWorkDigest | null;
}

export async function resolveRecallCentral(agentGroupId: string, sessionId: string): Promise<RecallCentral> {
  const session = await getSession(sessionId);
  return {
    provider: resolveProviderName(session?.agent_provider, (await getContainerConfig(agentGroupId))?.provider),
    services: await resolveSessionServicesCentral(agentGroupId),
    liveWork: await buildLiveWorkDigest(agentGroupId, sessionId),
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
      ...liveWorkRecallField(central.liveWork, lifecycle.seenEvidenceFingerprints),
    }),
    processAfter: message.processAfter ?? null,
    recurrence: null,
    trigger: 0,
    sourceSessionId: message.sourceSessionId ?? null,
    onWake: message.onWake ?? 0,
  };
}

interface ParsedRecallContext {
  liveWork?: unknown;
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
  return [...rows.map((row) => row.fingerprint), deliveredLiveWorkFingerprint(context)].filter(
    (fingerprint): fingerprint is string => typeof fingerprint === 'string' && fingerprint.length > 0,
  );
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
    // An unreadable outbound.db means "admit a fresh bootstrap", never a throw that drops the inbound message.
    ({ contextEpoch, hasContinuation } = mailbox.readProviderRecallState(provider));
  } catch (error) {
    log.warn('Unable to read provider recall lifecycle; admitting a fresh bootstrap', {
      agentGroupId,
      sessionId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A /clear queued ahead of this message will reset the provider first; treat it as fresh now so same-batch
  // follow-ups carry full canon.
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
  // Existing-only: a replay guard must never create a session.
  return (
    (await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => mailbox.inboundHasMessage(messageId))) ??
    false
  );
}

/**
 * A caller's precondition, re-proved by the WRITER: `true` proceeds, anything else refuses and nothing is written.
 * Must be synchronous: it runs with no await between it and the insert, and an async guard reopens the window.
 */
export type WriteGuardResult = boolean | { ok: false; reason: string };
export type WriteGuard = () => WriteGuardResult;

export interface WriteSessionMessageOptions {
  /** Re-proved immediately before the insert (the writer awaits leases and funnels, so a call-site proof goes stale). */
  guard?: WriteGuard;
  /**
   * Keep the host-only `origin`/`event` fields, which every other chat write strips, so the runner's host markers
   * can only come from the host's own notes. Sole caller: notifyAgent.
   */
  hostOrigin?: boolean;
  /**
   * The genuine platform id of the inbound message (e.g. Slack `ts`), stamped as PLATFORM_MSG_ID_FIELD. Every
   * write first strips any caller-claimed id, so only the router's own routed-message write can set one.
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
 * Call ONLY inside the `withCentralSync` block around the insert (or the pre-extract ask). A guard returning a
 * promise is a contract violation, reported as a refusal so `SessionWriteRefusedError` still means nothing was
 * written.
 */
function refusalFrom(guard: WriteGuard | undefined): string | null {
  if (!guard) return null;
  let verdict: WriteGuardResult;
  try {
    verdict = evaluateGuardSync(guard);
  } catch (err) {
    // A thrown guard is a refusal, so `SessionWriteRefusedError` (nothing written) still holds.
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
  // A session mid-archival is about to lose its directory; re-provisioning would resurrect it and lose the
  // message. Only raw-session-id paths reach here, so fail loudly.
  const statusBefore = (await getSession(sessionId))?.status;
  if (statusBefore === 'archiving') {
    throw new Error(`session ${sessionId} is being archived; route this message to a fresh session`);
  }

  // The status check alone loses the write-after-check race: an open-but-unwritten writer leaves no signal, so the
  // reclaim could delete the directory under our fd and the insert lands in an unlinked inode. The storage-activity
  // lease is the two-sided lock: either the reclaim sees our marker and skips, or we wait out its claim.
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
  // Decide AFTER the lease wait whether a reclaim deleted this session meanwhile. The reclaim journal is the identity
  // (appended and fsynced before any removal, never un-appended) but records INTENT: a reclaim whose CAS lost keeps
  // the directory. So refuse only when journaled AND inbound.db is gone; not reclaimed + no directory re-provisions.
  // Deliberately, a CAS-lost reclaim whose directory an operator then deletes is refused, not reset: the rescue
  // archive was published before the CAS lost, so the content is kept.
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

  // Asked BEFORE extraction too: `extractAttachmentFiles` writes into the container-readable inbox, itself a
  // delivery. The ask inside the insert is the one that closes the window. Under the lease: the guard's reads are
  // raw.
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
  // platformMsgId: stripped from caller content on every write, reapplied only from `platformMessageId`.
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
  // One session for the recall reads and the paired insert (same snapshot). EXISTING-ONLY first: the provisioning
  // funnel runs outbound DDL, making the host a second writer of the live container's outbound.db; the fallback
  // covers only the reclaim race. Callers must not hold a session on this key (same-key nesting throws). The
  // recall's central read happens here, with the other awaits, so the action below never yields.
  const recallCentral =
    isScheduledTask || !isAdmissiblePreTurnTrigger({ ...message, content })
      ? null
      : await resolveRecallCentral(agentGroupId, sessionId);

  // THE GUARD POINT: inside the mailbox action, after every await, with nothing awaited before the insert. The
  // `withCentralSync` block is deliberately NOT async (a test pins that nothing is awaited between guard and
  // insert); the lease wraps the action so the guard's raw reads never interleave with a driver transaction. A
  // refusal is carried out and thrown after the session closes normally.
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

  // A refusal is loud: a silent return would let a caller that forgets to check believe it wrote.
  if (refusedReason !== null) {
    // Undo the attachment bytes decoded here; the caller only knows the files it forwarded.
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

  // Inbox-board SSE. Lazy import (init order with the dashboard); a missing module must not break routing.
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
 * Pair non-task turns live when the pre-turn contract activated. Containers are absent (gated), so a processing
 * row can return to pending; scheduled tasks are admitted by their due-time seam instead.
 */
export async function admitPendingUpgradeContexts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
): Promise<number> {
  // The one central read, first: the loop below is one synchronous pass over a single snapshot.
  const central = await resolveRecallCentral(agentGroupId, sessionId);
  // Under the lease: the pre-turn context carries a lease-only central read.
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

/** Evidence of real (non-migration) activity after the manifest: the mtime window alone cannot tell them apart. */
function sawRealActivityAfter(
  inboundPath: string,
  sinceMs: number,
  sessionId: string | undefined,
  centralDb: Database.Database | undefined,
): boolean {
  const dir = path.dirname(inboundPath);
  for (const name of UNTOUCHED_ACTIVITY_FILES) {
    try {
      // Floor before comparing: mtimeMs carries sub-millisecond precision, so a file touched just BEFORE the
      // manifest compares as after it, and the skipped restore would freeze the session's archival clock.
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
 * Restore mtimes an interrupted migration pass bumped. Conservative: an untouched file, or one that saw real
 * traffic after the pass, is left alone.
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
      // In the window, but real activity since means the clock is not ours to rewind.
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
 * Lazy session-DB migration over the workgroups' sessions, plus pending pre-turn admission. Pre-pass mtimes are
 * restored afterward: reclaim reads mtime as the idle clock, so migration DDL would otherwise reset every session's
 * clock at once and freeze archival fleet-wide. A session that ADMITS work keeps its new clock.
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
      // A 0-byte inbound.db is provably never provisioned (residue of a failed open); removing it restores the
      // reclaimed-and-no-inbound.db state the stub was defeating.
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
    // Per-target isolation: the caller exits the process on a throw, so one bad session DB must not take the
    // fleet down.
    try {
      // Existing-only: `undefined` means the session vanished since the stat; never re-provision on the startup path.
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
      // Keep the bumped clock: admissions commit per message, so earlier rows may be durable even though
      // `admittedHere` is 0, and rewinding over committed work could hand an active session to the archiver.
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
  // Deleted only after the loop completes: a failure outside the loop exits startup, and the manifest is then the
  // only record of what this pass bumped (so no `finally`).
  fs.rmSync(upgradeMtimeManifestPath(dataDir), { force: true });
  if (mtimesRestored > 0) {
    log.info('Session migration pass left the idle clock untouched', { sessions, mtimesRestored });
  }
  return { sessions, admitted, mtimesRestored, skipped, stubsRemoved };
}

/** Put a crashed provider turn behind its retry deadline without exposing the old pair to a warm poller. */
export function deferMessageForFreshContextRetry(
  mailbox: NanoclawMailboxSession,
  messageId: string,
  backoffSec: number,
): void {
  mailbox.deferForFreshContextRetry(messageId, backoffSec);
}

/**
 * Admit due scheduled occurrences and paired crash retries through the fresh recall seam. Scheduled rows are
 * stored trigger=0, so nothing can claim them before this host-owned step appends the recall row and flips
 * trigger=1 atomically; repeats are no-ops. Deferred on-wake rows keep on_wake=1 only until this barrier. Policy
 * lives here; every statement lives in the mailbox module.
 */
export async function admitDueTaskContexts(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
  withheld: ReadonlySet<string> = new Set(),
): Promise<number> {
  // The one central read, BEFORE the first inbound read, so the admission is one synchronous snapshot pass.
  const central = await resolveRecallCentral(agentGroupId, sessionId);
  // Under the lease: the recall rows read one lease-only central fact each.
  return withCentralSync(
    () => admitDueTaskContextsFor(mailbox, agentGroupId, sessionId, central, withheld),
    'admitDueTaskContexts',
  );
}

/** The synchronous half, for a caller whose mailbox action must not yield (resolve `resolveRecallCentral` first). */
export function admitDueTaskContextsFor(
  mailbox: NanoclawMailboxSession,
  agentGroupId: string,
  sessionId: string,
  central: RecallCentral,
  withheld: ReadonlySet<string> = new Set(),
): number {
  // An active repository ingress fence admits nothing (no new turn while mounts change); release replays the
  // deferred rows with their original triggers, so this defers rather than drops.
  if (mailbox.readRepoIngressFence()?.state === 'active') return 0;

  // Legacy rows were stored trigger=1: demote only unpaired live tasks before selecting due work.
  mailbox.demoteUnpairedLegacyTasks();

  let admitted = 0;
  for (const task of mailbox.listDueAdmissionRows()) {
    if (withheld.has(task.id)) continue;
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
  // the per-message subdir before any write lands outside the sandbox.
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
        // A crash can land between the exclusive write and the insert: accept only an identical regular file in the
        // validated inbox, so the replay finishes without weakening the symlink/overwrite defenses.
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
 * They land in the container-readable inbox with or without a row; the caller only knows files it forwarded.
 *
 * Best-effort; the refusal stands either way. A message dir goes only if empty (never a concurrent writer's file).
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
 * Push an inbox-board `session_event` for a container-state transition (best-effort). Exported for the fenced
 * finish in container-runner, which emits after its transaction commits.
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
