/**
 * Live work outside the current conversation, attached to every pre-turn context: the workgroup's unexpired claims
 * and the open task lists of the other active sessions of this agent group and its workgroup siblings, each with its
 * thread. A session can only hold or route a request that overlaps unfinished work it can see, and a claim alone is
 * found only by guessing its slug.
 */
import { readClaims, type BoardClaim } from './claims-board.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { isTaskThread } from './db/sessions.js';
import { log } from './log.js';
import { withExistingNanoclawOutboundSync } from './modules/mailbox/index.js';
import type { TaskListInFlight } from './modules/mailbox/ops/session-state.js';
import { boundedText } from './modules/memory/pre-turn-context.js';

export const LIVE_WORK_BOUNDS = Object.freeze({
  /** A list untouched this long reads as abandoned, not in flight. */
  listWindowMs: 24 * 60 * 60 * 1000,
  /** Session databases opened per digest, most recently active first: the digest is built on every turn. */
  candidateSessions: 40,
  sessions: 6,
  itemsPerSession: 3,
  claims: 10,
  titleChars: 120,
  itemChars: 120,
  waitingOnChars: 60,
  noteChars: 160,
});

const CLIPPED = ' …';

interface LiveWorkSession {
  owner: string;
  self: boolean;
  channel: string | null;
  threadId: string | null;
  link: string | null;
  title: string;
  items: string[];
  updatedAt: string;
}

interface LiveWorkClaim {
  slug: string;
  owner: string;
  state: Exclude<BoardClaim['state'], 'stale'>;
  note: string;
  threadId: string | null;
  link: string | null;
}

export interface LiveWorkDigest {
  sessions: LiveWorkSession[];
  claims: LiveWorkClaim[];
  omitted: number;
  /** The candidate scan hit its cap, so an empty snapshot does not show that nothing is under way. */
  partial: boolean;
}

export interface LiveWorkDeps {
  now?: number;
  claimsRoot?: string;
  linkFor?: (threadId: string) => Promise<string | null>;
}

async function defaultLinkFor(threadId: string): Promise<string | null> {
  const { threadPermalink } = await import('./dashboard/api/observatory.js');
  return threadPermalink(threadId);
}

const CLAIM_ORDER: Record<LiveWorkClaim['state'], number> = { live: 0, expiring: 1, paused: 2, parked: 3 };

interface CandidateRow {
  id: string;
  agent_group_id: string;
  owner: string;
  thread_id: string | null;
  channel: string | null;
}

interface OpenList {
  row: CandidateRow;
  list: TaskListInFlight;
}

interface OwnConversation {
  sessionId: string;
  threadId: string | null;
  platformId: string | null;
}

