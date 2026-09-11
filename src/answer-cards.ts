/**
 * Answer cards: pending_approvals rows whose buttons carry an answer the host
 * relays to an agent (modules/approvals/choices.ts), not an approve/reject
 * decision on a privileged action.
 *
 * Two readers treat them differently from approval cards:
 *  - the chat-sdk bridge does not edit the card on click. The host edits it
 *    once the click is authorized and its answer delivered, so a refused or a
 *    losing click leaves the card exactly as it was. The bridge classifies the
 *    card from the action its render read returns (getAskQuestionRender), so
 *    one read decides both;
 *  - the observatory's privileged-approval queue leaves them out.
 *
 * Actions register at module import, like approval handlers. The bridge and
 * the dashboard run in the host process (src/main.ts:79, :796), so both see
 * the registrations.
 */
const answerCardActions = new Set<string>();

export function registerAnswerCardAction(action: string): void {
  answerCardActions.add(action);
}

export function isAnswerCardAction(action: string): boolean {
  return answerCardActions.has(action);
}
