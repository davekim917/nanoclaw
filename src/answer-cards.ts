/**
 * Answer cards: pending_approvals rows whose buttons relay an answer to an agent (modules/approvals/choices.ts), not
 * an approve/reject decision; the observatory's privileged-approval queue leaves them out. Card editing does not
 * separate the two: the host edits every card once a click is bound and authorized. Actions register at module
 * import; the dashboard runs in the host process, so it sees them.
 */
const answerCardActions = new Set<string>();

export function registerAnswerCardAction(action: string): void {
  answerCardActions.add(action);
}

export function isAnswerCardAction(action: string): boolean {
  return answerCardActions.has(action);
}
