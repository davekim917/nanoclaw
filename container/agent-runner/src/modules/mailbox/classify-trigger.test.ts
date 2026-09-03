import { describe, expect, it } from 'bun:test';

import { classifyTrigger } from './selection.js';
import type { MessageInRow } from '../../db/messages-in.js';

function row(overrides: Partial<MessageInRow> & { content?: unknown } = {}): MessageInRow {
  const { content, ...rest } = overrides;
  return {
    id: 'm1',
    seq: 1,
    kind: 'chat',
    timestamp: '2026-08-24T00:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'slack',
    channel_type: 'slack',
    thread_id: null,
    content: JSON.stringify(content ?? { text: 'hi', sender: 'someone', senderId: 'user-123' }),
    ...rest,
  };
}

describe('classifyTrigger', () => {
  it('classifies an ordinary chat message as human', () => {
    expect(classifyTrigger([row({ kind: 'chat', channel_type: 'slack' })])).toBe('human');
  });

  it('classifies chat-sdk the same as chat', () => {
    expect(classifyTrigger([row({ kind: 'chat-sdk', channel_type: 'discord' })])).toBe('human');
  });

  it('classifies a genuine agent-to-agent message by channel_type=agent with real (non-system) content', () => {
    expect(
      classifyTrigger([
        row({ kind: 'chat', channel_type: 'agent', content: { text: 'status?', sender: 'peer-bot' } }),
      ]),
    ).toBe('agent');
  });

  it('classifies a scheduled-task fire by kind=task', () => {
    expect(classifyTrigger([row({ kind: 'task', channel_type: null })])).toBe('scheduled');
  });

  it('classifies a ceiling-respawn accountability wake by id prefix + system-authored content', () => {
    expect(
      classifyTrigger([
        row({
          id: 'ceiling-respawn-tool-123',
          kind: 'chat',
          channel_type: 'agent',
          content: { text: 'killed', sender: 'system', senderId: 'system' },
        }),
      ]),
    ).toBe('ceiling_respawn');
  });

  it('classifies other system-authored notice wakes as on_wake, not agent', () => {
    // These share channel_type='agent' with genuine a2a messages (both are
    // "agent-routed, not a real external channel") — the senderId:'system'
    // marker is what disambiguates them, not the channel_type.
    for (const id of ['host-restart-1-abc', 'provider-heal-1234', 'appr-note-1234-abcd', 'a2a-9999-xyz']) {
      expect(
        classifyTrigger([
          row({ id, kind: 'chat', channel_type: 'agent', content: { text: 'notice', sender: 'system', senderId: 'system' } }),
        ]),
      ).toBe('on_wake');
    }
  });

  it('falls back to unknown for a batch with no recognizable signal', () => {
    expect(classifyTrigger([row({ kind: 'system', channel_type: null, id: 'recall-x', content: { subtype: 'recall_context' } })])).toBe(
      'unknown',
    );
  });

  it('tolerates unparseable content instead of throwing', () => {
    const bad = row({ kind: 'chat', channel_type: 'agent' });
    bad.content = 'not json';
    expect(classifyTrigger([bad])).toBe('agent');
  });

  it('returns unknown for an empty batch', () => {
    expect(classifyTrigger([])).toBe('unknown');
  });
});
