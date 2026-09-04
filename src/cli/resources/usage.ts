import { registerResource } from '../crud.js';
import { listUsageDaily, summarizeTurnUsage, USAGE_DIMENSION_NAMES } from '../../db/usage.js';
import type { UsageDimension } from '../../db/usage.js';

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
    {
      name: 'turns',
      type: 'number',
      description:
        'Turns that touched THIS (provider, model) bucket. True per row, but NEVER sum it across rows: ' +
        'a turn spanning several models increments one bucket per model (measured 1.40x fleet-wide). ' +
        'For an honest fleet turn count use `ncl usage summary`, which counts distinct turn_id.',
    },
    { name: 'input_tokens', type: 'number', description: 'Summed input tokens.' },
    { name: 'output_tokens', type: 'number', description: 'Summed output tokens.' },
    { name: 'cache_read_tokens', type: 'number', description: 'Summed cache-read tokens.' },
    { name: 'cache_write_tokens', type: 'number', description: 'Summed cache-write tokens.' },
    {
      name: 'cost_usd',
      type: 'number',
      description:
        'Summed cost in USD. 0 for a subscription-billed provider (see cost_applicable) means "not applicable", ' +
        'not "spent nothing" — check cost_applicable before reading 0 as free.',
    },
    {
      name: 'cost_applicable',
      type: 'boolean',
      generated: true,
      description:
        'Computed from provider, not stored: false for a provider whose protocol reports tokens only ' +
        '(e.g. Codex — ChatGPT-plan/subscription billing, no per-token cost field). When false, cost_usd is ' +
        'always 0 and carries no cost signal; use input_tokens/output_tokens as the spend proxy instead.',
    },
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
        await listUsageDaily({
          agentGroupId: args.group as string | undefined,
          sinceDate: args.since as string | undefined,
          days: args.days as number | undefined,
        }),
    },
    summary: {
      access: 'open',
      description:
        'Summarize the per-turn `turn_usage` ledger — the accurate one.\n\n' +
        'Unlike `list` (which reads the usage_daily rollup), `turns` here is COUNT(DISTINCT turn_id), so a\n' +
        'turn that spanned several models counts once. Tokens stay split into input / cache_read /\n' +
        'cache_write / output because cache_read is ~96% of fleet volume — collapsing them into one\n' +
        '"tokens" number hides where the spend actually goes. `cache_read_per_turn` is the column that\n' +
        'separates a context-heavy group from a merely chatty one.\n\n' +
        'The last row is TOTAL. It is queried WITHOUT the grouping, not summed from the rows above it:\n' +
        'with `--by model` (or any dimension one turn can straddle) a turn appears in several buckets, so\n' +
        'the buckets deliberately add up to more than the total.\n\n' +
        'The ledger is pruned at 30 days, so `--since`/`--days` beyond that return only what survives.',
      args: [
        {
          name: 'by',
          type: 'string',
          description: `Comma-separated dimensions to bucket by (${USAGE_DIMENSION_NAMES.join('|')}). Default: group.`,
        },
        { name: 'group', type: 'string', description: 'Filter to one agent group id.' },
        { name: 'since', type: 'string', description: 'Only turns on/after this UTC date (YYYY-MM-DD).' },
        { name: 'days', type: 'number', description: 'Only turns from the last N days.' },
      ],
      examples: [
        'ncl usage summary --days 7',
        'ncl usage summary --by provider --days 7',
        'ncl usage summary --by group,model --days 7',
        'ncl usage summary --by day --days 14',
        'ncl usage summary --by session --group <agent-group-id> --days 7',
      ],
      handler: async (args) =>
        await summarizeTurnUsage({
          dimensions: parseDimensions(args.by as string | undefined),
          agentGroupId: args.group as string | undefined,
          sinceDate: args.since as string | undefined,
          days: args.days as number | undefined,
        }),
    },
  },
});

/** Reject an unknown `--by` value loudly — a silent fallback to `group` would
 *  hand the operator a table that answers a different question than they
 *  asked, with nothing on screen saying so. */
function parseDimensions(by: string | undefined): UsageDimension[] | undefined {
  if (!by) return undefined;
  const dims = by
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const bad = dims.filter((d) => !(USAGE_DIMENSION_NAMES as string[]).includes(d));
  if (bad.length > 0) {
    throw new Error(`unknown --by dimension(s): ${bad.join(', ')} (valid: ${USAGE_DIMENSION_NAMES.join(', ')})`);
  }
  return dims as UsageDimension[];
}
