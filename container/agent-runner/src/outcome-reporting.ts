/** Spawn-scoped: changing saved config never silently changes an old runner. */
export function outcomeReportingEnabled(): boolean {
  return process.env.NANOCLAW_OUTCOME_REPORTING === '1';
}

export const OUTCOME_REPLY_NUDGE =
  '<system>Your reply has not been delivered. Final text and message blocks are internal in this workgroup. ' +
  'Use send_message with purpose="reply" to answer the person, or purpose="outcome" with the original harness request ' +
  'id only if that work item is finished. Required approval tools remain available. ' +
  'If this is only an acknowledgment and no reply is warranted, return <internal>no reply</internal>. ' +
  'Do not send progress or promise a later report.</system>';
