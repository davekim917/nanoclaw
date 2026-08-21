/**
 * Dashboard bootstrap.
 *
 * Wire-up site for all dashboard routes. Groups C and D register their
 * handlers here; Group A's router enforces first-match dispatch so API
 * routes must be registered before the static splat catch-all.
 */
import { register, requireAuth, registerCookieVerifier } from './router.js';
import { ensureServerStarted } from '../webhook-server.js';
import { startSSEFeed, stopSSEFeed, eventsHandler } from './api/events.js';
import { indexHtmlHandler, staticHandler } from './static.js';

/** 301 preserving the query string — the token link rides `?token=`. */
function redirectTo(target: string) {
  return async (req: Request): Promise<Response> => {
    const q = new URL(req.url).search;
    return new Response(null, { status: 301, headers: { Location: target + q } });
  };
}
import { sessionsHandler, sessionsDetailHandler } from './api/sessions.js';
import { threadsHandler, threadsDetailHandler } from './api/threads.js';
import { groupsListHandler } from './api/groups.js';
import { messagingGroupsListHandler } from './api/messaging-groups.js';
import { sessionMessageHandler } from './steer.js';
import { threadMessageHandler } from './thread-message.js';
import { threadSnoozeHandler, threadUnsnoozeHandler } from './thread-snooze.js';
import { threadCloseHandler } from './thread-close.js';
import { scheduledListHandler, scheduledDetailHandler, scheduledSearchHandler } from './api/scheduled-read.js';
import { editHandler, pauseHandler, resumeHandler, runNowHandler, cancelHandler } from './api/scheduled-mutations.js';
import { movePreviewHandler, moveExecuteHandler } from './api/scheduled-move.js';
import {
  workgroupsListHandler,
  workgroupSummaryHandler,
  workgroupUsageHandler,
  workgroupClaimsHandler,
} from './api/workgroups.js';
import { observatoryHandler } from './api/observatory.js';
import { observatoryAssignHandler } from './assign.js';
import { observatoryIssueBriefHandler } from './issue-brief.js';
import { observatoryNudgeHandler } from './nudge.js';
import { observatorySteerHandler } from './observatory-steer.js';

// Side-effect imports — these files register their routes/handlers at module load
import './auth/exchange.js'; // POST /dashboard/api/auth/exchange
import './api/auth-me.js'; // GET /dashboard/api/auth/me
import './auth/dashboard-token-issue.js'; // registers 'dashboard_token_issue' intercept handler
import './auth/dashboard-token-slash-command.js'; // registers native '/dashboard-token' slash-command handler

let started = false;

