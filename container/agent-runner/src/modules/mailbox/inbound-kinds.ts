/**
 * M-1: the inventoried set of `messages_in.kind` values this install actually
 * writes (docs/specs/upstream-mailbox-seam/plan.md §5 row 1, §7 risk 2).
 *
 * Upstream's SqliteAgentMailbox.parseInboundRecord (src/mailbox/model.ts) rejects
 * any `kind` outside `chat|chat-sdk|task|webhook|system` and the runner's
 * getPendingMessages SKIPS rows that fail to parse. Before the runner adopts the
 * mailbox seam (PR R1), the fork's own inbound-record parser must be built over
 * a set proven to cover every kind this fleet actually produces, or a real inbound
 * row goes silently missing from selection. This file is that proof, not a guess.
 *
 * Measurement (2026-09-03, read-only `SELECT kind, COUNT(*) FROM messages_in
 * GROUP BY kind` over every /home/ubuntu/nanoclaw-v2/data/v2-sessions/&#42;/&#42;/inbound.db
 * on the live production install):
 *
 *   kind       total_rows   dbs_with_kind
 *   chat             1046   254
 *   chat-sdk        33326   1017
 *   system          14262   855
 *   task            12561   303
 *
 *   DBs found: 1400, opened successfully: 1400, skipped (unreadable/corrupt): 0.
 *
 * Static write-site trace (every call site of insertMessage, insertMessageIfNew,
 * insertMessageWithContext, insertMessageWithContextIfNew,
 * insertDeferredMessageWithContextIfNew, writeSessionMessage,
 * writeSessionMessageIfNew, and the two raw-SQL task inserters):
 *
 *   - 'chat'     — src/router.ts (event.message.kind, InboundEvent.message.kind
 *                  typed 'chat' | 'chat-sdk' in src/channels/adapter.ts) and ~20 more
 *                  writeSessionMessage call sites across host-sweep.ts, delivery,
 *                  orchestrator-dispatch, self-mod, approvals, repository-workspaces,
 *                  scheduled-wake, agent-to-agent, support-threads, host-restart-warn,
 *                  cli/resources/groups.ts, dashboard/steer.ts, container-restart.ts,
 *                  modules/scheduling/recurrence.ts.
 *   - 'chat-sdk' — src/router.ts (same InboundEvent path, Chat SDK adapters).
 *   - 'system'   — src/modules/interactive/index.ts, src/modules/orchestrator-dispatch/
 *                  cancellation.ts, src/cli/delivery-action.ts,
 *                  src/modules/repository-workspaces/index.ts, and the recall-context
 *                  marker rows built in src/session-manager.ts and
 *                  src/db/session-db.ts (id prefix `recall-`, not a distinct kind).
 *   - 'task'     — src/modules/scheduling/db.ts and src/db/scheduled-tasks.ts
 *                  (both raw `INSERT INTO messages_in (...) VALUES (..., 'task', ...)`,
 *                  not through the named insert functions above).
 *   - 'webhook'  — no live writer found on this install, but it is the fork's own
 *                  declared closed set too: src/types.ts
 *                  `export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';`
 *                  Kept in the set on that authority, not the (currently zero) measurement.
 *
 * measured ∪ static ∪ upstream's five all resolve to the SAME five values — the
 * fork does not write any kind outside upstream's closed set. Recall-context and
 * status-style system notices are 'system'-kind rows distinguished by an id prefix
 * (`recall-…`) or JSON content shape, never a separate `kind` column value.
 *
 * R1's fork inbound-record parser (parseNanoclawInboundRecord) is closed over this
 * set; R-3 (container/agent-runner/src/modules/mailbox/mailbox.test.ts, once R1 lands)
 * is parameterized over INBOUND_KINDS with a negative control proving the parser
 * still rejects anything outside it.
 */
export const INBOUND_KINDS = ['chat', 'chat-sdk', 'system', 'task', 'webhook'] as const;

export type InboundKind = (typeof INBOUND_KINDS)[number];
