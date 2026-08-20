import { describe, it, expect } from 'vitest';
import type { ScheduledRow } from '../../lib/api.js';
import { relTime, scheduleRows, scheduleSummary } from './ScheduleLens.js';

const NOW = Date.parse('2026-08-20T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

const row = (over: Partial<ScheduledRow>): ScheduledRow =>
  ({
    key: 'k',
    series_id: 's',
    agent_group_id: 'ag-1',
    agent_group_name: 'Alpha',
    provider: null,
    channel_name: null,
    channel_type: null,
    thread_id: null,
    kind: 'recurring',
    cron: '0 9 * * *',
    next_fire_utc: at(60_000),
    next_fire_local: null,
    health: 'healthy',
    module_owner: null,
    quiet_status: false,
    flag_intent: null,
    script_host: false,
    last_fires: [],
    available_verbs: [],
    ...over,
  }) as ScheduledRow;

describe('scheduleRows', () => {
  it('sorts soonest fire first', () => {
    const rows = scheduleRows(
      [row({ key: 'later', next_fire_utc: at(3_600_000) }), row({ key: 'soon', next_fire_utc: at(60_000) })],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(['soon', 'later']);
  });

  it('KEEPS a series with no next fire, and sorts it last', () => {
    // The legacy card dropped these. A paused series has no next fire and
    // resuming it is exactly the verb this lens exists to offer — hiding the
    // row hides the work.
    const rows = scheduleRows(
      [row({ key: 'paused', next_fire_utc: null }), row({ key: 'due', next_fire_utc: at(60_000) })],
      null,
    );
    expect(rows.map((r) => r.key)).toEqual(['due', 'paused']);
  });

  // The console's axis is the workgroup, so the filter is the SIBLING SET, not
  // one id: a workgroup's jobs are spread across every sibling in it and a
  // single-id filter would have shown one sibling's and hidden the rest.
  it('narrows to the selected workgroup\'s siblings, keeping every one of them', () => {
    const rows = scheduleRows(
      [
        row({ key: 'sibling-a', agent_group_id: 'ag-lab-1' }),
        row({ key: 'sibling-b', agent_group_id: 'ag-lab-2' }),
        row({ key: 'other-wg', agent_group_id: 'ag-dev-1' }),
      ],
      new Set(['ag-lab-1', 'ag-lab-2']),
    );
    expect(rows.map((r) => r.key).sort()).toEqual(['sibling-a', 'sibling-b']);
  });

  it('does not mutate the array it was handed', () => {
    const input = [row({ key: 'b', next_fire_utc: at(2) }), row({ key: 'a', next_fire_utc: at(1) })];
    scheduleRows(input, null);
    expect(input.map((r) => r.key)).toEqual(['b', 'a']);
  });
});

describe('scheduleSummary', () => {
  it('says a past fire is a LATE JOB, not a negative countdown', () => {
    // The scar, verbatim from Observatory.tsx: a fire in the past means the
    // sweep has not run it yet, and "next 4d ago" reads as a typo.
    const s = scheduleSummary([row({ next_fire_utc: at(-4 * 86_400_000) })], NOW);
    expect(s).toContain('next was due');
    expect(s).toContain('ago');
    expect(s).not.toContain('next 4d ago');
  });

  it('counts down to a future fire', () => {
    expect(scheduleSummary([row({ next_fire_utc: at(5 * 60_000) })], NOW)).toBe('1 on this floor · next in 5m');
  });

  it('says nothing scheduled over an empty floor, and "none due" when every row is paused', () => {
    expect(scheduleSummary([], NOW)).toBe('nothing scheduled');
    expect(scheduleSummary([row({ next_fire_utc: null })], NOW)).toBe('1 on this floor · none due');
  });

  it('reads the soonest fire, not whichever row came first', () => {
    const rows = scheduleRows(
      [row({ key: 'paused', next_fire_utc: null }), row({ key: 'due', next_fire_utc: at(5 * 60_000) })],
      null,
    );
    expect(scheduleSummary(rows, NOW)).toBe('2 on this floor · next in 5m');
  });
});

describe('relTime', () => {
  it('signs the direction', () => {
    expect(relTime(at(5 * 60_000), NOW)).toBe('in 5m');
    expect(relTime(at(-5 * 60_000), NOW)).toBe('5m ago');
  });
});
