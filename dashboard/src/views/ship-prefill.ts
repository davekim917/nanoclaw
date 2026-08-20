/**
 * Prefill chips — one-tap text for a composer, shared by the legacy Observatory
 * and the thread console.
 *
 * **Ship is not a verb.** It is a prefilled message with a preset recipient. The
 * release watcher writes `nextAction` on the item, an AGENT authored those
 * words, and the button surfaces them verbatim — the operator is approving
 * something already written, not composing it. That is why it drops cleanly into
 * the console's one-action model rather than needing a mechanism of its own:
 * same send, box pre-filled, selector preset.
 *
 * Two properties are load-bearing and neither is obvious from the call site:
 *
 * 1. **A chip SETS the box and nothing else.** No chip sends, ship included. The
 *    send is still the operator reading what is about to go out.
 * 2. **The addressee is derived, with a fallback.** A handle matching nobody
 *    resolves to null and the operator picks from the select as before.
 *
 * This module exists because both views need the same regexes. Two copies drift,
 * and "improve the pattern on one side only" is exactly how the ship button
 * would start extracting different words in the two places it is rendered.
 */

/**
 * The relayable instruction inside an ask, if there is one.
 *
 * Real asks read "<person> record @<bot> ship 869; <someone> or a human
 * presses the merge -- self-authored -- stalled 28h". The decision is a
 * sentence of context, but the ACTION is the four words in the middle, and
 * those are the words that have to reach the agent. Everything else is prose
 * for the human and would be noise in the agent's thread — so the box gets the
 * instruction alone, and prose-only asks get an empty box rather than a
 * paraphrase this function invented.
 */
export function shipInstruction(nextAction?: string): string | null {
  return nextAction?.match(/@[\w-]+\s+ship\s+[\w-]+(?:\s+\d+)?/i)?.[0] ?? null;
}

/**
 * The agent an instruction is ADDRESSED to — "@nova ship 912" names nova.
 *
 * Only ever a lookup: a handle matching no agent on this floor resolves to
 * null and the operator picks from the select as before. The ship button needs
 * this or its one tap lands on a confirm whose send is disabled, which is not
 * a confirm, it is a dead end.
 */
export function shipAddressee(instruction: string | null, agents: { id: string; name: string }[]): string | null {
  const handle = instruction?.match(/^@([\w-]+)/)?.[1]?.toLowerCase();
  return (handle && agents.find((a) => a.name.trim().toLowerCase() === handle)?.id) || null;
}

/** One prefill chip: a label to tap and the text it drops in the box. */
export interface PrefillChip {
  label: string;
  text: string;
  /** Agent id to preset the selector to — ship chips only, null when nothing resolved. */
  addressee?: string | null;
}

/**
 * The one-tap answers. Chips SET the box and nothing else — the send is still
 * the operator reading what is about to go out. "no" is left mid-sentence on
 * purpose: a refusal with no reason is the one answer that always costs
 * another round trip.
 */
export const DECISION_CHIPS: PrefillChip[] = [
  { label: 'approve as proposed', text: 'approve as proposed' },
  { label: 'hold — need more info', text: 'hold — need more info' },
  { label: 'no — …', text: 'no — ' },
];

/**
 * Every chip a composer should offer, given the row's `nextAction` (when the row
 * is a release item that has one) and the agents the selector can reach.
 *
 * The ship chip comes FIRST and only when the instruction exists — a row with no
 * relayable instruction gets the three decision chips and no invented fourth.
 */
export function prefillChips(
  nextAction: string | undefined,
  agents: { id: string; name: string }[],
): PrefillChip[] {
  const instruction = shipInstruction(nextAction);
  if (!instruction) return DECISION_CHIPS;
  return [{ label: instruction, text: instruction, addressee: shipAddressee(instruction, agents) }, ...DECISION_CHIPS];
}
