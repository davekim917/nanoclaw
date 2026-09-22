/**
 * Status subtext at the delivery boundary.
 *
 * The runner decides WHETHER a message gets a subtext (poll-loop.ts stamps it
 * only on the agent's own replies); the bridge decides WHERE it lands. Four
 * decisions live here and each has a visible failure mode: opt-in per adapter,
 * chat-only, last chunk only, and reserving the footer's room before splitting
 * so an appended footer cannot push a maximum-length message over the
 * platform's cap.
 */
import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';
import type { OutboundBody } from './chat-sdk-bridge.js';

interface Recorded {
  markdown?: string;
  raw?: string;
  subtext?: string;
}

/** A bridge whose adapter records every body it is handed. */
function subtextBridge(opts: { renderSubtext?: boolean; maxTextLength?: number }) {
  const posts: Recorded[] = [];
  const edits: Recorded[] = [];
  const adapter = {
    name: 'stub',
    channelIdFromThreadId: (t: string) => t,
    postMessage: async (_threadId: string, body: Recorded) => {
      posts.push(body);
      return { id: `msg-${posts.length}`, threadId: _threadId, raw: {} };
    },
    editMessage: async (_threadId: string, _messageId: string, body: Recorded) => {
      edits.push(body);
      return { id: _messageId, threadId: _threadId, raw: {} };
    },
  } as unknown as Adapter;

  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    ...(opts.maxTextLength ? { maxTextLength: opts.maxTextLength } : {}),
    ...(opts.renderSubtext
      ? {
          // Stands in for Discord's inline `-# ` rendering — the shape that
          // spends the footer inside the message text.
          renderSubtext: (body: OutboundBody, subtext: string): OutboundBody =>
            'markdown' in body ? { ...body, markdown: `${body.markdown}\n-# ${subtext}` } : body,
        }
      : {}),
  });
  return { bridge, posts, edits };
}

describe('chat-sdk bridge status subtext', () => {
  it('renders the subtext on a chat reply', async () => {
    const { bridge, posts } = subtextBridge({ renderSubtext: true });

    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'All set.', subtext: 'opus-5 · xhigh · 142k context' },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].markdown).toBe('All set.\n-# opus-5 · xhigh · 142k context');
  });

  it('posts nothing extra when the adapter declares no renderer', async () => {
    // Opt-in: a platform that cannot render small print gets no footer at all,
    // rather than a full-size line of telemetry under every reply.
    const { bridge, posts } = subtextBridge({ renderSubtext: false });

    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'All set.', subtext: 'opus-5 · xhigh · 142k context' },
    });

    expect(posts[0].markdown).toBe('All set.');
  });

  it('does not stamp a status thought-balloon', async () => {
    // A 'status' bubble is transient — the host deletes it when the real reply
    // lands — so a footer on it outlives nothing and just adds noise.
    const { bridge, posts } = subtextBridge({ renderSubtext: true });

    await bridge.deliver('thread-1', null, {
      kind: 'status',
      content: { text: 'Thinking…', subtext: 'opus-5 · xhigh · 142k context' },
    });

    expect(posts[0].markdown).toBe('Thinking…');
  });

  it('stamps only the LAST chunk of a split reply', async () => {
    const { bridge, posts } = subtextBridge({ renderSubtext: true, maxTextLength: 60 });
    const body = Array.from({ length: 12 }, (_, i) => `line ${i} of the reply`).join('\n');

    await bridge.deliver('thread-1', null, { kind: 'chat', content: { text: body, subtext: 'opus-5 · high' } });

    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts.slice(0, -1)) {
      expect(post.markdown).not.toContain('-#');
    }
    expect(posts[posts.length - 1].markdown).toContain('\n-# opus-5 · high');
  });

  it('keeps every posted chunk within the platform limit once the footer is appended', async () => {
    // The regression this exists for: split to exactly `maxTextLength`, then
    // append a footer, and the final chunk is over the cap — which Discord
    // rejects outright, losing the tail of the reply.
    const limit = 120;
    const { bridge, posts } = subtextBridge({ renderSubtext: true, maxTextLength: limit });
    const body = Array.from({ length: 40 }, (_, i) => `sentence number ${i}.`).join(' ');

    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: body, subtext: 'opus-5 · xhigh · 142k context' },
    });

    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect((post.markdown ?? '').length).toBeLessThanOrEqual(limit);
    }
    expect(posts[posts.length - 1].markdown).toContain('-# opus-5 · xhigh · 142k context');
  });

  it('ignores a blank subtext', async () => {
    const { bridge, posts } = subtextBridge({ renderSubtext: true });

    await bridge.deliver('thread-1', null, { kind: 'chat', content: { text: 'All set.', subtext: '   ' } });

    expect(posts[0].markdown).toBe('All set.');
  });

  // #1016: an agent correcting its own reply used to lose the line, because
  // the edit branch returned before the subtext was ever looked at.
  it('keeps the subtext when the agent edits its own reply', async () => {
    const { bridge, edits } = subtextBridge({ renderSubtext: true });

    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'm-1', text: 'Corrected.', subtext: 'opus-5 · high · 90k context' },
    });

    expect(edits).toHaveLength(1);
    expect(edits[0].markdown).toBe('Corrected.\n-# opus-5 · high · 90k context');
  });

  it('leaves a status-bubble edit without a footer', async () => {
    const { bridge, edits } = subtextBridge({ renderSubtext: true });

    await bridge.deliver('thread-1', null, {
      kind: 'status',
      content: { operation: 'edit', messageId: 'm-1', text: 'thinking…', subtext: 'opus-5 · high' },
    });

    expect(edits[0].markdown).not.toContain('-#');
  });

  it('keeps an edited reply within the platform limit once the footer is appended', async () => {
    const { bridge, edits } = subtextBridge({ renderSubtext: true, maxTextLength: 100 });

    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: 'm-1', text: 'x'.repeat(300), subtext: 'opus-5 · high · 90k context' },
    });

    expect(edits[0].markdown!.length).toBeLessThanOrEqual(100);
    expect(edits[0].markdown).toContain('-# opus-5 · high · 90k context');
  });
});
