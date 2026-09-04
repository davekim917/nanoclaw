import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { OpenCodeProvider } from './opencode.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';

describe('createProvider (opencode)', () => {
  it('returns OpenCodeProvider for opencode', () => {
    expect(createProvider('opencode')).toBeInstanceOf(OpenCodeProvider);
  });
});

/**
 * OpenCode's `push()` never merges into the running turn — it appends to a
 * queue the generator drains only between turns. `hasQueuedWork` is what tells
 * the poll-loop not to publish `provider_executing = 0` in the gap between the
 * current turn's `result` and the queued turn actually starting, where a host
 * sweep would otherwise reap the container and lose the follow-up (#333).
 */
describe('OpenCodeProvider queued-work signal', () => {
  it('reports the pending queue, not stream liveness', () => {
    const provider = new OpenCodeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    // The generator is lazy, so nothing here contacts an OpenCode server: the
    // initial prompt is sitting in the same queue a push lands in.
    const query = provider.query({ prompt: 'first turn', cwd: '/workspace' });

    expect(query.hasQueuedWork?.()).toBe(true);
    query.push('follow-up pushed mid-turn');
    expect(query.hasQueuedWork?.()).toBe(true);
  });
});
