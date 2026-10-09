/**
 * Routing check for a route-checked post (`thread-route-split.ts`) about to land in an existing thread: Jev judges
 * whether that thread already works the post's request; below the threshold, or on any failure, the post opens a new
 * thread instead. Every decision is stored in `thread_route_checks` for re-tuning.
 */
import { getDb } from './db/connection.js';
import { log } from './log.js';
import { readArchivedThread, type ArchivedThreadMessage } from './message-archive.js';
import { scrubSecrets } from './secret-scrubber.js';
import { ROUTE_CHECK_THRESHOLD, type RouteCheckPoint, type RouteCheckVerdict } from './thread-route-verdict.js';
import { askJev, JEV_MODEL, type JevQuestion } from './typesafe.js';

/**
 * Measured from when the runner queued the post; a check unfinished by then is a veto. The runner's ack wait outlasts
 * it and then tells the agent to assume a veto, so the two sides agree.
 */
export const ROUTE_CHECK_DEADLINE_MS = 20_000;

const JEV_TIMEOUT_MS = 5_000;

/** Hard cap on one check, whatever inside it hangs (Jev, the archive read, the score write). */
export const ROUTE_CHECK_TOTAL_TIMEOUT_MS = 8_000;

/** The watcher gate's `recent_threads` window: a thread with nothing newer was found by search (check point c). */
const RECENT_THREADS_WINDOW_MS = 48 * 60 * 60 * 1000;

const OPENER_CHARS = 240;
const LATEST_MESSAGES = 5;
const LATEST_CHARS = 300;

/** The host's archive copy of its own post; the platform's copy of the same message is already in the thread. */
const HOST_COPY_SENDER = 'assistant';

const ABOUT =
  "Dave keeps one Discord thread per request he is handling. A new Slack message to Dave is in `new_message`. Each candidate thread is one of Dave's threads from the last 48 hours: its opening message, written by Dave or by Axie (Dave's assistant, which opens a thread when it logs a request), and, when shown, its latest messages.";
const QUESTION =
  'Is `candidate_thread` already working on the same request as `new_message`, meaning the same deliverable or the same open question, so that `new_message` should be posted into that thread?';
const CRITERIA = {
  true: 'Same request. `new_message` follows up on the specific thing that thread is working on: it answers a question asked there, adds input or files for it, asks for its status, or repeats the same ask.',
  false:
    'Different request. The thread works on a different deliverable or question, even if it involves the same person, team, system or subject area.',
};

export interface RouteCheckRequest {
  /** `adopt`: the post's continue_thread picked the thread. `anchor`: the post's key already has this thread. */
  via: 'adopt' | 'anchor';
  threadKey: string;
  postText: string;
  channelType: string;
  platformId: string;
  threadPlatformId: string;
  agentGroupId: string;
  messagingGroupId: string;
  sessionId: string;
  messageOutId: string;
  /** The outbound row's timestamp: the deadline runs from when the runner queued the post. */
  queuedAt: string | undefined;
  /** Where a vetoed `anchor` post moves, for the record. */
  splitThreadKey?: string;
}

export interface RouteCheckDeps {
  ask: typeof askJev;
  readThread: typeof readArchivedThread;
  now: () => number;
}

const defaultDeps: RouteCheckDeps = { ask: askJev, readThread: readArchivedThread, now: Date.now };

