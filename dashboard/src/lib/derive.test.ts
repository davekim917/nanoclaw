import { describe, it, expect } from 'vitest';
import {
  extractGoal,
  extractLinearId,
  extractPhase,
  heatOf,
  countTasks,
  streamGroups,
  buildPhaseTimeline,
} from './derive.js';
import type { TaskSummary, TaskDetail, TranscriptEntry } from './api.js';

describe('extractGoal', () => {
  it('pulls the line under "## Goal"', () => {
    const md = '## Goal\nResolve **XZO-54** — redeploy UDTF.\nLinear: https://x\n\n## Inputs\n- Repo: foo';
    expect(extractGoal(md)).toBe('redeploy UDTF.');
  });

  it('falls back to the first non-heading line', () => {
    expect(extractGoal('Just do this thing.\nMore detail')).toBe('Just do this thing.');
  });

  it('truncates to maxLen with ellipsis', () => {
    const long = '## Goal\n' + 'x'.repeat(200);
    expect(extractGoal(long, 50)).toMatch(/^x{49}…$/);
  });
});

describe('extractLinearId', () => {
  it('matches XZO-54', () => {
    expect(extractLinearId('## Goal\nResolve **XZO-54** — do it.')).toBe('XZO-54');
  });
  it('matches lowercase-prefixed (no)', () => {
    expect(extractLinearId('## Goal\nfoo-12 bar')).toBeNull();
  });
  it('returns null when no ticket', () => {
    expect(extractLinearId('## Goal\njust some prose')).toBeNull();
  });
});

describe('extractPhase', () => {
  it('parses "Phase 2 implement complete: …"', () => {
    expect(extractPhase('Phase 2 implement complete: 3 files changed')).toBe(2);
  });
  it('case-insensitive', () => {
    expect(extractPhase('phase 3 verify')).toBe(3);
  });
  it('returns null for unparseable', () => {
    expect(extractPhase('working on it…')).toBeNull();
    expect(extractPhase(undefined)).toBeNull();
  });
});

describe('heatOf', () => {
  const NOW = Date.parse('2026-05-12T12:00:00Z');
  it('fresh running is hot', () => {
    expect(
      heatOf(
        {
          status: 'running',
          admitted_at: '2026-05-12T11:55:00Z',
        },
        NOW
      )
    ).toBe('hot');
  });
  it('recent failure is hot', () => {
    expect(
      heatOf(
        {
          status: 'failed',
          admitted_at: '2026-05-12T10:00:00Z',
        },
        NOW
      )
    ).toBe('hot');
  });
  it('cancelled is cold', () => {
    expect(
      heatOf(
        {
          status: 'cancelled',
          admitted_at: '2026-05-12T11:55:00Z',
        },
        NOW
      )
    ).toBe('cold');
  });
  it('completed > 12h ago is cold', () => {
    expect(
      heatOf(
        {
          status: 'completed',
          admitted_at: '2026-05-11T20:00:00Z',
        },
        NOW
      )
    ).toBe('cold');
  });
});

describe('countTasks', () => {
  it('counts every status group', () => {
    const tasks: TaskSummary[] = [
      { task_id: 'a', parent_session_id: 's', task_content: '', status: 'running', admitted_at: '2026-05-12T11:00:00Z' },
      { task_id: 'b', parent_session_id: 's', task_content: '', status: 'failed', admitted_at: '2026-05-12T11:00:00Z' },
      { task_id: 'c', parent_session_id: 's', task_content: '', status: 'completed', admitted_at: '2026-05-12T11:00:00Z' },
      { task_id: 'd', parent_session_id: 's', task_content: '', status: 'pending', admitted_at: '2026-05-12T11:00:00Z' },
    ];
    const c = countTasks(tasks);
    expect(c.total).toBe(4);
    expect(c.failed).toBe(1);
    expect(c.running).toBe(1);
    expect(c.done).toBe(1);
    expect(c.pending).toBe(1);
  });

  it('reads needs_input flag from the task row', () => {
    const tasks: TaskSummary[] = [
      {
        task_id: 'a', parent_session_id: 's', task_content: '',
        status: 'running', admitted_at: 'x',
        needs_input: 1,
      },
      {
        task_id: 'b', parent_session_id: 's', task_content: '',
        status: 'running', admitted_at: 'x',
      },
    ];
    const c = countTasks(tasks);
    expect(c.needs).toBe(1);
  });
});

describe('streamGroups', () => {
  it('puts failed in needsMe and running in running', () => {
    const tasks: TaskSummary[] = [
      { task_id: 'a', parent_session_id: 's', task_content: '', status: 'running', admitted_at: 'x' },
      { task_id: 'b', parent_session_id: 's', task_content: '', status: 'failed', admitted_at: 'x' },
    ];
    const g = streamGroups(tasks);
    expect(g.needsMe.map((t) => t.task_id)).toEqual(['b']);
    expect(g.running.map((t) => t.task_id)).toEqual(['a']);
  });

  it('puts needs_input running tasks into needsMe, not running', () => {
    const tasks: TaskSummary[] = [
      { task_id: 'a', parent_session_id: 's', task_content: '', status: 'running', admitted_at: 'x', needs_input: 1 },
      { task_id: 'b', parent_session_id: 's', task_content: '', status: 'running', admitted_at: 'x' },
    ];
    const g = streamGroups(tasks);
    expect(g.needsMe.map((t) => t.task_id)).toEqual(['a']);
    expect(g.running.map((t) => t.task_id)).toEqual(['b']);
  });
});

describe('heatOf', () => {
  it('forces hot tier when needs_input is set, regardless of age', () => {
    const NOW = Date.parse('2026-05-12T12:00:00Z');
    expect(
      heatOf(
        {
          status: 'running',
          admitted_at: '2026-05-11T11:00:00Z', // 25 hours ago → would be cold
          needs_input: 1,
        },
        NOW,
      ),
    ).toBe('hot');
  });
});

describe('buildPhaseTimeline', () => {
  it('marks the highest progress-message phase as active for a running task', () => {
    const task = {
      task_id: 't', parent_session_id: 's', task_content: '', status: 'running' as const,
      admitted_at: '2026-05-12T11:00:00Z',
      last_progress_message: 'Phase 2 implement complete',
    } as TaskDetail;
    const transcript: TranscriptEntry[] = [
      { id: '1', seq: 1, kind: 'chat', timestamp: '2026-05-12T11:01:00Z',
        content: { text: 'Phase 1 setup complete' },
        direction: 'outbound', source: 'agent' },
      { id: '2', seq: 2, kind: 'chat', timestamp: '2026-05-12T11:02:00Z',
        content: { text: 'Phase 2 implement complete: 3 files' },
        direction: 'outbound', source: 'agent' },
    ];
    const phases = buildPhaseTimeline(task, transcript);
    expect(phases[0].status).toBe('done');
    expect(phases[1].status).toBe('active');
    expect(phases[2].status).toBe('pending');
  });

  it('marks the failing phase when status=failed', () => {
    const task = {
      task_id: 't', parent_session_id: 's', task_content: '', status: 'failed' as const,
      admitted_at: '2026-05-12T11:00:00Z',
      last_progress_message: 'Phase 3 verify',
    } as TaskDetail;
    const phases = buildPhaseTimeline(task, []);
    expect(phases[2].status).toBe('failed');
  });
});
