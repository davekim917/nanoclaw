/**
 * Support-threads module — routes each support email thread to its own Slack
 * working thread + per-issue session. Registers the `dispatch_support_issue`
 * delivery action the inbox-poller agent calls per triaged ticket.
 *
 * See docs/specs/per-email-thread-sessions/scope.md.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleDispatchSupportIssue, handleUpdateSupportTicket } from './dispatch.js';

const SUPPORT_ACTION = unguarded(
  'workgroup-scoped support routing; handlers resolve configured destinations from trusted host state',
);
registerDeliveryAction('dispatch_support_issue', handleDispatchSupportIssue, SUPPORT_ACTION);
registerDeliveryAction('update_support_ticket', handleUpdateSupportTicket, SUPPORT_ACTION);
