/** Test harness: builds upstream's in-memory baseline, then the fork schema through the same functions production uses. */
import type { Database } from 'bun:sqlite';

// Module barrel — loads registration modules, including the singular mailbox slot.
import '../index.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import {
  closeSessionDb as upstreamCloseSessionDb,
  initTestSessionDb as upstreamInitTestSessionDb,
} from '../../mailbox/sqlite/connection.js';
import { ensureNanoclawInboundTestSchema, ensureNanoclawOutboundSchema } from './schema.js';
import { resetProviderExecutingScopes } from './container-state.js';
import { clearTickRepositoryBarrier } from './selection.js';
import { setMailboxTestMode } from './index.js';

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  setMailboxTestMode(true);
  // A fresh session DB starts a fresh poll tick — never inherit the previous
  // test's memoized fence token.
  clearTickRepositoryBarrier();
  // Zero the module-level busy scopes without a DB write, so no test inherits another's.
  resetProviderExecutingScopes();
  const { inbound, outbound } = upstreamInitTestSessionDb();
  ensureNanoclawInboundTestSchema(inbound);
  ensureNanoclawOutboundSchema(outbound);
  // Schema applied synchronously, not via start(), whose await would break this function's synchronous contract.
  getAgentMailbox();
  return { inbound, outbound };
}

export function closeSessionDb(): void {
  upstreamCloseSessionDb();
}
