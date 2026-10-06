import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import {
  clearCurrentReplyRoute,
  getCurrentInReplyTo,
  getCurrentReplyRoute,
  setCurrentReplyRoute,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function writeRouteRow(value: string, updatedAt = new Date().toISOString()): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_reply_route', value, updatedAt);
}

describe('reply route', () => {
  it('round-trips the message being answered with its chat and thread', () => {
    setCurrentReplyRoute({ inReplyTo: 'msg-1', platformId: 'C123', threadId: '1700.1' });
    expect(getCurrentReplyRoute()).toEqual({ inReplyTo: 'msg-1', platformId: 'C123', threadId: '1700.1' });
    expect(getCurrentInReplyTo()).toBe('msg-1');
  });

  it('clears on null, explicitly, and reads as absent', () => {
    setCurrentReplyRoute({ inReplyTo: 'msg-1', platformId: null, threadId: null });
    setCurrentReplyRoute(null);
    expect(getCurrentReplyRoute()).toBeNull();
    setCurrentReplyRoute({ inReplyTo: 'msg-2', platformId: null, threadId: null });
    clearCurrentReplyRoute();
    expect(getCurrentReplyRoute()).toBeNull();
    expect(getCurrentInReplyTo()).toBeNull();
  });

  it('expires after the batch age ceiling', () => {
    writeRouteRow(JSON.stringify({ inReplyTo: 'stale' }), new Date(Date.now() - 31 * 60 * 1000).toISOString());
    expect(getCurrentReplyRoute()).toBeNull();
  });

  it('fills missing fields with null and reads a malformed row as absent', () => {
    writeRouteRow(JSON.stringify({ inReplyTo: 'msg-3' }));
    expect(getCurrentReplyRoute()).toEqual({ inReplyTo: 'msg-3', platformId: null, threadId: null });
    writeRouteRow('{not json');
    expect(getCurrentReplyRoute()).toBeNull();
    expect(getCurrentInReplyTo()).toBeNull();
  });
});
