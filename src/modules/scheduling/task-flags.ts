/**
 * Per-fire model/effort resolver shared by the legacy MCP scheduling actions
 * (actions.ts) and the `ncl tasks` CLI resource (cli/resources/tasks.ts).
 * Split out so the CLI path can validate `--model`/`--effort` against the
 * same provider vocabulary without depending on actions.ts, which is slated
 * for deletion once the MCP scheduling surface retires.
 */
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import { parseMessageFlags, type FlagIntent } from '../../flag-parser.js';

/** Per-fire model/effort a scheduled task carries; mirrors the chat FlagIntent. */
export type TaskFlagIntent = Pick<FlagIntent, 'turnModel' | 'turnEffort'>;

/**
 * Resolve a `{ model?, effort? }` schedule/update payload into a per-fire
 * flagIntent, validated against the agent group's provider vocabulary. Reuses
 * the exact chat flag-parser (`-m1`/`-e1` = per-turn) so a task pin is resolved
 * and rejected identically to an interactive `-m1 sonnet -e1 medium` — no
 * second, drifting validation path. Returns `{ flagIntent }` on success (empty
 * object when neither field was given), or `{ error }` with a human-readable
 * reason the agent sees.
 *
 * `target.agent_provider` is optional: the MCP scheduling path passes the
 * calling session's sticky provider override; the `ncl tasks` CLI path has no
 * such session in hand and resolves purely off the agent group's container
 * config.
 */
export async function resolveTaskFlagIntent(
  content: Record<string, unknown>,
  target: { agent_group_id: string; agent_provider?: string | null },
): Promise<{ flagIntent?: TaskFlagIntent; error?: string }> {
  const model = typeof content.model === 'string' ? content.model.trim() : '';
  const effort = typeof content.effort === 'string' ? content.effort.trim() : '';
  if (!model && !effort) return {};

  const provider = resolveProviderName(
    target.agent_provider ?? null,
    (await getContainerConfig(target.agent_group_id))?.provider,
  );
  const flagStr = [model ? `-m1 ${model}` : '', effort ? `-e1 ${effort}` : ''].filter(Boolean).join(' ');
  const parsed = parseMessageFlags(flagStr, provider);
  if (parsed.errors.length > 0) return { error: parsed.errors.join('; ') };

  const flagIntent: TaskFlagIntent = {};
  if (parsed.intent?.turnModel) flagIntent.turnModel = parsed.intent.turnModel;
  if (parsed.intent?.turnEffort) flagIntent.turnEffort = parsed.intent.turnEffort;
  return { flagIntent };
}
