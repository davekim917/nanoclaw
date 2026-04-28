import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface RecordedPost {
  threadId: string;
  body: { markdown?: string; raw?: string };
}

/**
 * Build a bridge over a stub adapter that records every postMessage body so
 * tests can assert which delivery shape (markdown vs raw) was used.
 */
function recordingBridge(opts: {
  transformOutboundText?: (t: string) => string;
  transformOutboundMarkdown?: (t: string) => string;
}): { bridge: ReturnType<typeof createChatSdkBridge>; posts: RecordedPost[] } {
  const posts: RecordedPost[] = [];
  const adapter = stubAdapter({
    name: 'stub',
    channelIdFromThreadId: (t: string) => t,
    postMessage: async (threadId: string, body: { markdown?: string; raw?: string }) => {
      posts.push({ threadId, body });
      return { id: 'msg-stub', threadId, raw: {} };
    },
  } as unknown as Partial<Adapter>);
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    ...opts,
  });
  return { bridge, posts };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge — outbound transform path', () => {
  // The transform mode determines whether the adapter sees `markdown` or `raw`.
  // `markdown` is required for adapters that emit rich blocks (Slack Block Kit
  // tables, Discord ASCII tables) — those code paths are gated on the message
  // arriving as `markdown` or `ast`. `raw` is appropriate when the transform
  // has already pre-rendered to platform-native syntax (Telegram mrkdwn).

  it('transformOutboundText forces raw delivery (legacy behavior preserved)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundText: (t) => t.toUpperCase(),
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'hello *world*' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ raw: 'HELLO *WORLD*' });
  });

  it('transformOutboundMarkdown keeps markdown delivery (rich-block features still fire)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundMarkdown: (md) => md.replace(/^## (.+)$/gm, '**$1**'),
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: '## Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.markdown).toBeDefined();
    expect(posts[0].body.raw).toBeUndefined();
    expect(posts[0].body.markdown).toBe('**Heading**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('no transform → markdown delivery, content unchanged', async () => {
    const { bridge, posts } = recordingBridge({});
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: '**bold** text' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ markdown: '**bold** text' });
  });

  it('transformOutboundText wins when both are set (legacy precedence)', async () => {
    const { bridge, posts } = recordingBridge({
      transformOutboundText: () => 'TEXT-WINS',
      transformOutboundMarkdown: () => 'MARKDOWN-LOSES',
    });
    await bridge.deliver('thread-1', null, {
      kind: 'chat',
      content: { text: 'whatever' },
    } as never);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ raw: 'TEXT-WINS' });
  });
});
