import { describe, expect, it } from 'bun:test';

import { CodexTurnLiveness, normalizeCodexThreadStatus } from './codex-liveness.js';

function tracker() {
  let now = 1_000;
  return {
    liveness: new CodexTurnLiveness({
      probeFailureLimit: 3,
      inactiveSnapshotLimit: 2,
      now: () => now,
    }),
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('normalizeCodexThreadStatus', () => {
  it('accepts current string and object status shapes', () => {
    expect(normalizeCodexThreadStatus('active')).toBe('active');
    expect(normalizeCodexThreadStatus({ type: 'systemError' })).toBe('systemError');
    expect(normalizeCodexThreadStatus({ state: 'not_loaded' })).toBe('notLoaded');
  });

  it('fails open on future status shapes', () => {
    expect(normalizeCodexThreadStatus({ phase: 'new-shape' })).toBe('unknown');
  });
});

describe('CodexTurnLiveness', () => {
  it('tracks open items by id and type instead of a global counter', () => {
    const { liveness } = tracker();
    liveness.noteItemStarted({ id: 'reason-1', type: 'reasoning' });
    liveness.noteItemStarted({ id: 'spawn-1', type: 'subAgentActivity' });
    liveness.noteItemCompleted({ id: 'reason-1', type: 'reasoning' });

    expect(liveness.snapshot().openItems).toEqual([{ id: 'spawn-1', type: 'subAgentActivity' }]);
  });

  it('records the latest notification timestamp', () => {
    const { liveness, advance } = tracker();
    advance(250);
    liveness.noteNotification();
    expect(liveness.snapshot().lastNotificationAtMs).toBe(1_250);
  });

  it('keeps a silent turn healthy when the root is active', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeSuccess({ rootStatus: 'active', descendantStatuses: [] })).toEqual({
      kind: 'healthy',
    });
  });

  it('keeps a waiting root healthy when a descendant is active', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeSuccess({ rootStatus: 'idle', descendantStatuses: ['active'] })).toEqual({
      kind: 'healthy',
    });
  });

  it('does not restart on one transient failed probe and resets after success', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeFailure('timeout')).toMatchObject({ kind: 'suspect', consecutiveFailures: 1 });
    expect(liveness.noteProbeSuccess({ rootStatus: 'active', descendantStatuses: [] })).toEqual({
      kind: 'healthy',
    });
    expect(liveness.snapshot().consecutiveProbeFailures).toBe(0);
  });

  it('recovers after the configured consecutive failed probes', () => {
    const { liveness } = tracker();
    liveness.noteProbeFailure('timeout 1');
    liveness.noteProbeFailure('timeout 2');
    expect(liveness.noteProbeFailure('timeout 3')).toMatchObject({
      kind: 'recover',
      classification: 'control_plane_unresponsive',
    });
  });

  it('requires repeated inactive snapshots before declaring protocol desync', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeSuccess({ rootStatus: 'idle', descendantStatuses: ['idle'] })).toMatchObject({
      kind: 'suspect',
    });
    expect(liveness.noteProbeSuccess({ rootStatus: 'idle', descendantStatuses: ['notLoaded'] })).toMatchObject({
      kind: 'recover',
      classification: 'protocol_desync',
    });
  });

  it('recovers immediately from a responsive systemError state', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeSuccess({ rootStatus: 'systemError', descendantStatuses: [] })).toMatchObject({
      kind: 'recover',
      classification: 'protocol_desync',
    });
  });

  it('fails open when a responsive app-server returns an unknown status', () => {
    const { liveness } = tracker();
    expect(liveness.noteProbeSuccess({ rootStatus: 'unknown', descendantStatuses: [] })).toEqual({
      kind: 'healthy',
    });
  });
});
