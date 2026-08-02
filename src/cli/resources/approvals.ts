import { registerResource } from '../crud.js';
import { resolveApprovalFromHost } from '../../modules/approvals/response-handler.js';

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (self-mod install_packages/add_mcp_server) and OneCLI credential approval flow. Rows are deleted after the admin approves/rejects or the request expires.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for OneCLI credential approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (OneCLI request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description:
        'Action type — matches the registered approval handler (e.g. install_packages, add_mcp_server, onecli_credential).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    { name: 'channel_type', type: 'string', description: 'Channel the approval card was delivered on.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID the card was delivered to.' },
    {
      name: 'platform_message_id',
      type: 'string',
      description: 'Platform message ID of the delivered card (for editing on expiry).',
    },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (OneCLI gateway TTL).' },
    {
      name: 'status',
      type: 'string',
      description: 'Current status.',
      enum: ['pending', 'approved', 'rejected', 'expired'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    approve: {
      access: 'open',
      description:
        'Resolve a pending approval as APPROVED from the host terminal — same effect as clicking Approve on the card. ' +
        'Use --id <approval-id>. Host operator only; the DM card (wherever it landed) becomes a no-op after this. ' +
        'OneCLI credential approvals cannot be resolved here.',
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') throw new Error('Agents cannot resolve approvals.');
        const id = args.id as string;
        if (!id) throw new Error('--id <approval-id> is required');
        const result = await resolveApprovalFromHost(id, 'approve', 'host-operator');
        if (!result.resolved) throw new Error(result.error ?? 'approval not resolved');
        return { approved: id };
      },
    },
    reject: {
      access: 'open',
      description:
        'Resolve a pending approval as REJECTED from the host terminal — same effect as clicking Reject on the card. ' +
        'Use --id <approval-id>. Host operator only.',
      handler: async (args, ctx) => {
        if (ctx.caller === 'agent') throw new Error('Agents cannot resolve approvals.');
        const id = args.id as string;
        if (!id) throw new Error('--id <approval-id> is required');
        const result = await resolveApprovalFromHost(id, 'reject', 'host-operator');
        if (!result.resolved) throw new Error(result.error ?? 'approval not resolved');
        return { rejected: id };
      },
    },
  },
});
