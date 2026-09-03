/**
 * Typed entry points for fork callers.
 *
 * `session-manager.ts` owns the nesting guard and the provision-vs-exists
 * decision, and already types its action as `NanoclawMailboxSession` — the
 * shape `mailbox/compose.ts` guarantees every action receives, since it is
 * what registers `NanoclawAgentMailbox`. These two wrappers are the
 * fork-named entry points most callers reach for; they supply the name, not a
 * narrowing.
 *
 * Deliberately a separate file from `index.ts`: this one imports
 * `session-manager.ts`, which imports the mailbox barrel, which composes this
 * module. Nothing on that path imports this file, so the cycle never forms.
 */
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';

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
