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

  it('never pings: platform-native broadcast and role tokens are broken like @names', async () => {
    const { bridge, posts, edits } = bridgeWith();
    const text = 'Relay\n✱ Tell <!here> and <!channel>, <!subteam^S123>, <@&42>, <@U0ABC> and @everyone';
    await bridge.deliver('thread-1', null, { kind: 'task_list', content: { text } });
    await bridge.deliver('thread-1', null, {
      kind: 'task_list',
      content: { operation: 'edit', messageId: 'msg-1', text },
    });
    for (const body of [posts[0].markdown!, edits[0].markdown!]) {
      expect(body).not.toMatch(/<[!@]/);
      expect(body).not.toMatch(/@[\w\p{L}]/u);
      expect(body.replace(/\u200b/g, '')).toBe(text);
    }
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

  it('never waits on a rate limit for a list edit or post — the host cools the row down instead', async () => {
    const limited = new Error('slack rate_limited: Retry-After: 30');
    const { bridge, edits } = bridgeWith({ editFailures: [limited] });
    await expect(
      bridge.deliver('thread-1', null, {
        kind: 'task_list',
        content: { operation: 'edit', messageId: 'msg-1', text: 'T\n✓ A', subtext: 'todos as of 3:00 PM' },
      }),
    ).rejects.toThrow('Retry-After');
    expect(edits).toHaveLength(0);
  });

  it('still retries a rate-limited edit of an ordinary reply', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, edits } = bridgeWith({ editFailures: [new Error('slack rate_limited: Retry-After: 1')] });
      const done = bridge.deliver('thread-1', null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: 'msg-1', text: 'Corrected.' },
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
