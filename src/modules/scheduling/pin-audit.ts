/**
 * Provider-migration pin audit: which of a group's ARMED task pins would the
 * target provider reject? Pins are validated only at create/update, so a
 * provider switch can strand them into a failure on every fire.
 *
 * It does NOT rewrite pins (a pin is the operator's literal choice), and the
 * switch REFUSES rather than warns. Refusing is safe only because
 * `ncl tasks repin --target-provider <new>` can fix pins before the switch;
 * there is deliberately no `--force`.
 *
 * Known gap, accepted: this checks the target's VOCABULARY, not whether a model
 * is still servable (the model regex is a shape check). A retired-model pin
 * fails at fire time, which failure escalation covers; a second copy of the
 * vocabulary would be worse.
 */
import { findTaskSessions } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { parseTaskPin } from './task-content.js';
import { validateTaskPin } from './task-flags.js';

export interface StrandedPin {
  sessionId: string;
  seriesId: string;
  status: string;
  /** The pin EXACTLY as stored — never alias-resolved. */
  model: string | null;
  effort: string | null;
  /** The provider vocabulary's own rejection text, verbatim. */
  reason: string;
}

/**
 * Every armed task series in `agentGroupId` whose pin `targetProvider` would
 * reject, read from the same task sessions `ncl tasks repin --group` reaches.
 */
export async function auditTaskPins(agentGroupId: string, targetProvider: string): Promise<StrandedPin[]> {
  const stranded: StrandedPin[] = [];
  for (const session of await findTaskSessions(agentGroupId)) {
    const rows =
      (await withExistingMailboxSession(agentGroupId, session.id, (mailbox) =>
        mailbox.listCliTaskSeries().map((row) => ({
          seriesId: row.series_id ?? row.row_id,
          status: row.status,
          pin: parseTaskPin(row.content),
        })),
      )) ?? [];
    for (const row of rows) {
      if (!row.pin.model && !row.pin.effort) continue;
      const { error } = validateTaskPin(row.pin, targetProvider);
      if (!error) continue;
      stranded.push({
        sessionId: session.id,
        seriesId: row.seriesId,
        status: row.status,
        model: row.pin.model,
        effort: row.pin.effort,
        reason: error,
      });
    }
  }
  return stranded;
}

/**
 * The remedy lines an operator can run. The axis must match the strand (a
 * `--from-model` repin cannot clear an invalid effort pin), and the applying
 * command is shown beside the `--dry-run` preview, which writes nothing.
 */
function remedyCommands(
  stranded: StrandedPin[],
  agentGroupId: string,
  toProvider: string,
  // Only needed BEFORE the switch; after it, the flag would contradict the text.
  includeTargetProvider: boolean,
): string {
  const base =
    `ncl tasks repin --group ${agentGroupId}` + (includeTargetProvider ? ` --target-provider ${toProvider}` : '');
  const byAxis = new Map<string, string>();
  for (const p of stranded) {
    // `reason` names the axis the vocabulary rejected; a pin can strand on both.
    const modelBad = p.model != null && /model/i.test(p.reason);
    const effortBad = p.effort != null && /effort/i.test(p.reason);
    // Neither matched: suggest whichever axis is set, preferring model.
    const axes: Array<'model' | 'effort'> =
      modelBad || effortBad
        ? [...(modelBad ? (['model'] as const) : []), ...(effortBad ? (['effort'] as const) : [])]
        : p.model != null
          ? ['model']
          : p.effort != null
            ? ['effort']
            : [];
    for (const axis of axes) {
      const value = axis === 'model' ? p.model : p.effort;
      if (value == null) continue;
      byAxis.set(`${axis}:${value}`, `  ${base} \\\n    --from-${axis} ${value} --to-${axis} <new-${axis}>`);
    }
  }
  if (byAxis.size === 0) return `  ${base} --from-model <old> --to-model <new>`;
  return [...byAxis.values()].join('\n');
}

/**
 * The refusal an operator reads. Names every stranded series, its literal pin,
 * the vocabulary's own reason, and the exact command that clears it.
 */
export function formatStrandedPins(
  stranded: StrandedPin[],
  agentGroupId: string,
  fromProvider: string,
  toProvider: string,
): string {
  const lines = stranded.map(
    (p) => `  ${p.seriesId} [${p.status}]  model=${p.model ?? '-'}  effort=${p.effort ?? '-'}\n` + `      ${p.reason}`,
  );
  const remedy = remedyCommands(stranded, agentGroupId, toProvider, true);
  return (
    `Refusing to switch ${agentGroupId} from provider "${fromProvider}" to "${toProvider}": ` +
    `${stranded.length} armed task pin${stranded.length === 1 ? '' : 's'} would be invalid under "${toProvider}", ` +
    `and every fire would fail.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Pins are never rewritten for you — a pin that changes by itself is not a pin.\n` +
    `Re-pin them first (--target-provider validates against the NEW provider, so this works\n` +
    `BEFORE the switch), then re-run this command.\n\n` +
    `Preview (writes nothing) — append --dry-run to any of these:\n` +
    `${remedy}\n\n` +
    `Run the same command WITHOUT --dry-run to apply, then re-run the provider switch.\n` +
    `A series whose pin is no longer wanted can be cancelled instead: ncl tasks cancel --id <series>`
  );
}

/**
 * The post-write warning for a pin created between the audit and the provider
 * write. The switch has ALREADY LANDED, so the refusal text above would mislead.
 */
export function formatLateStrandedPins(
  stranded: StrandedPin[],
  agentGroupId: string,
  fromProvider: string,
  toProvider: string,
): string {
  const lines = stranded.map(
    (p) => `  ${p.seriesId} [${p.status}]  model=${p.model ?? '-'}  effort=${p.effort ?? '-'}\n` + `      ${p.reason}`,
  );
  const remedy = remedyCommands(stranded, agentGroupId, toProvider, false);
  return (
    `The provider switch for ${agentGroupId} ("${fromProvider}" -> "${toProvider}") HAS BEEN APPLIED, ` +
    `but ${stranded.length} task pin${stranded.length === 1 ? ' was' : 's were'} written between the ` +
    `pre-flight audit and the write, and ${stranded.length === 1 ? 'it is' : 'they are'} now stranded ` +
    `under "${toProvider}". Every fire of ${stranded.length === 1 ? 'this series' : 'these series'} will fail ` +
    `until the pin is changed. Do NOT re-run the switch — it already succeeded.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Fix forward (the group is already on "${toProvider}", so --target-provider is not needed):\n` +
    `${remedy}\n\n` +
    `Run with --dry-run first to preview. A series whose pin is no longer wanted can be ` +
    `cancelled instead: ncl tasks cancel --id <series>`
  );
}
