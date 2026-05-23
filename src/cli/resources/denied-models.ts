import {
  addDeniedModel,
  getDeniedModel,
  listDeniedModels,
  removeDeniedModel,
} from '../../db/denied-models.js';
import { registerResource } from '../crud.js';

/**
 * Operator-curated blocklist of (provider, slug) pairs the agent must
 * never use. The agent's reachable model set comes live from
 * `opencode models` (inside the container) — this table is the small
 * "operator says no" layer subtracted from that set.
 *
 * Composite primary key (provider, slug) — the generic CRUD's single-`id`
 * verbs don't fit, so list/add/remove are exposed as customOperations.
 */
registerResource({
  name: 'denied-model',
  plural: 'denied-models',
  table: 'denied_models',
  description:
    'Blocklist of model slugs the agent must never use. Validated when a group config is updated, when an agent invokes change_model, and applied as a filter inside list_models. Empty by default — operator adds entries to forbid specific slugs (e.g. anthropic/claude-opus-4-7 to prevent wrong-subscription bills).',
  idColumn: 'slug',
  columns: [
    {
      name: 'provider',
      type: 'string',
      description: 'Matches container_configs.provider (e.g. opencode, codex, claude).',
    },
    {
      name: 'slug',
      type: 'string',
      description:
        'Runtime model identifier WITH prefix, exactly as the container would set it (e.g. anthropic/claude-opus-4-7, opencode-go/kimi-k2.6).',
    },
    { name: 'reason', type: 'string', description: 'Operator note shown in the error when denied.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    add: {
      access: 'approval',
      description:
        'Add a slug to the deny list. Use --provider <name> --slug <slug> [--reason <text>]. Reason is shown to whoever tries to use the slug.',
      handler: async (args) => {
        const provider = args.provider as string;
        const slug = args.slug as string;
        if (!provider) throw new Error('--provider is required');
        if (!slug) throw new Error('--slug is required');

        if (getDeniedModel(provider, slug)) {
          throw new Error(`Already denied: ${provider} / ${slug}`);
        }

        addDeniedModel(provider, slug, (args.reason as string | undefined) ?? null);
        return { added: { provider, slug, reason: (args.reason as string | undefined) ?? null } };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove a slug from the deny list. Use --provider <name> --slug <slug>.',
      handler: async (args) => {
        const provider = args.provider as string;
        const slug = args.slug as string;
        if (!provider) throw new Error('--provider is required');
        if (!slug) throw new Error('--slug is required');

        const existing = getDeniedModel(provider, slug);
        if (!existing) throw new Error(`Not denied: ${provider} / ${slug}`);

        removeDeniedModel(provider, slug);
        return { removed: { provider, slug } };
      },
    },
    'list-by-provider': {
      access: 'open',
      description: 'List denials for a specific provider. Use --provider <name>.',
      handler: async (args) => {
        const provider = args.provider as string;
        if (!provider) throw new Error('--provider is required');
        const denied = listDeniedModels(provider);
        return { provider, count: denied.length, denied };
      },
    },
  },
});
