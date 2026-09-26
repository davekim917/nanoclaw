/**
 * The one judge for a scripted fire that ran its pre-task script: host-gated
 * fires and container fires both reach `judgeGateResult`, so the two paths
 * cannot disagree about what a result means.
 *
 * A producer's last stdout line carries
 * `{"wakeAgent":false,"observation":{kind,evidence,bound,since?},"data":{...}}`.
 * `container/skills/task-observation/task_observation.py` writes that line and applies
 * the same rules; both implementations are tested against one case table
 * (`container/skills/task-observation/cases.json`), because no module is
 * importable from both the host build and a container.
 */
import { upsertGateOutcome } from '../../db/task-run-outcomes.js';
import { scrubSecrets } from '../../secret-scrubber.js';

const OBSERVATION_KINDS = ['empty', 'unreadable', 'blocked', 'unfinished'] as const;
type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** What the gate lane records for one execution. */
export type GateObservation = ObservationKind | 'wake' | 'error' | 'invalid' | 'undeclared';

const MINUTE_MS = 60_000;
const MIN_BOUND_MS = 15 * MINUTE_MS;
const MAX_BOUND_MS = 7 * 24 * 60 * MINUTE_MS;
/** The bound for a result that declared none it can be held to: error, invalid, undeclared. */
export const FALLBACK_BOUND_MS = 2 * 60 * MINUTE_MS;
const SINCE_MAX_FUTURE_MS = 5 * MINUTE_MS;
const DETAIL_MAX_CHARS = 1000;

const BOUND_PATTERN = /^([1-9][0-9]*)([mhd])$/;
const BOUND_UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS };
const SINCE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * A script execution before judgement: its parsed last stdout line, or why it
 * produced none. Wrapped, because the line itself may carry any key.
 */
export type RawGateResult = { result: { wakeAgent: boolean; observation?: unknown } } | { error: string };

export interface GateJudgement {
  observation: GateObservation;
  outcome: 'ok' | 'failed';
  boundMs: number | null;
  /** ISO-8601 UTC, normalized. */
  since: string | null;
  detail: string | null;
}

/** `'90m' | '4h' | '2d'` → milliseconds clamped to [15m, 7d]; null when malformed. */
export function parseBound(bound: unknown): number | null {
  if (typeof bound !== 'string') return null;
  const match = BOUND_PATTERN.exec(bound);
  if (!match) return null;
  const ms = Number(match[1]) * BOUND_UNIT_MS[match[2]!]!;
  return Math.min(MAX_BOUND_MS, Math.max(MIN_BOUND_MS, ms));
}

/** `Date.UTC` maps years 0-99 onto 1900-1999, so the year is set separately. */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millis = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcMs(year, month + 1, 0)).getUTCDate();
}

/**
 * ISO-8601 with an explicit zone → epoch ms, or null.
 *
 * Validated field by field: `Date.parse` accepts `2026-02-30` and `24:00`,
 * which Python's `datetime` refuses, and the helper must agree with this.
 */
export function parseSince(since: unknown): number | null {
  if (typeof since !== 'string') return null;
  const m = SINCE_PATTERN.exec(since);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMs = 0;
  if (m[8] === undefined) {
    const offHours = Number(m[10]);
    const offMinutes = Number(m[11]);
    if (offHours > 23 || offMinutes > 59) return null;
    offsetMs = (m[9] === '-' ? -1 : 1) * (offHours * 60 + offMinutes) * MINUTE_MS;
  }
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0').slice(0, 3));
  return utcMs(year, month, day, hour, minute, second, millis) - offsetMs;
}

function hasEvidence(evidence: unknown): boolean {
  if (typeof evidence === 'string') return evidence.trim() !== '';
  if (Array.isArray(evidence)) return evidence.length > 0;
  if (evidence !== null && typeof evidence === 'object') return Object.keys(evidence).length > 0;
  return false;
}

function capDetail(text: string): string {
  return scrubSecrets(text).slice(0, DETAIL_MAX_CHARS);
}

function renderEvidence(evidence: unknown): string {
  return typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
}

/** Why an observation is not a valid declaration, or null when it is one. */
export function observationProblem(observation: unknown, nowMs: number = Date.now()): string | null {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
    return 'observation is not an object';
  }
  const o = observation as Record<string, unknown>;
  if (!(OBSERVATION_KINDS as readonly unknown[]).includes(o.kind)) {
    return `kind must be one of ${OBSERVATION_KINDS.join(', ')}`;
  }
  if (!hasEvidence(o.evidence)) return 'evidence must be a non-empty string, object or array';
  if (parseBound(o.bound) === null) return 'bound must look like 90m, 4h or 2d';
  if (o.since !== undefined) {
    const sinceMs = parseSince(o.since);
    if (sinceMs === null) return 'since must be an ISO-8601 timestamp with a zone';
    if (sinceMs > nowMs + SINCE_MAX_FUTURE_MS) return 'since is more than 5 minutes in the future';
  } else if (o.kind === 'unfinished') {
    return 'unfinished requires since';
  }
  return null;
}

/** Map one execution's result onto the gate lane. */
export function judgeGateResult(raw: RawGateResult, nowMs: number = Date.now()): GateJudgement {
  if ('error' in raw) {
    return {
      observation: 'error',
      outcome: 'failed',
      boundMs: FALLBACK_BOUND_MS,
      since: null,
      detail: capDetail(raw.error || 'script failed'),
    };
  }
  const { result } = raw;
  if (result.wakeAgent) return { observation: 'wake', outcome: 'ok', boundMs: null, since: null, detail: null };
  if (!Object.prototype.hasOwnProperty.call(result, 'observation')) {
    return {
      observation: 'undeclared',
      outcome: 'failed',
      boundMs: FALLBACK_BOUND_MS,
      since: null,
      detail: 'no observation declared',
    };
  }
  const problem = observationProblem(result.observation, nowMs);
  if (problem !== null) {
    return {
      observation: 'invalid',
      outcome: 'failed',
      boundMs: FALLBACK_BOUND_MS,
      since: null,
      detail: capDetail(`invalid observation: ${problem}; got ${JSON.stringify(result.observation)}`),
    };
  }
  const o = result.observation as { kind: ObservationKind; evidence: unknown; bound: string; since?: string };
  const sinceMs = o.since === undefined ? null : parseSince(o.since);
  return {
    observation: o.kind,
    outcome: o.kind === 'empty' ? 'ok' : 'failed',
    boundMs: parseBound(o.bound),
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    detail: capDetail(renderEvidence(o.evidence)),
  };
}

export interface GateRecordInput {
  agentGroupId: string;
  sessionId: string;
  seriesId: string;
  occurrenceId: string;
  raw: RawGateResult;
}

/** Judge and upsert one execution's result. Throws when the row could not be written. */
export async function recordGateResult(input: GateRecordInput): Promise<GateJudgement> {
  const judged = judgeGateResult(input.raw);
  await upsertGateOutcome({
    agentGroupId: input.agentGroupId,
    sessionId: input.sessionId,
    seriesId: input.seriesId,
    occurrenceId: input.occurrenceId,
    ...judged,
  });
  return judged;
}