async function readOpenLists(
  agentGroupId: string,
  workgroupId: string | null,
  own: OwnConversation,
  now: number,
): Promise<{ open: OpenList[]; partial: boolean }> {
  const since = new Date(now - LIVE_WORK_BOUNDS.listWindowMs).toISOString();
  const rows = await getDb().all<CandidateRow>(
    `SELECT s.id AS id, s.agent_group_id AS agent_group_id, ag.name AS owner, s.thread_id AS thread_id,
            mg.name AS channel
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
      WHERE (s.agent_group_id = ? OR ag.workgroup_id = ?)
        AND s.id != ? AND s.status = 'active' AND s.archived_at IS NULL
        AND (? IS NULL OR s.thread_id IS NOT ?)
        AND (? IS NOT NULL OR ? IS NULL OR NOT (s.thread_id IS NULL AND mg.platform_id IS ?))
        AND datetime(COALESCE(s.last_active, s.created_at)) >= datetime(?)
      ORDER BY datetime(COALESCE(s.last_active, s.created_at)) DESC
      LIMIT ?`,
    agentGroupId,
    workgroupId,
    own.sessionId,
    own.threadId,
    own.threadId,
    own.threadId,
    own.platformId,
    own.platformId,
    since,
    LIVE_WORK_BOUNDS.candidateSessions,
  );
  const open: OpenList[] = [];
  for (const row of rows) {
    let list: TaskListInFlight | null | undefined;
    try {
      list = withExistingNanoclawOutboundSync(row.agent_group_id, row.id, (outbound) =>
        outbound.readTaskListInFlight(),
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable session database must not blank the others
    } catch (err) {
      log.debug('Live work digest: unreadable session, skipped', { sessionId: row.id, err });
      continue;
    }
    if (!list || !(Date.parse(list.at) >= now - LIVE_WORK_BOUNDS.listWindowMs)) continue;
    if (list.unfinished.length + list.waiting.length === 0) continue;
    open.push({ row, list });
  }
  open.sort((a, b) => Date.parse(b.list.at) - Date.parse(a.list.at) || a.row.id.localeCompare(b.row.id));
  return { open, partial: rows.length >= LIVE_WORK_BOUNDS.candidateSessions };
}

function markedItems(list: TaskListInFlight): string[] {
  const item = (text: string) => boundedText(text, LIVE_WORK_BOUNDS.itemChars, CLIPPED);
  const waitingOn = (who: string | null) =>
    who ? ` (waiting on ${boundedText(who, LIVE_WORK_BOUNDS.waitingOnChars, CLIPPED)})` : '';
  return [
    ...list.unfinished.filter((i) => i.status === 'in_progress').map((i) => `✱ ${item(i.text)}`),
    ...list.waiting.map((i) => `◷ ${item(i.text)}${waitingOn(i.waitingOn)}`),
    ...list.unfinished.filter((i) => i.status !== 'in_progress').map((i) => `○ ${item(i.text)}`),
  ].slice(0, LIVE_WORK_BOUNDS.itemsPerSession);
}

async function collect(agentGroupId: string, sessionId: string, deps: LiveWorkDeps): Promise<LiveWorkDigest | null> {
  const now = deps.now ?? Date.now();
  const linkFor = deps.linkFor ?? defaultLinkFor;
  const own = await getDb().get<{ thread_id: string | null; platform_id: string | null }>(
    `SELECT s.thread_id AS thread_id, mg.platform_id AS platform_id
       FROM sessions s LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
      WHERE s.id = ?`,
    sessionId,
  );
  const ownThread = own?.thread_id ?? null;
  const link = async (threadId: string | null) => (threadId && !isTaskThread(threadId) ? linkFor(threadId) : null);

  const workgroupId = (await getAgentGroup(agentGroupId))?.workgroup_id ?? null;
  const { open: lists, partial } = await readOpenLists(
    agentGroupId,
    workgroupId,
    { sessionId, threadId: ownThread, platformId: own?.platform_id ?? null },
    now,
  );
  const sessions: LiveWorkSession[] = [];
  for (const { row, list } of lists.slice(0, LIVE_WORK_BOUNDS.sessions)) {
    sessions.push({
      owner: row.owner,
      self: row.agent_group_id === agentGroupId,
      channel: row.channel ?? (isTaskThread(row.thread_id) ? 'scheduled task' : null),
      threadId: row.thread_id,
      link: await link(row.thread_id),
      title: boundedText(list.title ?? '(untitled list)', LIVE_WORK_BOUNDS.titleChars, CLIPPED),
      items: markedItems(list),
      updatedAt: list.at,
    });
  }

  const board = workgroupId
    ? deps.claimsRoot === undefined
      ? readClaims(workgroupId, now)
      : readClaims(workgroupId, now, deps.claimsRoot)
    : [];
  const live = board
    .filter((c): c is BoardClaim & { state: LiveWorkClaim['state'] } => c.state !== 'stale')
    .filter((c) => ownThread === null || c.threadId !== ownThread)
    .sort((a, b) => CLAIM_ORDER[a.state] - CLAIM_ORDER[b.state] || a.slug.localeCompare(b.slug));
  const claims: LiveWorkClaim[] = [];
  for (const c of live.slice(0, LIVE_WORK_BOUNDS.claims)) {
    claims.push({
      slug: c.slug,
      owner: c.owner,
      state: c.state,
      note: boundedText(c.note, LIVE_WORK_BOUNDS.noteChars, CLIPPED),
      threadId: c.threadId,
      link: await link(c.threadId),
    });
  }

  return { sessions, claims, omitted: lists.length - sessions.length + (live.length - claims.length), partial };
}

/** Empty when nothing is live elsewhere, null when unreadable. Never throws: a failure must not cost the turn its recall. */
export async function buildLiveWorkDigest(
  agentGroupId: string,
  sessionId: string,
  deps: LiveWorkDeps = {},
): Promise<LiveWorkDigest | null> {
  try {
    return await collect(agentGroupId, sessionId, deps);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the digest is advisory; the turn and its recall still land
  } catch (err) {
    log.warn('Live work digest unavailable — the turn proceeds without it', {
      agentGroupId,
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
