import { describe, expect, it } from 'vitest';

import { equivalentSlackUserIds } from './slack-user-identity.js';

const TEAM_A = 'T-TEAM-A';
const TEAM_B = 'T-TEAM-B';

function bots(): Map<string, { userId: string; username: string; teamId: string }> {
  return new Map([
    ['slack-main', { userId: 'UBOTMAIN', username: 'main', teamId: TEAM_A }],
    ['slack-main-codex', { userId: 'UBOTCODEX', username: 'codex', teamId: TEAM_A }],
    ['slack-other', { userId: 'UBOTOTHER', username: 'other', teamId: TEAM_B }],
  ]);
}

describe('equivalentSlackUserIds', () => {
  it('includes sibling adapter forms registered to the same Slack workspace', () => {
    expect(equivalentSlackUserIds('slack-main:UOWNER', bots())).toEqual([
      'slack-main:UOWNER',
      'slack-main-codex:UOWNER',
    ]);
  });

  it('does not cross Slack workspaces even when the raw user id matches', () => {
    expect(equivalentSlackUserIds('slack-other:UOWNER', bots())).toEqual(['slack-other:UOWNER']);
  });

  it('fails closed when the current channel type has no registered Slack identity', () => {
    expect(equivalentSlackUserIds('slack-unregistered:UOWNER', bots())).toEqual(['slack-unregistered:UOWNER']);
  });

  it('leaves malformed and non-Slack identities unchanged', () => {
    expect(equivalentSlackUserIds('discord:UOWNER', bots())).toEqual(['discord:UOWNER']);
    expect(equivalentSlackUserIds('not-namespaced', bots())).toEqual(['not-namespaced']);
  });
});