export function startDashboard(): void {
  if (started) return;
  started = true;

  // Wire cookie verifier — B5 (auth/cookie.ts) ships the real implementation.
  import('./auth/cookie.js')
    .then((cookieMod) => {
      const serverKey = cookieMod.resolveServerKey();
      registerCookieVerifier((cookieHeader) => cookieMod.parseAndVerifyCookie(cookieHeader, serverKey));
    })
    .catch((err) => {
      console.error('Failed to wire cookie verifier', err);
    });

  // SSE feed lifecycle
  startSSEFeed();

  // Auth-gated API routes (requireAuth wrap):
  register('GET', '/dashboard/api/events', requireAuth(eventsHandler));
  register('GET', '/dashboard/api/sessions', requireAuth(sessionsHandler));
  register('GET', '/dashboard/api/sessions/:id', requireAuth(sessionsDetailHandler));
  // Observatory console (DESIGN.md §3) — thread-keyed, NOT session-keyed. The
  // `/sessions` pair above is untouched; the inbox board still uses it.
  register('GET', '/dashboard/api/threads', requireAuth(threadsHandler));
  register('GET', '/dashboard/api/threads/:id', requireAuth(threadsDetailHandler));
  // Triage's `S` verdict. Per-user view state, gated on visibility rather than
  // the admin gate the mutating verbs use — see thread-snooze.ts.
  // The console's one primitive: send a message to a chosen agent on this
  // thread. Assign is the same call with an agent that has no session yet — the
  // gate, rate limit and echo are `steer.ts`'s, unchanged (thread-message.ts).
  register('POST', '/dashboard/api/threads/:id/message', requireAuth(threadMessageHandler));
  register('POST', '/dashboard/api/threads/:id/snooze', requireAuth(threadSnoozeHandler));
  register('POST', '/dashboard/api/threads/:id/unsnooze', requireAuth(threadUnsnoozeHandler));
  // The only action that ends work. Guarded (`threads.close`), server-counted
  // confirmations, and never a hide — see thread-close.ts.
  register('POST', '/dashboard/api/threads/:id/close', requireAuth(threadCloseHandler));
  register('GET', '/dashboard/api/groups', requireAuth(groupsListHandler));
  register('GET', '/dashboard/api/messaging-groups', requireAuth(messagingGroupsListHandler));
  register('POST', '/dashboard/api/sessions/:id/message', requireAuth(sessionMessageHandler));

  // Workgroup dashboard (fleet-hardening Phase 3) — read-only. :id must
  // appear after the other single-segment sub-resources it doesn't collide
  // with; each sub-route is its own segment count so ordering among them
  // doesn't matter (unlike /scheduled's /search-vs-/:key collision).
  register('GET', '/dashboard/api/workgroups', requireAuth(workgroupsListHandler));
  register('GET', '/dashboard/api/workgroup/:id/summary', requireAuth(workgroupSummaryHandler));
  register('GET', '/dashboard/api/workgroup/:id/usage', requireAuth(workgroupUsageHandler));
  register('GET', '/dashboard/api/workgroup/:id/claims', requireAuth(workgroupClaimsHandler));
  register('GET', '/dashboard/api/observatory', requireAuth(observatoryHandler));
  register('POST', '/dashboard/api/observatory/assign', requireAuth(observatoryAssignHandler));
  register('POST', '/dashboard/api/observatory/nudge', requireAuth(observatoryNudgeHandler));
  register('POST', '/dashboard/api/observatory/steer', requireAuth(observatorySteerHandler));
  register('GET', '/dashboard/api/observatory/issue-brief', requireAuth(observatoryIssueBriefHandler));

  // Scheduled Tasks Board — 10 routes (design §3b + prompt/title search). The
  // `scheduled` namespace is distinct from `tasks` (the spawn board owns that).
  // All auth-gated. Route matching is by exact segment count (router.ts:104), so
  // `/move` (4 segs) and `/move/preview` (5 segs) are unambiguous regardless of
  // order. BUT `/search` and `/:key` share a segment count, and `:key` captures
  // any segment — dispatch is first-match (router.ts:205), so `/search` MUST be
  // registered before `/:key` or it'd be swallowed as a key. Static `*tail` splat
  // stays LAST.
  register('GET', '/dashboard/api/scheduled', requireAuth(scheduledListHandler));
  register('GET', '/dashboard/api/scheduled/search', requireAuth(scheduledSearchHandler));
  register('GET', '/dashboard/api/scheduled/:key', requireAuth(scheduledDetailHandler));
  register('PUT', '/dashboard/api/scheduled/:key', requireAuth(editHandler));
  register('POST', '/dashboard/api/scheduled/:key/pause', requireAuth(pauseHandler));
  register('POST', '/dashboard/api/scheduled/:key/resume', requireAuth(resumeHandler));
  register('POST', '/dashboard/api/scheduled/:key/run-now', requireAuth(runNowHandler));
  register('POST', '/dashboard/api/scheduled/:key/cancel', requireAuth(cancelHandler));
  register('POST', '/dashboard/api/scheduled/:key/move/preview', requireAuth(movePreviewHandler));
  register('POST', '/dashboard/api/scheduled/:key/move', requireAuth(moveExecuteHandler));

  // Static assets — public, no auth (design §6). Splat must be LAST.
  //
  // /observatory is the canonical page URL (the product is the Observatory;
  // "dashboard" was the scaffolding's name). The API namespace stays
  // /dashboard/api/* — it is invisible to the address bar, the SPA and the
  // token flow both speak it, and renaming it buys nothing but churn. The old
  // page URLs 301 so every stored link and the chat token flow keep working.
  register('GET', '/observatory', redirectTo('/observatory/'));
  register('GET', '/observatory/', indexHtmlHandler);
  register('GET', '/dashboard', redirectTo('/observatory/'));
  register('GET', '/dashboard/', redirectTo('/observatory/'));
  register('GET', '/dashboard/static/*tail', staticHandler);

  ensureServerStarted();
}

export function stopDashboard(): void {
  stopSSEFeed();
}
