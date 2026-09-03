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
import type Database from 'better-sqlite3';

import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';

/** Test-only depth probe over the nesting guard `session-manager.ts` owns (seam 2 R-10). */
export { _mailboxSessionDepthForTesting } from '../../session-manager.js';

import { sessionMailboxPath } from './index.js';
import { openOutboundDbWritable, withOpenedSessionDb } from './openers.js';
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

/**
 * Run one operation against a session's OUTBOUND database alone, writable.
 *
 * Resolves `undefined` — never provisions, never throws — when `outbound.db`
 * is genuinely absent, which is the never-woken shape: the container owns that
 * file and one that never ran has not written it.
 *
 * Deliberately NOT `withExistingNanoclawSession`. That funnel's existence
 * check is keyed on `inbound.db`, so it answers `undefined` for a session
 * whose inbound.db is gone while outbound.db remains — a real cohort, named in
 * `host-sweep.ts`'s usage-rollup comment — and a caller reading outbound state
 * would then report that state as empty when it is not. An outbound-only
 * operation asks an outbound-only existence question. Same reasoning, and the
 * same module funnel, as the usage rollup.
 *
 * A file that is present but will not open still raises
 * `SessionDbUnopenableError` from the opener: unreadable is a fault, never an
 * empty answer.
 */
export async function withExistingNanoclawOutbound<T>(
  agentGroupId: string,
  sessionId: string,
  action: (outbound: Database.Database) => T,
): Promise<T | undefined> {
  // The open/absent/close dance is the module's shared one — see
  // `withOpenedSessionDb`. What is specific here is only WHICH opener: the
  // writable outbound funnel, because the force-clear writes.
  return withOpenedSessionDb(
    () => openOutboundDbWritable(sessionMailboxPath({ agentGroupId, sessionId }, 'outbound')),
    action,
  );
}
