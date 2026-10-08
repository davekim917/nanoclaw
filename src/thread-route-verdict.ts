/**
 * What delivery needs from the routing check without loading it: the verdict, the veto notice, and `routeVerdict`,
 * which runs the check (Jev, archive, DB) in the background for a route-checked post and turns any failure into a
 * veto, so no delivery cycle ever waits on it.
 */
import { log } from './log.js';
import type { RouteCheckRequest } from './thread-route-check.js';

/** Calibrated on jev-1.13.0 with the check's exact question and thread view; re-tune from `thread_route_checks`. */
export const ROUTE_CHECK_THRESHOLD = 0.35;

export type RouteCheckPoint = 'a' | 'b' | 'c';

export interface RouteCheckVerdict {
  keep: boolean;
  checkPoint: RouteCheckPoint;
  score: number | null;
  error: string | null;
}

/** Discord opens a thread at its starter message's id; elsewhere the encoded thread id is the reference. */
function threadReference(platformId: string, rootMessageId: string): string {
  const [scheme, guildId] = platformId.split(':');
  if (scheme === 'discord' && /^\d+$/.test(guildId ?? '') && /^\d+$/.test(rootMessageId)) {
    return `https://discord.com/channels/${guildId}/${rootMessageId}`;
  }
  return `${platformId}:${rootMessageId}`;
}

/** Delivered to the agent through the runner's ack. Plain enough to act on without interpretation. */
export function routeVetoNotice(input: {
  verdict: RouteCheckVerdict;
  threadKey: string;
  candidateThreadId: string;
  platformId: string;
  rootMessageId: string | undefined;
  splitThreadKey?: string;
}): string {
  const { verdict, threadKey, candidateThreadId, splitThreadKey } = input;
  const why =
    verdict.error !== null || verdict.score === null
      ? `the routing check failed (${verdict.error ?? 'no score'})`
      : `routing check score ${verdict.score.toFixed(2)} is below ${ROUTE_CHECK_THRESHOLD}`;
  const opened = input.rootMessageId
    ? `This post opened a NEW thread: ${threadReference(input.platformId, input.rootMessageId)}.`
    : 'This post opened a NEW thread.';
  if (splitThreadKey) {
    return (
      `ROUTING CHECK VETO: thread ${candidateThreadId} is not working on this request (${why}). ${opened} ` +
      `Its thread_key is "${splitThreadKey}". Use thread_key "${splitThreadKey}" for this request's topic file, its ` +
      `dispatch and every later post about it. Thread_key "${threadKey}" stays with the earlier request.`
    );
  }
  return (
    `ROUTING CHECK VETO: continue_thread ${candidateThreadId} is not working on this request (${why}). ${opened} ` +
    `Keep using thread_key "${threadKey}" for this request; it now points at the new thread.`
  );
}

/**
 * A kept verdict stands only for a post delivered this soon after the runner queued it. Later, the runner has stopped
 * waiting for the ack and told the agent to assume a veto, so the host makes it one.
 */
export const ROUTE_CHECK_DELIVER_BY_MS = 40_000;

/** A verdict nobody collected (its row was dropped, or its session went away) is forgotten after this long. */
const VERDICT_MEMORY_MS = 10 * 60 * 1000;

interface RouteCheckEntry {
  candidate: string;
  startedAt: number;
  verdict?: RouteCheckVerdict;
}

const routeChecks = new Map<string, RouteCheckEntry>();

/**
 * The verdict for this post, or `pending` while its check runs. The first call starts the check in the background:
 * the post stays queued, and a later delivery cycle delivers it from the stored verdict. Keyed by outbound row, so a
 * retried row reuses its verdict and never asks Jev twice.
 */
export function routeVerdict(req: RouteCheckRequest): RouteCheckVerdict | 'pending' {
  const now = Date.now();
  const candidate = `${req.via}:${req.threadPlatformId}`;
  const known = routeChecks.get(req.messageOutId);
  if (known?.candidate === candidate) return known.verdict ? expireKeep(req, known.verdict, now) : 'pending';
  for (const [id, entry] of routeChecks) if (now - entry.startedAt > VERDICT_MEMORY_MS) routeChecks.delete(id);
  const entry: RouteCheckEntry = { candidate, startedAt: now };
  routeChecks.set(req.messageOutId, entry);
  void judgeRoute(req).then((verdict) => {
    entry.verdict = verdict;
  });
  return 'pending';
}

/** After the post landed: its verdict is spent. */
export function forgetRouteVerdict(messageOutId: string): void {
  routeChecks.delete(messageOutId);
}

function expireKeep(req: RouteCheckRequest, verdict: RouteCheckVerdict, now: number): RouteCheckVerdict {
  const queued = req.queuedAt === undefined ? NaN : Date.parse(req.queuedAt);
  if (!verdict.keep || !Number.isFinite(queued) || now - queued <= ROUTE_CHECK_DELIVER_BY_MS) return verdict;
  log.warn('Kept routing verdict expired before delivery — opening a new thread', {
    id: req.messageOutId,
    threadKey: req.threadKey,
    score: verdict.score,
  });
  return { ...verdict, keep: false, error: 'kept verdict expired before delivery' };
}

/** Never rejects: a check that cannot load or throws is a veto (the post opens a new thread); the check bounds its time. */
async function judgeRoute(req: RouteCheckRequest): Promise<RouteCheckVerdict> {
  try {
    const { checkThreadRouteBounded } = await import('./thread-route-check.js');
    return await checkThreadRouteBounded(req);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a check that cannot run is a veto for this post, never a delivery failure.
  } catch (err) {
    const error = `routing check unavailable: ${err instanceof Error ? err.message : String(err)}`;
    log.warn('Thread routing check unavailable — opening a new thread', {
      id: req.messageOutId,
      threadKey: req.threadKey,
      err: error,
    });
    return { keep: false, checkPoint: req.via === 'anchor' ? 'b' : 'a', score: null, error };
  }
}
