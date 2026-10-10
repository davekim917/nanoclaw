import { describe, expect, it } from 'vitest';

import { resolveFlowctlToken } from './flowctl-credential.js';

describe('resolveFlowctlToken', () => {
  const env = {
    FLOW_AUTH_TOKEN_MADISON_REED: 'mr-key',
    FLOW_AUTH_TOKEN_OTHER: 'other-key',
    FLOW_AUTH_TOKEN: 'bare-key',
  };

  it.each([
    ['an explicit flowctl tool and the folder-scoped key', ['hex', 'flowctl'], 'madison-reed', 'mr-key'],
    ['a scoped flowctl tool entry', ['flowctl:mr'], 'madison-reed', 'mr-key'],
    // An absent `tools` list means "every tool" elsewhere; a write-capable Estuary key must not ride on that.
    ['no tools list at all', undefined, 'madison-reed', undefined],
    ['a tools list without flowctl', ['hex'], 'madison-reed', undefined],
    // No bare fallback: the unscoped name must never hand one tenant's key to a group without its own.
    ['a folder with only the bare key', ['flowctl'], 'no-key-group', undefined],
  ])('with %s', (_label, tools, folder, expected) => {
    expect(resolveFlowctlToken(tools, folder, env)).toBe(expected);
  });
});
