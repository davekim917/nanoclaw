import { describe, expect, it } from 'vitest';

import type { FactInput, MemoryStore, RecallResult, RememberResult } from './store.js';

describe('store — interface compile checks', () => {
  it('test_FactInput_minimal_construction', () => {
    const f: FactInput = {
      content: 'x',
      category: 'fact',
      importance: 3,
      provenance: { sourceType: 'chat', sourceId: 'msg-1' },
    };
    expect(f.content).toBe('x');
  });

  it('test_MemoryStore_signature_idempotency_key', () => {
    class StubStore implements MemoryStore {
      async recall(
        _agentGroupId: string,
        _query: string,
        _opts?: { limit?: number; timeoutMs?: number; signal?: AbortSignal },
      ): Promise<RecallResult> {
        return { facts: [], totalAvailable: 0, latencyMs: 0, fromCache: false };
      }

      async remember(
        _agentGroupId: string,
        _fact: FactInput,
        _opts?: { idempotencyKey?: string },
      ): Promise<RememberResult> {
        return { action: 'skipped', factId: '' };
      }

      async health(_agentGroupId: string): Promise<{ ok: boolean; reason?: string }> {
        return { ok: true };
      }
    }

    const store = new StubStore();
    expect(store).toBeDefined();
  });
});
