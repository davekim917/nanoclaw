/** Per-fire model/effort resolver shared by the MCP scheduling actions and the `ncl tasks` CLI. */
import { resolveGroupProvider } from '../../container-config.js';
import { parseMessageFlags, type FlagIntent } from '../../flag-parser.js';

/** Per-fire model/effort a scheduled task carries; mirrors the chat FlagIntent. */
export type TaskFlagIntent = Pick<FlagIntent, 'turnModel' | 'turnEffort'>;

/**
 * Validate a `{model?, effort?}` pin against ONE named provider's vocabulary,
 * returning the intent or the parser's error. The provider is a parameter so
 * the migration audit can ask "valid AFTER the switch" through the same
 * predicate — a second copy of the model table could send a codex id to the
 * Anthropic API. Uses the chat parser's per-turn `-m1`/`-e1` forms.
 */
export function validateTaskPin(
  pin: { model?: string | null; effort?: string | null },
  provider: string,
): { flagIntent?: TaskFlagIntent; error?: string } {
  const model = typeof pin.model === 'string' ? pin.model.trim() : '';
  const effort = typeof pin.effort === 'string' ? pin.effort.trim() : '';
  if (!model && !effort) return {};

  const flagStr = [model ? `-m1 ${model}` : '', effort ? `-e1 ${effort}` : ''].filter(Boolean).join(' ');
  const parsed = parseMessageFlags(flagStr, provider);
  if (parsed.errors.length > 0) return { error: parsed.errors.join('; ') };

  const flagIntent: TaskFlagIntent = {};
  if (parsed.intent?.turnModel) flagIntent.turnModel = parsed.intent.turnModel;
  if (parsed.intent?.turnEffort) flagIntent.turnEffort = parsed.intent.turnEffort;

  // A DROPPED axis is a rejection here, though chat only warns: a pin fires
  // unattended for weeks, and "accepted minus a piece" reads as "accepted" to
  // every later reader. `ultracode` is refused for the same reason: the stored
  // pin carries only `xhigh`, silently dropping the ultracode behavior.
  if (effort && effort.trim().toLowerCase() === 'ultracode') {
    return {
      error:
        'ultracode cannot be a task pin: it is xhigh effort PLUS a session flag, and only the effort would be stored. ' +
        'Pin `--effort xhigh` if that is what you want.',
    };
  }

  const dropped: string[] = [];
  if (model && !flagIntent.turnModel) dropped.push('model');
  if (effort && !flagIntent.turnEffort) dropped.push('effort');
  if (dropped.length > 0) {
    const why = parsed.warnings.length > 0 ? parsed.warnings.join('; ') : 'not applicable to this model';
    return { error: `pin rejected — ${dropped.join(' and ')} dropped by validation: ${why}` };
  }
  return { flagIntent };
}

/**
 * Resolve a `{ model?, effort? }` payload into a per-fire flagIntent validated
 * against the group's provider vocabulary: `{}` when neither is given,
 * `{ flagIntent }` when valid, else `{ error }`. `target.overrideProvider` wins over both the session's sticky
 * provider and the container config — bulk re-pin validates against the
 * provider a group is ABOUT to move to.
 */
export async function resolveTaskFlagIntent(
  content: Record<string, unknown>,
  target: { agent_group_id: string; agent_provider?: string | null; overrideProvider?: string | null },
): Promise<{ flagIntent?: TaskFlagIntent; error?: string }> {
  const model = typeof content.model === 'string' ? content.model.trim() : '';
  const effort = typeof content.effort === 'string' ? content.effort.trim() : '';
  if (!model && !effort) return {};

  // Through the seam: validate against the provider the group ACTUALLY runs.
  const provider =
    target.overrideProvider ?? (await resolveGroupProvider(target.agent_group_id, target.agent_provider));
  return validateTaskPin({ model, effort }, provider);
}
