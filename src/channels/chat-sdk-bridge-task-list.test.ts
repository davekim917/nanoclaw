/**
 * The live task list at the delivery boundary (docs/specs/slack-task-list/plan.md):
 * it carries its "todos as of" footer on post and edit, stays one message
 * however long, never pings anyone, and a rate-limited edit is retried rather
 * than dropped — a dropped edit would leave the list showing stale progress.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { OutboundBody } from './chat-sdk-bridge.js';

interface Recorded {
  markdown?: string;
}

function bridgeWith(opts: { maxTextLength?: number; editFailures?: Error[] } = {}) {
  const posts: Recorded[] = [];
  const edits: Recorded[] = [];
  const failures = [...(opts.editFailures ?? [])];
  const adapter = {
    name: 'stub',
    channelIdFromThreadId: (t: string) => t,
    postMessage: async (threadId: string, body: Recorded) => {
      posts.push(body);
      return { id: `msg-${posts.length}`, threadId, raw: {} };
    },
    editMessage: async (threadId: string, messageId: string, body: Recorded) => {
      const failure = failures.shift();
      if (failure) throw failure;
      edits.push(body);
      return { id: messageId, threadId, raw: {} };
    },
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    ...(opts.maxTextLength ? { maxTextLength: opts.maxTextLength } : {}),
    renderSubtext: (body: OutboundBody, subtext: string): OutboundBody =>
      'markdown' in body ? { ...body, markdown: `${body.markdown}\n-# ${subtext}` } : body,
  });
  return { bridge, posts, edits };
}

describe('chat-sdk bridge — task list', () => {
  it('posts and edits with the footer', async () => {
    const { bridge, posts, edits } = bridgeWith();
    await bridge.deliver('thread-1', null, {
      kind: 'task_list',
      content: { text: 'Migrating\n✱ Run it', subtext: 'todos as of 3:00 PM' },
    });
    await bridge.deliver('thread-1', null, {
      kind: 'task_list',
      content: { operation: 'edit', messageId: 'msg-1', text: 'Migrating\n✓ Ran it', subtext: 'todos as of 3:02 PM' },
    });
    expect(posts[0].markdown).toBe('Migrating\n✱ Run it\n-# todos as of 3:00 PM');
    expect(edits[0].markdown).toBe('Migrating\n✓ Ran it\n-# todos as of 3:02 PM');
  });

  it('stays a single message when it outgrows the platform limit', async () => {
    const { bridge, posts } = bridgeWith({ maxTextLength: 120 });
    await bridge.deliver('thread-1', null, {
      kind: 'task_list',
      content: { text: `Big\n${'○ step\n'.repeat(60)}`, subtext: 'todos as of 3:00 PM' },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].markdown!.length).toBeLessThanOrEqual(120);
  });

  it('retries a rate-limited edit instead of dropping it', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, edits } = bridgeWith({ editFailures: [new Error('slack rate_limited: Retry-After: 1')] });
      const done = bridge.deliver('thread-1', null, {
        kind: 'task_list',
        content: { operation: 'edit', messageId: 'msg-1', text: 'T\n✓ A', subtext: 'todos as of 3:00 PM' },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(edits).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still surfaces an edit failure that is not a rate limit', async () => {
    const { bridge } = bridgeWith({ editFailures: [new Error('message_not_found')] });
    await expect(
      bridge.deliver('thread-1', null, {
        kind: 'task_list',
        content: { operation: 'edit', messageId: 'gone', text: 'T', subtext: 'todos as of 3:00 PM' },
      }),
    ).rejects.toThrow('message_not_found');
  });
});
