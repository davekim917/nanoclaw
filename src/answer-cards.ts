/**
 * Answer cards: pending_approvals rows whose buttons carry an answer the host
 * relays to an agent (modules/approvals/choices.ts), not an approve/reject
 * decision on a privileged action.
 *
 * One reader treats them differently from approval cards: the observatory's
 * privileged-approval queue leaves them out.
 *
 * Card editing is no longer what separates the two. The chat-sdk bridge edits
 * NO pending_approvals card on click (chat-sdk-bridge.ts) — a
 * click reaches it before anyone has checked which card it was made on or
 * whether the clicker may decide it — so every approval card, answer cards
 * included, is edited by the host once a click is bound and authorized
 * (editApprovalCardResolution, modules/approvals/primitive.ts; a choice card's
 * own edit waits for its answer to be delivered, modules/approvals/choices.ts).
 *
 * Actions register at module import, like approval handlers. The dashboard
 * runs in the host process (src/main.ts), so it sees the registrations.
 */
const answerCardActions = new Set<string>();

export function registerAnswerCardAction(action: string): void {
  answerCardActions.add(action);
}

export function isAnswerCardAction(action: string): boolean {
  return answerCardActions.has(action);
}
