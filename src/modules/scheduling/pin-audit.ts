/**
 * Provider-migration pin audit.
 *
 * A scheduled task's `--model`/`--effort` pin is validated ONCE, at create or
 * update time, against the agent group's provider as it stood then. Nothing
 * re-validates it at fire time. So a `ncl groups config update --provider`
 * silently strands every pin the new provider's vocabulary rejects, and the
 * only symptom is a per-fire provider error — which on 2026-09-07 meant a
 * recurring series failed 21 consecutive times over 14 hours with a
 * `gpt-6-astra` pin handed to the Claude SDK.
 *
 * This module answers one question for the migration path: which of a group's
 * ARMED (pending/paused) task pins would the target provider reject? It does
 * NOT rewrite them. A pin that changes by itself is not a pin, and an operator
 * who pinned `gpt-6-astra` to a codex group has said something specific that a
 * provider switch has no standing to reinterpret.
 *
 * WHY REFUSE AND NOT WARN. `config update` already runs behind an approval
 * gate, so a refusal is a thing a human reads and acts on; a warning printed
 * into a scrollback is precisely the shape that produced the 14-hour outage.
 * A refusal costs one command to clear. The migration it prevents costs every
 * fire until someone notices.
 *
 * Refusing is only safe BECAUSE there is a remedy that works before the
 * switch. `ncl tasks repin --target-provider <new>` validates against the
 * provider the group is moving TO — without it, re-pinning ahead of a
 * migration is rejected by the very check meant to protect it
 * (`resolveTaskFlagIntent` answers for the provider the group still has), and
 * refusal would wedge the operator into being unable to migrate at all. There
 * is deliberately NO `--force` flag: repin can always produce a valid pin, and
 * a series whose pin is genuinely unwanted can be cancelled. An unbypassable
 * gate with a working remedy beats a bypass nobody has a reason to reach for.
 *
 * KNOWN GAP, accepted deliberately: this checks the target provider's
 * VOCABULARY, not whether a model is still servable. `claude-opus-4-7` passes
 * — `VALID_MODEL_RE` in `flag-parser.ts` is a SHAPE check, so any well-formed
 * `claude-opus-<n>-<n>` id validates whether or not it was ever real. A
 * retired-model pin therefore fails at fire time exactly the way a
 * wrong-provider pin does. That is not fixed here on purpose: a membership set
 * would be a second copy of a vocabulary that already exists in one place, and
 * the last tightening of that regex rejected the fork's OWN
 * `DEFAULT_HAIKU_MODEL`, which made `-m haiku` fall through to the Opus default
 * at the spawn seam — the same class of bug, caused by the fix for it. No
 * armed pin in the fleet is currently exposed (all 16 validate), the retired
 * ids appear only in historical rows, and scheduled-task failure escalation
 * covers the case. `ncl tasks repin` is the remediation when a model does
 * retire.
 */
import { findTaskSessions } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { parseTaskPin } from './task-content.js';
import { validateTaskPin } from './task-flags.js';

/** One armed task series whose stored pin the target provider rejects. */
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
 * reject.
 *
 * Scope note: this reads the group's task-system sessions — the same set
 * `ncl tasks list --group` and `ncl tasks repin --group` operate on — so
 * whatever the audit reports, the remedy can reach. Unpinned series are
 * invisible to it by construction: they have nothing to strand.
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
 * The refusal an operator reads. Names every stranded series, its literal pin,
 * the vocabulary's own reason, and the exact command that clears it.
 *
 * Self-contained on purpose: the stored pin is printed verbatim, so the
 * `--from-model` / `--from-effort` the remedy needs can be read straight off
 * this message without a second lookup.
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
  return (
    `Refusing to switch ${agentGroupId} from provider "${fromProvider}" to "${toProvider}": ` +
    `${stranded.length} armed task pin${stranded.length === 1 ? '' : 's'} would be invalid under "${toProvider}", ` +
    `and every fire would fail.\n\n` +
    `${lines.join('\n')}\n\n` +
    `Pins are never rewritten for you — a pin that changes by itself is not a pin.\n` +
    `Re-pin them first (--target-provider validates against the NEW provider, so this works\n` +
    `BEFORE the switch), then re-run this command:\n` +
    `  ncl tasks repin --group ${agentGroupId} --target-provider ${toProvider} \\\n` +
    `    --from-model <old> --to-model <new> --dry-run\n` +
    `A series whose pin is no longer wanted can be cancelled instead: ncl tasks cancel --id <series>`
  );
}
