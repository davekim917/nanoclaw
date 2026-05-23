import {
  addProviderModel,
  getProviderModel,
  listProviderModels,
  removeProviderModel,
} from '../../db/provider-models.js';
import { registerResource } from '../crud.js';

/**
 * Operator allowlist of valid `model` slugs per provider. The agent's
 * `change_model` self-mod tool and `ncl groups config update --model X`
 * both validate against this table; a slug not present here is rejected.
 *
 * Composite primary key (provider, slug) — the generic CRUD's single-`id`
 * verbs don't fit cleanly, so list/add/remove are exposed as customOperations
 * with explicit param shapes.
 */
registerResource({
  name: 'provider-model',
  plural: 'provider-models',
  table: 'provider_models',
  description:
    'Provider-model allowlist — operator-curated set of model slugs each provider is permitted to use. Validated when a group config is updated or when an agent invokes change_model.',
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
      description: 'Runtime model identifier (e.g. opencode/kimi-k2.6, claude-opus-4-7).',
    },
    { name: 'display_name', type: 'string', description: 'Human label.' },
    { name: 'notes', type: 'string', description: 'Operator notes shown in lists.' },
    {
      name: 'default_effort',
      type: 'string',
      description: 'Suggested effort level when this model is selected.',
      enum: ['low', 'medium', 'high'],
    },
    { name: 'supports_effort', type: 'string', description: '1 if the model honors effort levels.' },
    { name: 'is_default', type: 'string', description: '1 if this is the provider default. ≤1 per provider.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    add: {
      access: 'approval',
      description:
        'Add a model to a provider allowlist. Use --provider <name> --slug <slug> [--display-name <name>] [--notes <text>] [--default-effort low|medium|high] [--supports-effort] [--is-default].',
      handler: async (args) => {
        const provider = args.provider as string;
        const slug = args.slug as string;
        if (!provider) throw new Error('--provider is required');
        if (!slug) throw new Error('--slug is required');

        if (getProviderModel(provider, slug)) {
          throw new Error(`Already in allowlist: ${provider} / ${slug}`);
        }

        const defaultEffort = args.default_effort as string | undefined;
        if (defaultEffort && !['low', 'medium', 'high'].includes(defaultEffort)) {
          throw new Error('--default-effort must be one of: low, medium, high');
        }

        addProviderModel({
          provider,
          slug,
          display_name: (args.display_name as string | undefined) ?? null,
          notes: (args.notes as string | undefined) ?? null,
          default_effort: (defaultEffort as 'low' | 'medium' | 'high' | undefined) ?? null,
          supports_effort: args.supports_effort === true,
          is_default: args.is_default === true,
        });

        return { added: { provider, slug } };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove a model from a provider allowlist. Use --provider <name> --slug <slug>.',
      handler: async (args) => {
        const provider = args.provider as string;
        const slug = args.slug as string;
        if (!provider) throw new Error('--provider is required');
        if (!slug) throw new Error('--slug is required');

        const existing = getProviderModel(provider, slug);
        if (!existing) throw new Error(`Not in allowlist: ${provider} / ${slug}`);

        removeProviderModel(provider, slug);
        return { removed: { provider, slug } };
      },
    },
    'list-by-provider': {
      access: 'open',
      description:
        'List models allowed for a specific provider, default-first. Use --provider <name>. Use this instead of `list` when you want to scope to one provider.',
      handler: async (args) => {
        const provider = args.provider as string;
        if (!provider) throw new Error('--provider is required');
        const models = listProviderModels(provider);
        return { provider, count: models.length, models };
      },
    },
  },
});
