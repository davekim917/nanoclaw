import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { registerSecrets } from '../../secret-scrubber.js';
import {
  FALLBACK_BOUND_MS,
  judgeGateResult,
  observationProblem,
  parseBound,
  parseSince,
  type RawGateResult,
} from './observation.js';

/**
 * The table the container helper (`task_observation.py`) is tested against
 * too, so the host judge and the helper that producers print through cannot
 * drift apart.
 */
const CASES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../container/skills/task-observation/cases.json',
);
const table = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as {
  now: string;
  cases: Array<{ name: string; observation: unknown; valid: boolean; boundMs?: number; sinceMs?: number }>;
};
const NOW_MS = parseSince(table.now)!;

const declared = (observation: unknown): RawGateResult => ({ result: { wakeAgent: false, observation } });

describe('the shared observation case table', () => {
  it('is non-trivial and has both outcomes', () => {
    expect(table.cases.filter((c) => c.valid).length).toBeGreaterThan(5);
    expect(table.cases.filter((c) => !c.valid).length).toBeGreaterThan(10);
  });

  for (const c of table.cases) {
    it(c.name, () => {
      const problem = observationProblem(c.observation, NOW_MS);
      expect(problem === null, String(problem)).toBe(c.valid);
      const judged = judgeGateResult(declared(c.observation), NOW_MS);
      if (!c.valid) {
        expect(judged).toMatchObject({ observation: 'invalid', outcome: 'failed', boundMs: FALLBACK_BOUND_MS });
        return;
      }
      const o = c.observation as { kind: string; since?: string };
      expect(judged.observation).toBe(o.kind);
      expect(judged.outcome).toBe(o.kind === 'empty' ? 'ok' : 'failed');
      expect(judged.boundMs).toBe(c.boundMs);
      expect(judged.since).toBe(c.sinceMs === undefined ? null : new Date(c.sinceMs).toISOString());
    });
  }
});

describe('judgeGateResult', () => {
  it('records a wake as ok with no bound, whatever else the line carries', () => {
    expect(judgeGateResult({ result: { wakeAgent: true, observation: { kind: 'unreadable' } } }, NOW_MS)).toEqual({
      observation: 'wake',
      outcome: 'ok',
      boundMs: null,
      since: null,
      detail: null,
    });
  });

  it('records a missing observation as undeclared: failed, with the fallback bound', () => {
    expect(judgeGateResult({ result: { wakeAgent: false } }, NOW_MS)).toEqual({
      observation: 'undeclared',
      outcome: 'failed',
      boundMs: FALLBACK_BOUND_MS,
      since: null,
      detail: 'no observation declared',
    });
  });

  it('records a script error as failed with the fallback bound and its reason', () => {
    expect(judgeGateResult({ error: 'timed out after 120000ms; output discarded' }, NOW_MS)).toEqual({
      observation: 'error',
      outcome: 'failed',
      boundMs: FALLBACK_BOUND_MS,
      since: null,
      detail: 'timed out after 120000ms; output discarded',
    });
  });

  it('keys the wrapper, not the script line: an `error` key the script printed is not a script error', () => {
    const judged = judgeGateResult(
      {
        result: {
          wakeAgent: false,
          error: 'the script says so',
          observation: { kind: 'empty', evidence: 'x', bound: '1h' },
        } as { wakeAgent: boolean; observation: unknown },
      },
      NOW_MS,
    );
    expect(judged.observation).toBe('empty');
  });

  it('names what is wrong with an invalid observation, and shows it', () => {
    const judged = judgeGateResult(declared({ kind: 'unfinished', evidence: 'x', bound: '4h' }), NOW_MS);
    expect(judged.detail).toBe(
      'invalid observation: unfinished requires since; got {"kind":"unfinished","evidence":"x","bound":"4h"}',
    );
  });

  it('stores JSON evidence as JSON text, scrubbed and capped at 1,000 characters', () => {
    registerSecrets({ TOKEN: 'sk-observation-test-secret' });
    const judged = judgeGateResult(
      declared({
        kind: 'unreadable',
        evidence: { token: 'sk-observation-test-secret', body: 'y'.repeat(2_000) },
        bound: '1h',
      }),
      NOW_MS,
    );
    expect(judged.detail).toHaveLength(1_000);
    expect(judged.detail).toMatch(/^\{"token":"\[REDACTED\]","body":"yyy/);
    expect(judged.detail).not.toContain('sk-observation-test-secret');
  });

  it('normalizes since to UTC', () => {
    const judged = judgeGateResult(
      declared({ kind: 'unfinished', evidence: 'x', bound: '4h', since: '2026-09-26T04:00:00-04:00' }),
      NOW_MS,
    );
    expect(judged.since).toBe('2026-09-26T08:00:00.000Z');
  });

  it('judges future skew against the clock it is given', () => {
    const since = '2026-09-26T12:10:00Z';
    const observation = { kind: 'unfinished', evidence: 'x', bound: '4h', since };
    expect(judgeGateResult(declared(observation), NOW_MS).observation).toBe('invalid');
    expect(judgeGateResult(declared(observation), NOW_MS + 10 * 60_000).observation).toBe('unfinished');
  });
});

describe('bound and since parsing', () => {
  it('clamps rather than rejects an out-of-range bound', () => {
    expect(parseBound('1m')).toBe(15 * 60_000);
    expect(parseBound('9999999999d')).toBe(7 * 24 * 60 * 60_000);
  });

  it('keeps years before 100 in their own century', () => {
    expect(new Date(parseSince('0026-01-01T00:00:00Z')!).toISOString()).toBe('0026-01-01T00:00:00.000Z');
  });
});
