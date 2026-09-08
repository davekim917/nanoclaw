/**
 * Per-fire model/effort resolver shared by the legacy MCP scheduling actions
 * (actions.ts) and the `ncl tasks` CLI resource (cli/resources/tasks.ts).
 * Split out so the CLI path can validate `--model`/`--effort` against the
 * same provider vocabulary without depending on actions.ts, which is slated
 * for deletion once the MCP scheduling surface retires.
 */
import { resolveGroupProvider } from '../../container-config.js';
import { parseMessageFlags, type FlagIntent } from '../../flag-parser.js';

/** Per-fire model/effort a scheduled task carries; mirrors the chat FlagIntent. */
export type TaskFlagIntent = Pick<FlagIntent, 'turnModel' | 'turnEffort'>;

/**
 * Validate a `{model?, effort?}` pin against ONE named provider's flag
 * vocabulary, returning the resolved per-fire intent or the parser's own
 * error text.
 *
 * The provider is a parameter, not a lookup, because the two callers ask
 * different questions of the same predicate: `resolveTaskFlagIntent` asks
 * "is this pin valid for the group as it is configured NOW", while the
 * provider-migration audit (`pin-audit.ts`) asks "would this already-stored
 * pin still be valid AFTER the provider changes". Both must reach the same
 * verdict from the same table — a second, drifting copy of "what counts as a
 * valid claude model" is exactly how a codex model id survived a `--provider`
 * switch and reached the Anthropic API for 14 hours (2026-09-07).
 *
 * Reuses the chat flag parser with `-m1`/`-e1` (per-turn) so a task pin is
 * resolved and rejected identically to an interactive `-m1 sonnet -e1 medium`.
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

  // A DROPPED axis is a rejection here, even though the chat parser treats it
  // as a warning. `-m1 haiku -e1 xhigh` returns no error and simply omits
  // `turnEffort`, because in chat the human sees "skipped effort" on screen and
  // the turn runs anyway. A PIN has no such reader: it is written once and
  // fires unattended for weeks, so "accepted, minus a piece you asked for" is
  // indistinguishable from "accepted" at every later read — by `repin`, by the
  // provider-migration audit, and by the operator looking at `tasks list`.
  //
  // Returning the subset silently would also re-open the exact defect this
  // module exists to close: a caller that persists what it asked for rather
  // than what came back stores a value validation refused.
  // `ultracode` is not a storable effort. The parser represents it as
  // `turnEffort: 'xhigh'` PLUS a separate `turnUltracode` boolean, and the
  // stored pin shape carries only the effort — so accepting it would report
  // success and persist plain `xhigh`, silently dropping the dynamic-workflow
  // behavior the operator asked for. That is this module's own defect class,
  // so it is refused rather than quietly downgraded.
  //
  // Deliberately NOT solved by carrying the flag through storage: that means
  // threading a second field through the content envelope, the CLI's pin
  // display, the provider-migration audit and repin's matching, and
  // `ultracode` is claude-only, so it would also need a rule at every provider
  // boundary. If a task ever needs it, that is the change to make — not a
  // silent `xhigh` today.
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
 * Resolve a `{ model?, effort? }` schedule/update payload into a per-fire
 * flagIntent, validated against the agent group's provider vocabulary.
 * Returns `{ flagIntent }` on success (empty object when neither field was
 * given), or `{ error }` with a human-readable reason the agent sees.
 *
 * `target.agent_provider` is optional: the MCP scheduling path passes the
 * calling session's sticky provider override; the `ncl tasks` CLI path has no
 * such session in hand and resolves purely off the agent group's container
 * config. `target.overrideProvider` short-circuits both — the bulk re-pin
 * command uses it to validate against the provider a group is ABOUT to move
 * to, which is the only way to fix pins ahead of a migration (validating
 * against the current provider would reject every correct new value).
 */
export async function resolveTaskFlagIntent(
  content: Record<string, unknown>,
  target: { agent_group_id: string; agent_provider?: string | null; overrideProvider?: string | null },
): Promise<{ flagIntent?: TaskFlagIntent; error?: string }> {
  const model = typeof content.model === 'string' ? content.model.trim() : '';
  const effort = typeof content.effort === 'string' ? content.effort.trim() : '';
  if (!model && !effort) return {};

  // Through the seam, so create/update validate a pin against the provider the
  // group ACTUALLY runs. This was the third site reading the lagging
  // projection: two were found as separate review findings at separate call
  // sites, which is the whole argument for there being one resolver.
  const provider =
    target.overrideProvider ?? (await resolveGroupProvider(target.agent_group_id, target.agent_provider));
  return validateTaskPin({ model, effort }, provider);
}
