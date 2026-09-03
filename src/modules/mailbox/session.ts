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
import type Database from 'better-sqlite3';

import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';

import { composeOutboundOps, sessionMailboxPath } from './index.js';
import { openOutboundDb, openOutboundDbWritable, sessionDbPathIsGone } from './openers.js';
import type { NanoclawMailboxSession, NanoclawOutboundSession } from './index.js';

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
 * Run one operation against a session's OUTBOUND database alone.
 *
 * Resolves `undefined` — never provisions, never throws — when `outbound.db`
 * is genuinely absent. That is the never-woken shape: the container owns that
 * file, and one that never ran has not written it.
 *
 * Deliberately NOT `withExistingNanoclawSession`. That funnel's existence
 * check is keyed on `inbound.db`, so it answers `undefined` for a session
 * whose inbound.db is gone while outbound.db remains — a real cohort — and any
 * caller reading outbound state through it reports that state as empty when it
 * is not. Three separate review findings on this PR were instances of that one
 * mistake. The rule the seam settles on: the existence question a read asks is
 * keyed to the file the read actually touches.
 *
 * The action receives the module's TYPED outbound ops, not a raw
 * `Database` — a handle leaving the module is the shape the seam exists to
 * remove (invariant I-9), whether or not the ratchet's name patterns happen to
 * catch the parameter. The ops are the same composition `forkOps` spreads, so
 * an op cannot behave differently depending on which funnel reached it.
 *
 * Both handles open lazily and only if the action asks: a pure read never
 * opens the writer, and once the writer is open the reads share it, so a
 * clear-then-verify sees its own write on one connection. A file that is
 * present but will not open raises `SessionDbUnopenableError` from the
 * opener — unreadable is a fault, never an empty answer. A file that vanishes
 * between the existence check and the first op raises `SessionDbMissingError`
 * rather than resolving `undefined`; that race is a fault too.
 */
export async function withExistingNanoclawOutbound<T>(
  agentGroupId: string,
  sessionId: string,
  action: (outbound: NanoclawOutboundSession) => T,
): Promise<T | undefined> {
  const outboundPath = sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
  if (sessionDbPathIsGone(outboundPath)) return undefined;
  let readable: Database.Database | undefined;
  let writable: Database.Database | undefined;
  try {
    return action(
      composeOutboundOps(
        () => writable ?? (readable ??= openOutboundDb(outboundPath)),
        () => (writable ??= openOutboundDbWritable(outboundPath)),
        true,
      ),
    );
  } finally {
    writable?.close();
    readable?.close();
  }
}
