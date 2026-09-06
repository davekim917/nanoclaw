import type { SignalDecision } from '../../../../src/dashboard/observatory-v2/types.js';

type DecisionStamp = Pick<SignalDecision, 'id' | 'evidence_hash' | 'version' | 'state' | 'dispatch_state'>;
export interface VisitBaseline {
  seenAt: string;
  decisions: DecisionStamp[];
}
export type VisitChange = 'new' | 'changed' | null;
interface VisitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const keyFor = (user: string, workspace: string) =>
  `observatory:visit:1:${encodeURIComponent(user)}:${encodeURIComponent(workspace)}`;

/** Baseline metadata stays local to one signed-in identity and workspace. No source text is stored. */
export function readVisitBaseline(storage: VisitStorage, user: string, workspace: string): VisitBaseline | null {
  try {
    const raw = storage.getItem(keyFor(user, workspace));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('seenAt' in value) ||
      typeof value.seenAt !== 'string' ||
      !Number.isFinite(Date.parse(value.seenAt)) ||
      !('decisions' in value) ||
      !Array.isArray(value.decisions)
    )
      return null;
    const decisions: DecisionStamp[] = value.decisions
      .filter((item: unknown): item is DecisionStamp => {
        if (!item || typeof item !== 'object') return false;
        const row = item as Record<string, unknown>;
        return (
          typeof row.id === 'string' &&
          typeof row.evidence_hash === 'string' &&
          typeof row.version === 'number' &&
          ['open', 'answered', 'changed'].includes(String(row.state)) &&
          ['not_requested', 'pending', 'sent', 'failed'].includes(String(row.dispatch_state))
        );
      })
      .slice(-2000);
    return { seenAt: value.seenAt, decisions };
  } catch {
    return null;
  }
}

/** Source refresh timestamps alone are not a change, and disappearance never implies completion. */
export function decisionVisitChange(decision: DecisionStamp, baseline: VisitBaseline | null): VisitChange {
  if (!baseline) return null;
  const before = baseline.decisions.find((item) => item.id === decision.id);
  if (!before) return 'new';
  return before.evidence_hash !== decision.evidence_hash ||
    before.version !== decision.version ||
    before.state !== decision.state ||
    before.dispatch_state !== decision.dispatch_state
    ? 'changed'
    : null;
}

/** Call after a successful load, retaining the original read baseline for this visit's display. */
export function saveVisitBaseline(
  storage: VisitStorage,
  user: string,
  workspace: string,
  decisions: DecisionStamp[],
  now = new Date().toISOString(),
): void {
  try {
    const previous = readVisitBaseline(storage, user, workspace);
    const merged = new Map(previous?.decisions.map((item) => [item.id, item]) ?? []);
    for (const { id, evidence_hash, version, state, dispatch_state } of decisions) {
      merged.delete(id);
      merged.set(id, { id, evidence_hash, version, state, dispatch_state });
    }
    storage.setItem(
      keyFor(user, workspace),
      JSON.stringify({ seenAt: now, decisions: [...merged.values()].slice(-2000) }),
    );
  } catch {
    /* A denied browser storage permission must not prevent reviewing work. */
  }
}
