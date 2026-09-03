/**
 * Typed entry points for fork callers.
 *
 * `session-manager.ts` owns the nesting guard and the provision-vs-exists
 * decision, and types its action against upstream's `MailboxSession` — the
 * only shape upstream's contract promises. The fork registers
 * `NanoclawAgentMailbox`, so every action actually receives a
 * `NanoclawMailboxSession`; these two wrappers say so once, here, instead of
 * making each of the ~20 fork callers repeat the same cast.
 *
 * Deliberately a separate file from `index.ts`: this one imports
 * `session-manager.ts`, which imports the mailbox barrel, which composes this
 * module. Nothing on that path imports this file, so the cycle never forms.
 */
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';

/** Test-only depth probe over the nesting guard `session-manager.ts` owns (seam 2 R-10). */
export { _mailboxSessionDepthForTesting } from '../../session-manager.js';

import type { NanoclawMailboxSession } from './index.js';

/** Run one operation against a session's mailbox, provisioning it if absent. */
export function withNanoclawSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
): Promise<T> {
  return withMailboxSession(agentGroupId, sessionId, (mailbox) => action(mailbox as NanoclawMailboxSession));
}

/**
 * Run one operation against an already-provisioned mailbox.
 *
 * Resolves `undefined` — never provisions, never throws — when the session has
 * no mailbox on disk. That is the read-path contract (invariant I-4): sweep,
 * recovery and storage callers treat `undefined` as "no mailbox here".
 */
export function withExistingNanoclawSession<T>(
  agentGroupId: string,
  sessionId: string,
  action: (mailbox: NanoclawMailboxSession) => T | Promise<T>,
): Promise<T | undefined> {
  return withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => action(mailbox as NanoclawMailboxSession));
}
