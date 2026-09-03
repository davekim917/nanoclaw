/**
 * Test harness for the session DBs.
 *
 * Builds upstream's in-memory baseline (which also flips upstream's connection
 * module into test mode, so openInboundDb/getInboundDb/getOutboundDb resolve to
 * these handles), then applies the fork schema through the SAME functions
 * production uses — tests and production share one schema source.
 *
 * Importing this module registers the fork mailbox, so the compat shims in
 * db/*.ts (which go through getAgentMailbox()) work inside tests.
 */
import type { Database } from 'bun:sqlite';

// Module barrel — loads registration modules, including the singular mailbox slot.
import '../index.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import {
  closeSessionDb as upstreamCloseSessionDb,
  initTestSessionDb as upstreamInitTestSessionDb,
} from '../../mailbox/sqlite/connection.js';
import { ensureNanoclawInboundTestSchema, ensureNanoclawOutboundSchema } from './schema.js';
import { setMailboxTestMode } from './index.js';

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
  setMailboxTestMode(true);
  const { inbound, outbound } = upstreamInitTestSessionDb();
  ensureNanoclawInboundTestSchema(inbound);
  ensureNanoclawOutboundSchema(outbound);
  // Registered by the barrel import above. The schema is applied synchronously
  // here rather than through start(), whose await boundary would push it into a
  // microtask and break this function's synchronous contract; production runs
  // the same two functions from NanoclawAgentMailbox.start().
  getAgentMailbox();
  return { inbound, outbound };
}

export function closeSessionDb(): void {
  upstreamCloseSessionDb();
}
