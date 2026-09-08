import { describe, expect, it } from 'vitest';

import { findSiblingParityDrifts, isSiblingBoundField } from './sibling-parity.js';

describe('sibling capability parity', () => {
  it('allows provider auth and operator-tunable resource differences', () => {
    expect(isSiblingBoundField('codexAuthFallbacks')).toBe(true);
    expect(isSiblingBoundField('resources')).toBe(true);

    expect(
      findSiblingParityDrifts(
        { resources: { memory: { limitMb: 5120 } } },
        {
          resources: { memory: { limitMb: 3072 } },
          codexAuthFallbacks: ['~/.codex-fallback'],
        },
      ),
    ).toEqual([]);
  });

  it.each([
    ['omit the source identity', {}],
    ['set a distinct identity', { gitIdentity: { name: 'Fixture Sibling', email: 'fixture-sibling@example.invalid' } }],
  ])('allows a sibling to %s', (_case, sibling) => {
    expect(isSiblingBoundField('gitIdentity')).toBe(true);
    expect(
      findSiblingParityDrifts(
        { gitIdentity: { name: 'Fixture Source', email: 'fixture-source@example.invalid' } },
        sibling,
      ),
    ).toEqual([]);
  });

  it('compares the Slack capability but not adapter-specific allowlist IDs', () => {
    expect(
      findSiblingParityDrifts(
        { slack_user_token: { enabled: true, also_allowed_in: ['mg-source'] } },
        { slack_user_token: { enabled: true, also_allowed_in: ['mg-sibling'] } },
      ),
    ).toEqual([]);

    expect(
      findSiblingParityDrifts(
        { slack_user_token: { enabled: true, also_allowed_in: ['mg-source'] } },
        { slack_user_token: { enabled: false, also_allowed_in: ['mg-sibling'] } },
      ),
    ).toEqual([{ field: 'slack_user_token.enabled', source: true, sibling: false }]);
  });

  it('treats an absent Slack config as disabled and still reports capability drift', () => {
    expect(findSiblingParityDrifts({}, { slack_user_token: { enabled: false } })).toEqual([]);
    expect(findSiblingParityDrifts({}, { slack_user_token: { enabled: true } })).toEqual([
      { field: 'slack_user_token.enabled', source: false, sibling: true },
    ]);
  });

  it('compares future Slack policy fields instead of ignoring the whole object', () => {
    expect(
      findSiblingParityDrifts(
        { slack_user_token: { enabled: true, policy: 'approval' } },
        { slack_user_token: { enabled: true, policy: 'allow' } },
      ),
    ).toEqual([
      {
        field: 'slack_user_token',
        source: { enabled: true, policy: 'approval' },
        sibling: { enabled: true, policy: 'allow' },
      },
    ]);
  });

  it('continues to report capability-surface drift', () => {
    expect(findSiblingParityDrifts({ tools: ['datafold'] }, { tools: [] })).toEqual([
      { field: 'tools', source: ['datafold'], sibling: [] },
    ]);
  });

  it('does not report objects whose key order differs', () => {
    expect(
      findSiblingParityDrifts(
        { mcpServers: { datafold: { type: 'http', url: 'https://app.datafold.com/mcp/' } } },
        { mcpServers: { datafold: { url: 'https://app.datafold.com/mcp/', type: 'http' } } },
      ),
    ).toEqual([]);
  });
});
