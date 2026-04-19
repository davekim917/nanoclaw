/**
 * Self-modification module — admin-approved container mutations.
 *
 * Optional tier. Depends on the approvals default module for the request/
 * handler plumbing. On install the module registers:
 *   - Three delivery actions (install_packages, request_rebuild, add_mcp_server)
 *     that validate input and queue an approval via requestApproval().
 *   - Three matching approval handlers that run on approve: mutate the
 *     container config, rebuild the image, kill the container so the next
 *     wake picks up the change.
 *
 * Without this module: the three MCP tools in the container still write
 * outbound system messages with these actions, but delivery logs
 * "Unknown system action" and drops them. Admin never sees a card; nothing
 * changes.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { applyAddMcpServer, applyInstallPackages, applyRequestRebuild } from './apply.js';
import { handleAddMcpServer, handleInstallPackages, handleRequestRebuild } from './request.js';

registerDeliveryAction('install_packages', handleInstallPackages);
registerDeliveryAction('request_rebuild', handleRequestRebuild);
registerDeliveryAction('add_mcp_server', handleAddMcpServer);

registerApprovalHandler('install_packages', applyInstallPackages);
registerApprovalHandler('request_rebuild', applyRequestRebuild);
registerApprovalHandler('add_mcp_server', applyAddMcpServer);
