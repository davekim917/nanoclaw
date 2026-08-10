import { registerResource } from '../crud.js';
import { listUsageDaily } from '../../db/usage.js';

registerResource({
  name: 'usage',
  plural: 'usage',
  table: 'usage_daily',
  description:
    'Daily per-agent-group token/cost usage (fleet-hardening Phase 0.1), rolled up by the host sweep from ' +
    'container-reported turn_usage rows. Read-only; operator-only — deliberately not on the group-scope ' +
    'resource whitelist, so a container agent under cli_scope=group gets a clean rejection.',
  idColumn: 'date',
  columns: [
    { name: 'date', type: 'string', description: 'UTC day (YYYY-MM-DD).' },
    { name: 'agent_group_id', type: 'string', description: 'Agent group the usage belongs to.' },
    { name: 'provider', type: 'string', description: 'Agent provider (claude, codex, opencode, ...).' },
    { name: 'model', type: 'string', description: 'Model id, or empty string when the turn reported none.' },
    { name: 'turns', type: 'number', description: 'Number of turns rolled up into this row.' },
    { name: 'input_tokens', type: 'number', description: 'Summed input tokens.' },
    { name: 'output_tokens', type: 'number', description: 'Summed output tokens.' },
    { name: 'cache_read_tokens', type: 'number', description: 'Summed cache-read tokens.' },
    { name: 'cache_write_tokens', type: 'number', description: 'Summed cache-write tokens.' },
    { name: 'cost_usd', type: 'number', description: 'Summed cost in USD (0 when the provider reported none).' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List daily usage rollup rows, most recent day first.',
      args: [
        { name: 'group', type: 'string', description: 'Filter to one agent group id.' },
        { name: 'since', type: 'string', description: 'Only rows on/after this UTC date (YYYY-MM-DD).' },
        { name: 'days', type: 'number', description: 'Only rows from the last N days.' },
      ],
      handler: async (args) =>
        listUsageDaily({
          agentGroupId: args.group as string | undefined,
          sinceDate: args.since as string | undefined,
          days: args.days as number | undefined,
        }),
    },
  },
});
