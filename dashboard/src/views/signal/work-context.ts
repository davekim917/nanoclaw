import type { SignalAgent, SignalDecision } from '../../../../src/dashboard/observatory-v2/types.js';
export const decisionGroup = (decision: SignalDecision) =>
  decision.state === 'answered'
    ? 'Reviewed'
    : decision.blocks_release
      ? 'Blocking release'
      : decision.state === 'changed'
        ? 'Evidence changed'
        : 'Awaiting decision';
export function agentDecisions(agent: SignalAgent, decisions: SignalDecision[]) {
  return decisions.filter(
    (d) => d.agent_group_id === agent.id || (d.thread_id !== null && agent.thread_ids.includes(d.thread_id)),
  );
}
export function sourceAge(value: string | null, now = Date.now()) {
  if (!value) return 'Age unknown';
  const ms = now - Date.parse(value);
  if (!Number.isFinite(ms)) return 'Age unknown';
  const days = Math.floor(ms / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(ms / 3600000);
  return hours > 0 ? `${hours}h ago` : 'Within the hour';
}
