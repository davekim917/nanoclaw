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
});