function clip(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function threadView(threadPlatformId: string, messages: ArchivedThreadMessage[]): Record<string, unknown> {
  const opener =
    messages.find((m) => m.id === threadPlatformId || m.id.startsWith(`${threadPlatformId}:`)) ?? messages[0];
  const latest = messages
    .filter((m) => m !== opener && m.senderName !== HOST_COPY_SENDER)
    .slice(-LATEST_MESSAGES)
    .map((m) => ({ from: m.senderName, text: clip(scrubSecrets(m.text), LATEST_CHARS) }));
  return {
    opened_by: opener.senderName,
    opening_message: clip(scrubSecrets(opener.text), OPENER_CHARS),
    message_count: messages.length,
    ...(latest.length > 0 ? { latest_messages: latest } : {}),
  };
}

function routeCheckQuestion(view: Record<string, unknown>): JevQuestion {
  return {
    type: 'noul',
    instructions: { about: ABOUT, candidate_thread: view, question: QUESTION },
    criteria: CRITERIA,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deadlineOf(req: RouteCheckRequest, now: number): number {
  const queued = req.queuedAt === undefined ? NaN : Date.parse(req.queuedAt);
  return (Number.isFinite(queued) ? queued : now) + ROUTE_CHECK_DEADLINE_MS;
}

function failed(req: RouteCheckRequest, error: string): RouteCheckVerdict {
  return { keep: false, checkPoint: req.via === 'anchor' ? 'b' : 'a', score: null, error };
}

/** Past the deadline a check is a veto already; this much more lets it store that before the cap cuts it short. */
const DEADLINE_GRACE_MS = 1_000;

/**
 * Never rejects and never runs past `ROUTE_CHECK_TOTAL_TIMEOUT_MS`, or past the deadline plus a grace: whatever goes
 * wrong is a veto for this post, and nothing propagates into delivery.
 */
export async function checkThreadRouteBounded(
  req: RouteCheckRequest,
  deps: RouteCheckDeps = defaultDeps,
): Promise<RouteCheckVerdict> {
  const now = deps.now();
  const limitMs = Math.min(ROUTE_CHECK_TOTAL_TIMEOUT_MS, Math.max(0, deadlineOf(req, now) - now) + DEADLINE_GRACE_MS);
  const run = { cutShort: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<RouteCheckVerdict>((resolve) => {
    timer = setTimeout(() => {
      run.cutShort = true;
      resolve(failed(req, `routing check did not finish within ${limitMs} ms`));
    }, limitMs);
  });
  try {
    const checked = checkThreadRoute(req, deps, run).catch((err: unknown) => {
      run.cutShort = true;
      return failed(req, `routing check threw: ${message(err)}`);
    });
    const verdict = await Promise.race([checked, capped]);
    // The check never stored this one: store it, but never wait on a write that may be what hung.
    if (run.cutShort) void recordVerdict(req, verdict, deps.now() - now, null);
    return verdict;
  } finally {
    clearTimeout(timer);
  }
}

/** `run.cutShort`: the bounded caller already answered for this post, so a late finish must not store a second row. */
export async function checkThreadRoute(
  req: RouteCheckRequest,
  deps: RouteCheckDeps = defaultDeps,
  run: { cutShort: boolean } = { cutShort: false },
): Promise<RouteCheckVerdict> {
  const started = deps.now();
  const deadline = deadlineOf(req, started);
  let checkPoint: RouteCheckPoint = req.via === 'anchor' ? 'b' : 'a';
  let lastActivity: string | null = null;
  let score: number | null = null;
  let error: string | null = null;
  try {
    let messages: ArchivedThreadMessage[];
    try {
      messages = deps.readThread(req.channelType, req.platformId, req.threadPlatformId);
    } catch (err) {
      throw new Error(`archive read failed: ${message(err)}`, { cause: err });
    }
    if (messages.length === 0) throw new Error('thread has no archived messages');
    lastActivity = messages[messages.length - 1].sentAt;
    if (req.via === 'adopt' && started - Date.parse(lastActivity) > RECENT_THREADS_WINDOW_MS) checkPoint = 'c';
    const postText = scrubSecrets(req.postText).trim();
    if (!postText) throw new Error('post has no text to judge');
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw new Error('deadline passed before the check ran');
    const answers = await deps.ask(
      { new_message: postText },
      { same_request: routeCheckQuestion(threadView(req.threadPlatformId, messages)) },
      { timeoutMs: Math.min(JEV_TIMEOUT_MS, remaining) },
    );
    const noul = answers.same_request?.noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new Error('malformed Jev answer');
    }
    score = noul;
    if (deps.now() > deadline) throw new Error('deadline passed during the check');
    // eslint-disable-next-line no-catch-all/no-catch-all -- every failure is a veto for this post, recorded with its reason.
  } catch (err) {
    error = message(err);
  }
  const verdict: RouteCheckVerdict = {
    keep: error === null && score !== null && score >= ROUTE_CHECK_THRESHOLD,
    checkPoint,
    score,
    error,
  };
  if (run.cutShort) return verdict;
  const storeError = await recordVerdict(req, verdict, deps.now() - started, lastActivity);
  // A decision that cannot be stored cannot be re-tuned from: it takes the safe route too.
  return storeError && verdict.keep ? { ...verdict, keep: false, error: `score not stored: ${storeError}` } : verdict;
}

/** Null when stored; otherwise why not. */
async function recordVerdict(
  req: RouteCheckRequest,
  verdict: RouteCheckVerdict,
  latencyMs: number,
  lastActivity: string | null,
): Promise<string | null> {
  const decision = verdict.keep ? 'keep' : 'veto';
  const splitThreadKey = !verdict.keep && req.via === 'anchor' ? (req.splitThreadKey ?? null) : null;
  const fields = {
    id: req.messageOutId,
    sessionId: req.sessionId,
    threadKey: req.threadKey,
    candidateThreadId: req.threadPlatformId,
    checkPoint: verdict.checkPoint,
    score: verdict.score,
    threshold: ROUTE_CHECK_THRESHOLD,
    decision,
    latencyMs,
    model: JEV_MODEL,
    ...(verdict.error ? { error: verdict.error } : {}),
    ...(splitThreadKey ? { splitThreadKey } : {}),
  };
  if (verdict.error) log.warn('Thread routing check failed — opening a new thread', fields);
  else log.info('Thread routing check', fields);
  try {
    await getDb().run(
      `INSERT INTO thread_route_checks
         (checked_at, agent_group_id, messaging_group_id, session_id, message_out_id, thread_key, check_point,
          candidate_thread_id, thread_last_activity, score, threshold, decision, latency_ms, model, error,
          split_thread_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      req.agentGroupId,
      req.messagingGroupId,
      req.sessionId,
      req.messageOutId,
      req.threadKey,
      verdict.checkPoint,
      req.threadPlatformId,
      lastActivity,
      verdict.score,
      ROUTE_CHECK_THRESHOLD,
      decision,
      latencyMs,
      JEV_MODEL,
      verdict.error,
      splitThreadKey,
    );
    return null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unstored score turns into a veto, never a delivery failure.
  } catch (err) {
    log.warn('Thread routing check not stored', { id: req.messageOutId, err: message(err) });
    return message(err);
  }
}
