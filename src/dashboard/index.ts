/** Wires every dashboard route. Dispatch is first-match, so API routes must be registered before the static splat. */
import { register, requireAuth, registerCookieVerifier } from './router.js';
import { ensureServerStarted } from '../webhook-server.js';
import { startSSEFeed, eventsHandler } from './api/events.js';
import { indexHtmlHandler, staticHandler } from './static.js';

/** 301 preserving the query string. */
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
import {
  signalOverviewHandler,
  signalDecisionHandler,
  signalReviewHandler,
  signalDispatchHandler,
  signalProjectHandler,
} from './observatory-v2/api.js';
import { observatoryAssignHandler } from './assign.js';
import { observatoryIssueBriefHandler } from './issue-brief.js';
import { observatoryNudgeHandler } from './nudge.js';
import { observatorySteerHandler } from './observatory-steer.js';
import { reportGate, workgroupReportHandler } from './workgroup-reports.js';

// These register their routes and handlers at module load.
import './auth/exchange.js';
import './api/auth-me.js';
import './auth/dashboard-token-issue.js';
import './auth/dashboard-token-slash-command.js';

let started = false;

export function startDashboard(): void {
  if (started) return;
  started = true;

  import('./auth/cookie.js')
    .then((cookieMod) => {
      const serverKey = cookieMod.resolveServerKey();
      registerCookieVerifier((cookieHeader) => cookieMod.parseAndVerifyCookie(cookieHeader, serverKey));
    })
    .catch((err) => {
      console.error('Failed to wire cookie verifier', err);
    });

  startSSEFeed();

  register('GET', '/dashboard/api/events', requireAuth(eventsHandler));
  register('GET', '/dashboard/api/sessions', requireAuth(sessionsHandler));
  register('GET', '/dashboard/api/sessions/:id', requireAuth(sessionsDetailHandler));
  // Thread-keyed, not session-keyed; the inbox board still uses `/sessions`.
  register('GET', '/dashboard/api/threads', requireAuth(threadsHandler));
  register('GET', '/dashboard/api/threads/:id', requireAuth(threadsDetailHandler));
  // Assign is the same call as steer with an agent that has no session yet; see thread-message.ts. Snooze is
  // admin-gated; see thread-snooze.ts.
  register('POST', '/dashboard/api/threads/:id/message', requireAuth(threadMessageHandler));
  register('POST', '/dashboard/api/threads/:id/snooze', requireAuth(threadSnoozeHandler));
  register('POST', '/dashboard/api/threads/:id/unsnooze', requireAuth(threadUnsnoozeHandler));
  // The only action that ends work: guarded, server-counted confirmations, never a hide.
  register('POST', '/dashboard/api/threads/:id/close', requireAuth(threadCloseHandler));
  register('GET', '/dashboard/api/groups', requireAuth(groupsListHandler));
  register('GET', '/dashboard/api/messaging-groups', requireAuth(messagingGroupsListHandler));
  register('POST', '/dashboard/api/sessions/:id/message', requireAuth(sessionMessageHandler));

  // Each workgroup sub-route has its own segment count, so their order does not matter.
  register('GET', '/dashboard/api/workgroups', requireAuth(workgroupsListHandler));
  register('GET', '/dashboard/api/workgroup/:id/summary', requireAuth(workgroupSummaryHandler));
  register('GET', '/dashboard/api/workgroup/:id/usage', requireAuth(workgroupUsageHandler));
  register('GET', '/dashboard/api/workgroup/:id/claims', requireAuth(workgroupClaimsHandler));
  register('GET', '/dashboard/api/observatory', requireAuth(observatoryHandler));
  register('GET', '/dashboard/api/observatory/v2', requireAuth(signalOverviewHandler));
  register('GET', '/dashboard/api/observatory/v2/decisions/:id', requireAuth(signalDecisionHandler));
  register('POST', '/dashboard/api/observatory/v2/decisions/:id/review', requireAuth(signalReviewHandler));
  register('POST', '/dashboard/api/observatory/v2/decisions/:id/dispatch', requireAuth(signalDispatchHandler));
  register('PUT', '/dashboard/api/observatory/v2/projects/:id', requireAuth(signalProjectHandler));
  register('POST', '/dashboard/api/observatory/assign', requireAuth(observatoryAssignHandler));
  register('POST', '/dashboard/api/observatory/nudge', requireAuth(observatoryNudgeHandler));
  register('POST', '/dashboard/api/observatory/steer', requireAuth(observatorySteerHandler));
  register('GET', '/dashboard/api/observatory/issue-brief', requireAuth(observatoryIssueBriefHandler));
  register('GET', '/dashboard/reports/:id/*tail', reportGate(workgroupReportHandler));

  // Routes match by exact segment count, but `/search` and `/:key` share one and `:key` captures anything: `/search`
  // MUST be registered before `/:key`. The static splat stays LAST.
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

  // Static assets: public, no auth, splat LAST. /observatory is the page URL; the API stays under /dashboard/api/*.
  // Old page URLs 301 so stored links keep working.
  register('GET', '/observatory', redirectTo('/observatory/'));
  register('GET', '/observatory/', indexHtmlHandler);
  register('GET', '/dashboard', redirectTo('/observatory/'));
  register('GET', '/dashboard/', redirectTo('/observatory/'));
  register('GET', '/dashboard/static/*tail', staticHandler);

  ensureServerStarted();
}
