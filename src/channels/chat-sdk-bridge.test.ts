import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

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
