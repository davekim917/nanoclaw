import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleDispatchSupportIssue, handleUpdateSupportTicket } from './dispatch.js';

const SUPPORT_ACTION = unguarded(
  'workgroup-scoped support routing; handlers resolve configured destinations from trusted host state',
);
registerDeliveryAction('dispatch_support_issue', handleDispatchSupportIssue, SUPPORT_ACTION);
registerDeliveryAction('update_support_ticket', handleUpdateSupportTicket, SUPPORT_ACTION);
