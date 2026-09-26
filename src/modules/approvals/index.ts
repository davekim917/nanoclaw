/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory OneCLI credential approvals.
 *   - A message-interceptor (via ./reason-capture.js) that captures an admin's
 *     one-line reply after they click "Reject with reason…".
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly, registered on
 *     the host lifecycle (upstream's own shape, src/host-lifecycle.ts).
 *
 * Exposes `sweepAwaitingReasonRejects` for the host sweep to finalize ghosted
 * reject-with-reason holds (re-exported here, which also loads reason-capture
 * so its interceptor registers).
 *
 * Self-mod flows (install_packages, add_mcp_server) live in
 * `src/modules/self-mod/` and register delivery actions
 * + approval handlers via this module's public API.
 */
import { onDeliveryAdapterReady } from '../../delivery.js';
import { registerResponseHandler } from '../../response-registry.js';
import { onHostShutdown } from '../../host-lifecycle.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';
// Host-sweep hook for ghosted "Reject with reason…" holds. The re-export also
// loads reason-capture.js, registering its message-interceptor on import.
export { sweepAwaitingReasonRejects } from './reason-capture.js';

registerResponseHandler(handleApprovalsResponse);

onDeliveryAdapterReady((adapter) => {
  startOneCLIApprovalHandler(adapter);
});

onHostShutdown(function approvalsHostShutdown() {
  stopOneCLIApprovalHandler();
});
