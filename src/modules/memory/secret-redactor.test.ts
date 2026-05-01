import { describe, expect, it } from 'vitest';

import { redactSecrets } from './secret-redactor.js';
import type { FactInput } from './store.js';

function makeFact(content: string): FactInput {
  return {
    content,
    category: 'fact',
    importance: 3,
    provenance: { sourceType: 'chat', sourceId: 'msg-1' },
  };
}

describe('redactSecrets', () => {
  it('test_redactor_blocks_pem_key', () => {
    const result = redactSecrets(makeFact('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...'));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('test_redactor_blocks_bearer_token', () => {
    const result = redactSecrets(makeFact('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature'));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('test_redactor_blocks_anthropic_key', () => {
    const result = redactSecrets(makeFact('My API key is sk-ant-api03-abc123def456xyz789'));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('test_redactor_blocks_aws_access_key', () => {
    const result = redactSecrets(makeFact('Access key: AKIAIOSFODNN7EXAMPLE'));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('test_redactor_passes_normal_prose', () => {
    const result = redactSecrets(makeFact('The user prefers dark mode and concise responses.'));
    expect(result.shouldStore).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('test_redactor_catches_secret_past_8KB_offset', () => {
    // F18 regression: prior implementation truncated input at 8192 chars, so a
    // bearer token at offset >8KB in a long source-ingest document silently
    // passed through unredacted. The chunked sliding-window scan must catch it.
    const filler = 'x'.repeat(10_000);
    const secretAfter10K = `${filler} Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature`;
    const result = redactSecrets(makeFact(secretAfter10K));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('test_redactor_catches_secret_straddling_chunk_boundary', () => {
    // The sliding-window overlap (2KB) must cover any secret pattern that
    // straddles a chunk boundary. Place a bearer token starting at offset
    // 8000 — the first chunk runs [0..8192) and would only see "Authorization:
    // Bearer eyJh"; the second chunk at offset 6144 (step=8192-2048) sees the
    // full token. If overlap < pattern length, we'd miss it.
    const prefix = 'x'.repeat(8_000);
    const secretAtBoundary = `${prefix}Authorization: Bearer eyJfullsecrettokenpayload.signature.here trailing`;
    const result = redactSecrets(makeFact(secretAtBoundary));
    expect(result.shouldStore).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
