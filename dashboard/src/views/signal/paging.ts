import type { SignalOverview } from '../../../../src/dashboard/observatory-v2/types.js';
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const mergeIds = <T extends { id: string }>(a: T[], b: T[]) => [
  ...new Map([...a, ...b].map((item) => [item.id, item])).values(),
];
const mergeSources = (base: SignalOverview['sources'], page: SignalOverview['sources']) =>
  [
    ...new Map(
      [...base, ...page].map((source) => [JSON.stringify([source.workgroup_id, source.source]), source]),
    ).values(),
  ];
export function mergeSignalPages(base: SignalOverview, page: SignalOverview): SignalOverview {
  const projects = new Map(base.projects.map((p) => [p.id, p]));
  for (const p of page.projects) {
    const prior = projects.get(p.id);
    projects.set(
      p.id,
      prior
        ? {
            ...p,
            thread_ids: union(prior.thread_ids, p.thread_ids),
            decision_ids: union(prior.decision_ids, p.decision_ids),
            items: mergeIds(prior.items, p.items),
          }
        : p,
    );
  }
  const agents = new Map(base.agents.map((a) => [a.id, a]));
  for (const a of page.agents) {
    const prior = agents.get(a.id);
    agents.set(a.id, prior ? { ...a, thread_ids: union(prior.thread_ids, a.thread_ids) } : a);
  }
  return {
    ...base,
    projects: [...projects.values()],
    agents: [...agents.values()],
    decisions: mergeIds(base.decisions, page.decisions),
    activity: mergeIds(base.activity, page.activity),
    sources: mergeSources(base.sources, page.sources),
    thread_coverage: [
      ...new Map(
        [...(base.thread_coverage ?? []), ...(page.thread_coverage ?? [])].map((c) => [c.workgroup_id, c]),
      ).values(),
    ],
  };
}
