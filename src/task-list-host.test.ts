/**
 * The platform status line under the live task list: "is thinking…" until
 * the list names the current item, then "is working: <item>", forgotten when
 * typing stops (docs/specs/slack-task-list/plan.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: uniqueTmpRoot('test-task-list-host'), TASK_LIST_ENABLED: true };
});

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { isHumanChatSdkContent, setTypingStatusText, typingStatusFor } from './task-list-host.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

function captureStatuses() {
  const statuses: Array<string | undefined> = [];
  setTypingAdapter({
    async setTyping(_channelType, _platformId, _threadId, _instance, status) {
      statuses.push(status);
    },
  });
  return statuses;
}

describe('status-line text', () => {
  it('says "is thinking…" until the task list names the current item, then shows it', async () => {
    const statuses = captureStatuses();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    await vi.advanceTimersByTimeAsync(0);
    setTypingStatusText('sess-1', 'Run the migration');
    await vi.advanceTimersByTimeAsync(4000);
    expect(statuses).toEqual(['is thinking…', 'is working: Run the migration']);
  });

  it('clips a long item and forgets it when typing stops', async () => {
    const statuses = captureStatuses();
    setTypingStatusText('sess-1', 'x'.repeat(100));
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses[0]).toBe(`is working: ${'x'.repeat(59)}…`);
    stopTypingRefresh('sess-1');
    expect(typingStatusFor('sess-1')).toBe('is thinking…');
  });
});

describe('isHumanChatSdkContent', () => {
  it('is true only for a chat-sdk message whose author is explicitly not a bot', () => {
    expect(isHumanChatSdkContent('chat-sdk', JSON.stringify({ author: { isBot: false } }))).toBe(true);
    expect(isHumanChatSdkContent('chat-sdk', JSON.stringify({ author: { isBot: true } }))).toBe(false);
    expect(isHumanChatSdkContent('chat-sdk', JSON.stringify({}))).toBe(false);
    expect(isHumanChatSdkContent('chat', JSON.stringify({ author: { isBot: false } }))).toBe(false);
    expect(isHumanChatSdkContent('chat-sdk', 'not json')).toBe(false);
  });
});
