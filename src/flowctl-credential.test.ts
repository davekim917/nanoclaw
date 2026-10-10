import { describe, expect, it } from 'vitest';

import { resolveFlowctlToken } from './flowctl-credential.js';

describe('resolveFlowctlToken', () => {
  const env = {
    FLOW_AUTH_TOKEN_ACME_CORP: 'acme-key',
    FLOW_AUTH_TOKEN_OTHER: 'other-key',
    FLOW_AUTH_TOKEN: 'bare-key',
  };

  it.each([
    ['an explicit flowctl tool and the folder-scoped key', ['hex', 'flowctl'], 'acme-corp', 'acme-key'],
    ['a scoped flowctl tool entry', ['flowctl:acme'], 'acme-corp', undefined],
    // An absent `tools` list means "every tool" elsewhere; a write-capable Estuary key must not ride on that.
    ['no tools list at all', undefined, 'acme-corp', undefined],
    ['a tools list without flowctl', ['hex'], 'acme-corp', undefined],
    // No bare fallback: the unscoped name must never hand one tenant's key to a group without its own.
    ['a folder with only the bare key', ['flowctl'], 'no-key-group', undefined],
  ])('with %s', (_label, tools, folder, expected) => {
    expect(resolveFlowctlToken(tools, folder, env)).toBe(expected);
  });
});
