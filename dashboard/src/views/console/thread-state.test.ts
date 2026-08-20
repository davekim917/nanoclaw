import { describe, it, expect } from 'vitest';
import type { ThreadState } from '../../lib/api.js';
import {
  compareByActivity,
  compareThreads,
  emptyQueueMessage,
  leadsWithOldest,
  queueFilterPhrase,
} from './thread-state.js';

const row = (state: ThreadState, last_activity_at: string | null) => ({ state, last_activity_at });

const OLD = '2026-08-01T00:00:00Z';
const MID = '2026-08-10T00:00:00Z';
const NEW = '2026-08-19T00:00:00Z';

/* ─── (d) Attention lanes lead with the oldest ─────────────────────────────── */

describe('attention lanes sort oldest-first', () => {
  it('puts the longest-standing breach at the top of needs_you, stalled and unassigned', () => {
    for (const state of ['needs_you', 'stalled', 'unassigned'] as const) {
      expect(leadsWithOldest(state)).toBe(true);
      const sorted = [row(state, NEW), row(state, OLD), row(state, MID)].sort(compareThreads);
      expect(sorted.map((r) => r.last_activity_at)).toEqual([OLD, MID, NEW]);
    }
  });

  it('leaves running, idle and done newest-first — nobody is waiting on a promise there', () => {
    for (const state of ['running', 'idle', 'done'] as const) {
      expect(leadsWithOldest(state)).toBe(false);
      const sorted = [row(state, OLD), row(state, NEW), row(state, MID)].sort(compareThreads);
      expect(sorted.map((r) => r.last_activity_at)).toEqual([NEW, MID, OLD]);
    }
  });

  it('still ranks by lane before age — an idle row never outranks a breach', () => {
    const sorted = [row('idle', NEW), row('needs_you', NEW), row('running', OLD)].sort(compareThreads);
    expect(sorted.map((r) => r.state)).toEqual(['needs_you', 'running', 'idle']);
  });
});

/* ─── (e) Unknown age sorts last, explicitly ───────────────────────────────── */

describe('unknown age sorts last, in BOTH directions', () => {
  // This is the test the brief asks for: it fails if the comparator's direction
  // is ever changed back to leaning on `0` to push nulls down.
  it('lands a null-dated row at the bottom of an oldest-first lane', () => {
    const sorted = [row('needs_you', null), row('needs_you', OLD), row('needs_you', NEW)].sort(compareThreads);
    expect(sorted.map((r) => r.last_activity_at)).toEqual([OLD, NEW, null]);
  });

  it('lands a null-dated row at the bottom of a newest-first lane too', () => {
    const sorted = [row('idle', null), row('idle', OLD), row('idle', NEW)].sort(compareThreads);
    expect(sorted.map((r) => r.last_activity_at)).toEqual([NEW, OLD, null]);
  });

  it('is a null term, not an accident of sign — the raw comparator says so', () => {
    expect(compareByActivity(null, OLD, true)).toBeGreaterThan(0);
    expect(compareByActivity(null, OLD, false)).toBeGreaterThan(0);
    expect(compareByActivity(OLD, null, true)).toBeLessThan(0);
    expect(compareByActivity(OLD, null, false)).toBeLessThan(0);
    expect(compareByActivity(null, null, true)).toBe(0);
  });

  it('treats an unparseable timestamp as unknown rather than as the epoch', () => {
    const sorted = [row('needs_you', 'not-a-date'), row('needs_you', NEW)].sort(compareThreads);
    expect(sorted.map((r) => r.last_activity_at)).toEqual([NEW, 'not-a-date']);
  });
});

/* ─── (c) Empty states distinguish four facts ──────────────────────────────── */

describe('emptyQueueMessage', () => {
  it('says the window is empty when nothing exists at all', () => {
    expect(emptyQueueMessage({ total: 0, lane: 'needs_you', channelName: '#ops', query: 'x' })).toBe(
      'no threads in this window yet',
    );
  });

  it('calls a clear attention lane good news, in those words', () => {
    expect(emptyQueueMessage({ total: 9, lane: 'needs_you', channelName: null, query: '' })).toBe(
      'All clear — nothing needs you',
    );
    expect(emptyQueueMessage({ total: 9, lane: 'stalled', channelName: null, query: '' })).toBe(
      'All clear — nothing is stalled',
    );
    expect(emptyQueueMessage({ total: 9, lane: 'unassigned', channelName: null, query: '' })).toBe(
      'All clear — nothing is unassigned',
    );
  });

  it('speaks a channel filter back rather than answering "nothing here"', () => {
    expect(emptyQueueMessage({ total: 9, lane: 'all', channelName: '#dispatch', query: '' })).toBe(
      'nothing here lives in #dispatch',
    );
  });

  it('names the search that missed', () => {
    expect(emptyQueueMessage({ total: 9, lane: 'all', channelName: null, query: ' deploy ' })).toBe(
      'nothing here matches “deploy”',
    );
  });

  it('composes every axis the operator narrowed on', () => {
    expect(emptyQueueMessage({ total: 9, lane: 'needs_you', channelName: '#dispatch', query: 'deploy' })).toBe(
      'nothing here needs you and lives in #dispatch and matches “deploy”',
    );
  });

  it('gives the four situations four different sentences', () => {
    const said = new Set([
      emptyQueueMessage({ total: 0, lane: 'all', channelName: null, query: '' }),
      emptyQueueMessage({ total: 9, lane: 'needs_you', channelName: null, query: '' }),
      emptyQueueMessage({ total: 9, lane: 'needs_you', channelName: '#dispatch', query: '' }),
      emptyQueueMessage({ total: 9, lane: 'needs_you', channelName: null, query: 'deploy' }),
    ]);
    expect(said.size).toBe(4);
  });

  it('does not narrate a filter nobody set', () => {
    expect(queueFilterPhrase({ lane: 'all', channelName: null, query: '  ' })).toBe('');
  });
});
