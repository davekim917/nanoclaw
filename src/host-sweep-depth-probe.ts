/**
 * Test-only depth probe over the mailbox nesting guard (seam 2, R-10).
 *
 * Seam-2-owned, and deliberately NOT parked in `src/modules/mailbox/session.ts`.
 * The mailbox series deletes that file outright (mailbox seam PR 7, issue #301)
 * and rewrites its import block on the way there (PR 4 round 4), so a seam-2
 * support surface living in it would be collateral in someone else's refactor.
 * This reads `session-manager.ts` directly, which is where the nesting guard
 * and its `activeMailboxKeys` store actually live.
 *
 * What R-10 asserts with it: a duty never holds a mailbox session across a kill
 * or a wake. Both open a session on the same key, so holding one across either
 * deadlocks (invariant I-3). Asserting `ctx.mailbox === null` is not the same
 * assertion — a duty could open its own session and kill inside the callback.
 */
export { _mailboxSessionDepthForTesting } from './session-manager.js';
