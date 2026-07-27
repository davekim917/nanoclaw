import { getAgentGroup } from '../../db/agent-groups.js';
import {
  DEFAULT_GRAPHIFY_TIMEOUT_MS,
  sendGraphifyRequest,
  type GraphifyClientRequest,
  type GraphifyCommand,
} from '../../graphify/client.js';
import { registerResource, type ColumnDef, type CustomOperation } from '../crud.js';
import type { CallerContext } from '../frame.js';

const MAX_QUERY_CHARS = 4_096;
const MAX_NODE_CHARS = 1_024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

const groupArg: ColumnDef = {
  name: 'group',
  type: 'string',
  description: 'Agent group id (required on the host; derived from caller identity inside a container).',
};

const timeoutArg: ColumnDef = {
  name: 'timeout_ms',
  type: 'number',
  description: `Socket deadline in milliseconds (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}; default ${DEFAULT_GRAPHIFY_TIMEOUT_MS}).`,
  default: DEFAULT_GRAPHIFY_TIMEOUT_MS,
};

function requiredText(args: Record<string, unknown>, key: string, maxChars: number): string {
  const value = args[key];
  const flag = `--${key.replace(/_/g, '-')}`;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${flag} is required`);
  const trimmed = value.trim();
  if (trimmed.length > maxChars) throw new Error(`${flag} exceeds ${maxChars} characters`);
  return trimmed;
}

function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = args[key] ?? fallback;
  const number = Number(value);
  const flag = `--${key.replace(/_/g, '-')}`;
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function resolveWorkgroup(
  args: Record<string, unknown>,
  ctx: CallerContext,
): {
  workgroupId: string;
  agentGroupId?: string;
  sessionId?: string;
} {
  const agentGroupId = ctx.caller === 'agent' ? ctx.agentGroupId : requiredText(args, 'group', MAX_NODE_CHARS);
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error(`agent group not found: ${agentGroupId}`);
  if (!agentGroup.workgroup_id) throw new Error(`agent group ${agentGroupId} has no workgroup`);
  if (ctx.caller === 'agent') {
    return { workgroupId: agentGroup.workgroup_id, agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId };
  }
  return { workgroupId: agentGroup.workgroup_id };
}

async function forward(
  command: GraphifyCommand,
  args: Record<string, unknown>,
  ctx: CallerContext,
  daemonArgs: Record<string, unknown>,
): Promise<unknown> {
  const scope = resolveWorkgroup(args, ctx);
  const timeoutMs = boundedInteger(args, 'timeout_ms', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_GRAPHIFY_TIMEOUT_MS);
  const request: GraphifyClientRequest = { ...scope, command, args: daemonArgs };
  return sendGraphifyRequest(request, { timeoutMs });
}

function formatHuman(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === undefined) return 'Graphify request completed.';
  return JSON.stringify(data, null, 2);
}

function operation(
  access: 'open' | 'approval',
  description: string,
  args: ColumnDef[],
  handler: CustomOperation['handler'],
  examples?: string[],
): CustomOperation {
  return { access, description, args: [...args, groupArg, timeoutArg], handler, examples, formatHuman };
}

registerResource({
  name: 'Graphify request',
  plural: 'graphify',
  table: 'workgroups',
  description:
    'Workgroup-scoped knowledge graph across conversations, documents, analytics artifacts, and code. Agent callers are always pinned to their own workgroup.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    query: operation(
      'open',
      'Search the current workgroup knowledge graph.',
      [
        { name: 'query', type: 'string', description: 'Natural-language or exact-term search.', required: true },
        { name: 'limit', type: 'number', description: 'Maximum results (1-100).', default: 20 },
      ],
      async (args, ctx) =>
        forward('query', args, ctx, {
          query: requiredText(args, 'query', MAX_QUERY_CHARS),
          limit: boundedInteger(args, 'limit', 1, 100, 20),
        }),
      ['ncl graphify query --query "customer retention" --group example-retail'],
    ),
    path: operation(
      'open',
      'Find a short evidence-backed path between two graph nodes.',
      [
        { name: 'from', type: 'string', description: 'Starting node id or resolvable label.', required: true },
        { name: 'to', type: 'string', description: 'Destination node id or resolvable label.', required: true },
        { name: 'max_depth', type: 'number', description: 'Maximum traversed edges (1-12).', default: 6 },
      ],
      async (args, ctx) =>
        forward('path', args, ctx, {
          from: requiredText(args, 'from', MAX_NODE_CHARS),
          to: requiredText(args, 'to', MAX_NODE_CHARS),
          maxDepth: boundedInteger(args, 'max_depth', 1, 12, 6),
        }),
      ['ncl graphify path --from "conversation:123" --to "model:orders" --group example-retail'],
    ),
    explain: operation(
      'open',
      'Explain a node with its evidence and nearby relationships.',
      [
        { name: 'node', type: 'string', description: 'Node id or resolvable label.', required: true },
        { name: 'depth', type: 'number', description: 'Neighborhood depth (0-5).', default: 2 },
      ],
      async (args, ctx) =>
        forward('explain', args, ctx, {
          node: requiredText(args, 'node', MAX_NODE_CHARS),
          depth: boundedInteger(args, 'depth', 0, 5, 2),
        }),
      ['ncl graphify explain --node "model:orders" --group example-retail'],
    ),
    affected: operation(
      'open',
      'List transitive dependents using structural graph edges.',
      [
        { name: 'node', type: 'string', description: 'Changed node id or resolvable label.', required: true },
        { name: 'depth', type: 'number', description: 'Maximum dependency depth (1-12).', default: 6 },
        { name: 'limit', type: 'number', description: 'Maximum results (1-200).', default: 100 },
      ],
      async (args, ctx) =>
        forward('affected', args, ctx, {
          node: requiredText(args, 'node', MAX_NODE_CHARS),
          depth: boundedInteger(args, 'depth', 1, 12, 6),
          limit: boundedInteger(args, 'limit', 1, 200, 100),
        }),
      ['ncl graphify affected --node "model:orders" --group example-retail'],
    ),
    status: operation(
      'open',
      'Show freshness, coverage, quarantine, and pending-work status for the selected workgroup.',
      [],
      async (args, ctx) => forward('status', args, ctx, {}),
      ['ncl graphify status --group example-retail'],
    ),
    'ensure-fresh': operation(
      'open',
      'Wait up to the bounded deadline for already-discovered changes to become queryable.',
      [],
      async (args, ctx) => forward('ensure-fresh', args, ctx, {}),
      ['ncl graphify ensure-fresh --group example-retail --timeout-ms 60000'],
    ),
    reindex: operation(
      'approval',
      'Queue a workgroup reindex. Agent callers require administrator approval.',
      [
        {
          name: 'full',
          type: 'boolean',
          description: 'Discard derived state and request a full rebuild.',
          default: false,
        },
      ],
      async (args, ctx) => forward('reindex', args, ctx, { full: args.full === true }),
      ['ncl graphify reindex --group example-retail --full'],
    ),
    pause: operation(
      'approval',
      'Pause background indexing for a workgroup. Agent callers require administrator approval.',
      [],
      async (args, ctx) => forward('pause', args, ctx, {}),
      ['ncl graphify pause --group example-retail'],
    ),
    resume: operation(
      'approval',
      'Resume background indexing for a workgroup. Agent callers require administrator approval.',
      [],
      async (args, ctx) => forward('resume', args, ctx, {}),
      ['ncl graphify resume --group example-retail'],
    ),
  },
});
