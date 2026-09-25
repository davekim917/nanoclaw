import { DEFAULT_AGENT_PROVIDER } from '../config.js';
import type { ContainerConfigRow } from '../types.js';
import { getDb } from './connection.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  'timezone',
]);
const JSON_COLUMNS = new Set([
  'skills',
  'mcp_servers',
  'packages_apt',
  'packages_npm',
  'additional_mounts',
  'security_json',
]);

/**
 * Resolve the provider name for a session using the precedence documented in
 * the provider-install skills:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 * Lives here (not container-runner.ts, which re-exports it) so light
 * consumers — e.g. the router's provider-aware flag parsing — don't have to
 * import the container runner, which half the test suite factory-mocks.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

/**
 * Exported for the synchronous blocks the plan allowlists (§4.5, I-1): guard
 * decisions and the storage pass execute these on the raw handle rather than
 * calling the async exports below.
 */
export const CONTAINER_CONFIG_BY_GROUP_SQL = 'SELECT * FROM container_configs WHERE agent_group_id = ?';
export const CONTAINER_CONFIGS_ALL_SQL = 'SELECT * FROM container_configs';

export async function getContainerConfig(agentGroupId: string): Promise<ContainerConfigRow | undefined> {
  return getDb().get<ContainerConfigRow>(CONTAINER_CONFIG_BY_GROUP_SQL, agentGroupId);
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export async function createContainerConfig(config: ContainerConfigRow): Promise<void> {
  await getDb().run(
    `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, timezone, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @timezone, @updated_at
      )`,
    config,
  );
}

/**
 * Create a config row if one doesn't exist, stamping the provider. Idempotent —
 * no-ops if the row already exists, so an existing group's provider is never
 * overwritten (load-bearing: this is how the global default stays "new groups
 * only" for groups that already have a row).
 *
 * An absent `provider` takes the instance default (`DEFAULT_AGENT_PROVIDER`);
 * `claude` and an absent value that resolves to claude are stored as NULL — the
 * column means "follows the built-in default", matching pre-feature rows.
 */
export async function ensureContainerConfig(agentGroupId: string, provider?: string | null): Promise<void> {
  // Single chokepoint for the instance default: a fresh row with no explicit
  // provider is stamped with DEFAULT_AGENT_PROVIDER, so every new-group creation
  // path inherits it without each having to remember. INSERT OR IGNORE keeps an
  // EXISTING row untouched — so this stays "new groups only" for any group that
  // already has a config row (backfillContainerConfigs seeds one for every group
  // at host startup; a non-claude default would only reach a row-less *legacy*
  // group if a creation script reused it before that first backfill ran). Callers
  // that know the provider (subagent → parent's, spawn → resolved) pass it
  // explicitly and override the default.
  // `claude` (the built-in default) and casing normalize to NULL/lowercase so the
  // column matches what resolution lowercases to.
  const normalized = (provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();
  const stamped = normalized && normalized !== 'claude' ? normalized : null;
  await getDb().run(
    `INSERT OR IGNORE INTO container_configs (agent_group_id, provider, updated_at)
       VALUES (?, ?, ?)`,
    agentGroupId,
    stamped,
    new Date().toISOString(),
  );
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export async function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'timezone'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  await getDb().run(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`, values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export async function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts' | 'security_json',
  value: unknown,
): Promise<void> {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  await getDb().run(
    `UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`,
    JSON.stringify(value),
    now,
    agentGroupId,
  );
}
