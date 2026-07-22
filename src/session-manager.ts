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
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { deriveAttachmentName } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { assertChannelRoutingConsistency } from './delivery.js';
import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createSession,
  findSystemSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  taskThreadId,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  upsertSessionRouting,
  insertMessage,
  insertMessageIfNew,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
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
 * (e.g. illie + illie-codex) bind-mount this same host path at
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
 * wired to the same channel via TWO Slack apps (`slack-illysium` +
 * `slack-illiecodex` both seeing `slack:C0AJA89MN2E`), they share the same
 * platform_id and therefore the same worktree path — that's what makes
 * cross-bot collaboration work.
 *
 * Nested dirs (not a flat `<mg>:<thread>` key) because Docker's `-v` flag
 * uses `:` as the field separator between source:target:options. A colon in
 * the host path turns `-v src:dst` into a three-part `src:dst:opts` which
 * Docker rejects with exit 125. fsSlug strips any embedded colons too.
 */
export function threadWorktreeDir(platformId: string, threadId: string | null): string {
  const tid = threadId ?? `dm-${platformId}`;
  return path.join(threadsBaseDir(), fsSlug(tid), 'worktrees');
}

/** Per-session Graphify cache. Sessions never share this directory. */
export function sessionGraphifyCacheDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'graphify-cache');
}

/** Thread-scoped Graphify cache shared by sibling agents in one conversation. */
export function threadGraphifyCacheDir(platformId: string, threadId: string | null): string {
  const tid = threadId ?? `dm-${platformId}`;
  return path.join(threadsBaseDir(), fsSlug(tid), 'graphify-cache');
}

/** Install-scoped runtime state for the Graphify gateway. */
export function graphifyRuntimeDir(): string {
  return path.join(DATA_DIR, 'graphify-runtime');
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
 * Group-level auto-memory dir. Overlay-mounted at
 * `/home/node/.claude/projects/<hash>/memory` INSIDE the per-session projects
 * mount so Claude Code's auto-memory (MEMORY.md + autodream pruning) stays
 * shared across every session in the agent group regardless of channel or
 * thread.
 *
 * Points at the same physical path the SDK has been using under the outer
 * `.claude-shared` mount (`.claude-shared/projects/<hash>/memory/`). That way:
 *   - Existing MEMORY.md carries forward when the per-session projects
 *     overlay first engages — no migration step needed.
 *   - Auto-dream pruning from any session lands in the same file every other
 *     session sees.
 *   - If a future migration ever moves session transcripts elsewhere, memory
 *     stays put.
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
  const alreadyExisted = fs.existsSync(projectsDir);
  fs.mkdirSync(projectsDir, { recursive: true });
  const memoryDir = groupClaudeMemoryDir(agentGroupId);
  fs.mkdirSync(memoryDir, { recursive: true });

  // One-time migration from the pre-per-session layout. Older sessions
  // wrote their transcripts into the group-shared
  // `.claude-shared/projects/<hash>/` dir alongside every other session's
  // files. The per-session overlay can't see those unless we copy them
  // forward — otherwise the first wake on the new layout loses all prior
  // thread context and the agent appears to have amnesia.
  //
  // Heuristic: only migrate on first creation of the per-session dir (when
  // `alreadyExisted` is false). We copy the single `<sessionId>.jsonl` and
  // the full `sessions-index.json` from the group-shared projects dir;
  // side-tables like `shell-snapshots` can rebuild themselves. If there's
  // no group-shared transcript for this session_id, migrate is a no-op.
  if (!alreadyExisted) {
    try {
      const sharedProjects = path.join(
        DATA_DIR,
        'v2-sessions',
        agentGroupId,
        '.claude-shared',
        'projects',
        CLAUDE_CODE_PROJECTS_DIR,
      );
      if (fs.existsSync(sharedProjects)) {
        // Best-effort copy — any .jsonl that exists in shared lands in the
        // per-session dir. We don't filter by session_id because the SDK's
        // sdk_session_id in outbound.db may not match the on-disk filename
        // after compact-boundary rotations; copying all jsonls for this
        // agent group is safe since only the session's own resume id will
        // be passed as `resume`.
        for (const entry of fs.readdirSync(sharedProjects)) {
          if (!entry.endsWith('.jsonl')) continue;
          const src = path.join(sharedProjects, entry);
          const dst = path.join(projectsDir, entry);
          if (fs.existsSync(dst)) continue;
          fs.copyFileSync(src, dst);
        }
        const idxSrc = path.join(sharedProjects, 'sessions-index.json');
        const idxDst = path.join(projectsDir, 'sessions-index.json');
        if (fs.existsSync(idxSrc) && !fs.existsSync(idxDst)) {
          fs.copyFileSync(idxSrc, idxDst);
        }
        log.info('Migrated session transcripts from shared .claude dir', {
          agentGroupId,
          sessionId,
        });
      }
    } catch (err) {
      log.warn('Shared-to-per-session .claude migration failed — session may start without prior context', {
        agentGroupId,
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
/** Find or create the isolated session for one task series (thread `system:tasks:<seriesId>`). */
export function resolveTaskSession(agentGroupId: string, seriesId: string): { session: Session; created: boolean } {
  const threadId = taskThreadId(seriesId);
  const existing = findSystemSession(agentGroupId, threadId);
  if (existing) return { session: existing, created: false };

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
  initSessionFolder(agentGroupId, id);
  log.info('Task session created', { id, agentGroupId, seriesId });

  return { session, created: true };
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');

  // Pre-create per-session Claude Code projects dir with container-uid
  // ownership. See prepareSessionClaudeDir docstring for why this is
  // load-bearing.
  prepareSessionClaudeDir(agentGroupId, sessionId);
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination.
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

  const db = openInboundDb(agentGroupId, sessionId);
  let inserted: boolean;
  try {
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
      trigger: message.trigger ?? 1,
      sourceSessionId: message.sourceSessionId ?? null,
      onWake: message.onWake ?? 0,
    };
    if (ignoreDuplicateId) {
      inserted = insertMessageIfNew(db, row);
    } else {
      insertMessage(db, row);
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
  migrateMessagesInTable(db);
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
