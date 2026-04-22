import { describe, expect, it } from 'vitest';

import {
  extractToolScopes,
  filterConfigSections,
  isToolEnabled,
  normalizeScopedSecret,
  scopedEnvKey,
} from './scoped-env.js';

describe('isToolEnabled', () => {
  it('returns true when tools is undefined (legacy: all tools enabled)', () => {
    expect(isToolEnabled(undefined, 'snowflake')).toBe(true);
  });

  it('matches bare tool names', () => {
    expect(isToolEnabled(['snowflake', 'aws'], 'snowflake')).toBe(true);
    expect(isToolEnabled(['snowflake'], 'aws')).toBe(false);
  });

  it('matches scoped tool entries against the bare name', () => {
    expect(isToolEnabled(['snowflake:sunday'], 'snowflake')).toBe(true);
  });

  it('empty array disables everything', () => {
    expect(isToolEnabled([], 'snowflake')).toBe(false);
  });
});

describe('extractToolScopes', () => {
  it('extracts safe scope values and marks the tool as scoped', () => {
    const out = extractToolScopes(['gmail:alpha', 'gmail:beta'], 'gmail');
    expect(out.scopes).toEqual(['alpha', 'beta']);
    expect(out.isScoped).toBe(true);
  });

  it('coexistence of bare and scoped entries means NOT scope-restricted', () => {
    const out = extractToolScopes(['gmail', 'gmail:alpha'], 'gmail');
    expect(out.scopes).toEqual(['alpha']);
    expect(out.isScoped).toBe(false);
  });

  it('drops unsafe scope values (path traversal, shell metachars)', () => {
    const out = extractToolScopes(['snowflake:../../../etc', 'snowflake:good'], 'snowflake');
    expect(out.scopes).toEqual(['good']);
  });

  it('returns empty when tool not present', () => {
    const out = extractToolScopes(['aws'], 'gmail');
    expect(out.scopes).toEqual([]);
    expect(out.isScoped).toBe(false);
  });
});

describe('scopedEnvKey', () => {
  it('bare fallback: unscoped returns the prefix as-is', () => {
    expect(scopedEnvKey('GITHUB_TOKEN', { scopes: [], isScoped: false, fallback: 'bare' })).toBe('GITHUB_TOKEN');
  });

  it('bare fallback: scoped appends the upper-cased scope', () => {
    expect(scopedEnvKey('GITHUB_TOKEN', { scopes: ['sunday'], isScoped: true, fallback: 'bare' })).toBe(
      'GITHUB_TOKEN_SUNDAY',
    );
  });

  it('group fallback: unscoped appends the group-scope', () => {
    expect(
      scopedEnvKey('RENDER_API_KEY', {
        scopes: [],
        isScoped: false,
        fallback: 'group',
        groupScope: 'illysium',
      }),
    ).toBe('RENDER_API_KEY_ILLYSIUM');
  });

  it('group fallback: throws when groupScope missing', () => {
    expect(() => scopedEnvKey('RENDER_API_KEY', { scopes: [], isScoped: false, fallback: 'group' })).toThrow(
      /groupScope required/,
    );
  });
});

describe('normalizeScopedSecret', () => {
  it('renames the scoped key to the generic key', () => {
    const secrets: Record<string, string> = { GITHUB_TOKEN_SUNDAY: 'ghp_xxx' };
    normalizeScopedSecret(secrets, 'GITHUB_TOKEN_SUNDAY', 'GITHUB_TOKEN');
    expect(secrets).toEqual({ GITHUB_TOKEN: 'ghp_xxx' });
  });

  it('no-ops when scoped and generic are the same key', () => {
    const secrets: Record<string, string> = { GITHUB_TOKEN: 'ghp_xxx' };
    normalizeScopedSecret(secrets, 'GITHUB_TOKEN', 'GITHUB_TOKEN');
    expect(secrets).toEqual({ GITHUB_TOKEN: 'ghp_xxx' });
  });

  it('no-ops when scoped key is missing', () => {
    const secrets: Record<string, string> = {};
    normalizeScopedSecret(secrets, 'GITHUB_TOKEN_SUNDAY', 'GITHUB_TOKEN');
    expect(secrets).toEqual({});
  });
});

describe('filterConfigSections', () => {
  it('keeps only allowed sections', () => {
    const input = `[default]
aws_access_key_id = DEFAULT

[work]
aws_access_key_id = WORK

[personal]
aws_access_key_id = PERSONAL
`;
    const out = filterConfigSections(input, ['work']);
    expect(out).toContain('[work]');
    expect(out).not.toContain('[personal]');
    // default is NOT always-included unless alwaysInclude is passed
    expect(out).not.toContain('[default]');
  });

  it('alwaysInclude preserves structural sections like [default]', () => {
    const input = `[default]
x=1

[work]
y=2

[personal]
z=3
`;
    const out = filterConfigSections(input, ['work'], { alwaysInclude: new Set(['default']) });
    expect(out).toContain('[default]');
    expect(out).toContain('[work]');
    expect(out).not.toContain('[personal]');
  });

  it('headerTransform matches "profile foo" against "foo"', () => {
    const input = `[default]
region = us-east-1

[profile work]
region = us-west-2

[profile personal]
region = eu-west-1
`;
    const out = filterConfigSections(input, ['work'], {
      alwaysInclude: new Set(['default']),
      headerTransform: (h) => h.replace(/^profile\s+/, ''),
    });
    expect(out).toContain('[default]');
    expect(out).toContain('[profile work]');
    expect(out).not.toContain('[profile personal]');
  });

  it('filters TOML connection sections and their referenced key paths', () => {
    const input = `[connections.sunday]
account = "abc"
private_key_path = "/home/x/.snowflake/keys/sunday.pem"

[connections.apollo]
account = "def"
private_key_path = "/home/x/.snowflake/keys/apollo.pem"
`;
    const out = filterConfigSections(input, ['connections.sunday']);
    expect(out).toContain('[connections.sunday]');
    expect(out).toContain('sunday.pem');
    expect(out).not.toContain('[connections.apollo]');
    expect(out).not.toContain('apollo.pem');
  });
});
