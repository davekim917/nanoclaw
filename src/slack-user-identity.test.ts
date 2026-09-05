import { describe, expect, it } from 'vitest';

import type { SlackBotIdentity } from './channels/slack-mentions.js';
import { equivalentSlackUserIds, resolveOperatorSlackUserId } from './slack-user-identity.js';

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

/**
 * Acceptance case 10 of the T6 scope: "the approver is chosen from the origin
 * bot's workspace; a same-handle owner in another workspace is ignored."
 */
describe('resolveOperatorSlackUserId', () => {
  const botMap = (): ReadonlyMap<string, SlackBotIdentity> => bots() as ReadonlyMap<string, SlackBotIdentity>;

  const human = (userId: string, teamId: string): SlackBotIdentity => ({
    userId,
    username: userId.toLowerCase(),
    teamId,
  });

  it('picks the first approver that belongs to the origin workspace', () => {
    expect(resolveOperatorSlackUserId(['slack-main:UOWNER'], 'slack-main', { bots: botMap() })).toEqual({
      userId: 'slack-main:UOWNER',
      slackUserId: 'UOWNER',
    });
  });

  it('accepts a sibling-instance approver in the same workspace', () => {
    // The owner is persisted against the codex sibling; the origin bot is the
    // primary. Same team id, so the same human.
    expect(resolveOperatorSlackUserId(['slack-main-codex:UOWNER'], 'slack-main', { bots: botMap() })).toEqual({
      userId: 'slack-main-codex:UOWNER',
      slackUserId: 'UOWNER',
    });
  });

  it('ignores a same-handle owner registered in another workspace', () => {
    expect(resolveOperatorSlackUserId(['slack-other:UOWNER'], 'slack-main', { bots: botMap() })).toBeNull();
  });

  it('skips non-Slack and other-workspace approvers to reach the one that qualifies', () => {
    expect(
      resolveOperatorSlackUserId(['discord:UOWNER', 'slack-other:UOWNER', 'slack-main:UOWNER2'], 'slack-main', {
        bots: botMap(),
      }),
    ).toEqual({ userId: 'slack-main:UOWNER2', slackUserId: 'UOWNER2' });
  });

  it('fails closed when the origin channel type has no registered bot identity', () => {
    expect(resolveOperatorSlackUserId(['slack-main:UOWNER'], 'slack-unregistered', { bots: botMap() })).toBeNull();
  });

  it('returns null for an empty approver list', () => {
    expect(resolveOperatorSlackUserId([], 'slack-main', { bots: botMap() })).toBeNull();
  });

  it('rejects an approver whose handle is not a Slack user id', () => {
    expect(resolveOperatorSlackUserId(['slack-main:not-a-user'], 'slack-main', { bots: botMap() })).toBeNull();
  });

  it('requires roster membership when the origin workspace roster is known', () => {
    const humans = new Map([[TEAM_A, [human('UMEMBER', TEAM_A)]]]);
    expect(resolveOperatorSlackUserId(['slack-main:UGHOST'], 'slack-main', { bots: botMap(), humans })).toBeNull();
    expect(resolveOperatorSlackUserId(['slack-main:UMEMBER'], 'slack-main', { bots: botMap(), humans })).toEqual({
      userId: 'slack-main:UMEMBER',
      slackUserId: 'UMEMBER',
    });
  });

  it('skips the roster filter when the origin workspace roster is empty', () => {
    // users:read missing, or the hourly sync has not run yet. Filter 1 is
    // already the workspace boundary, so this must not refuse everything.
    const humans = new Map([[TEAM_B, [human('UOTHER', TEAM_B)]]]);
    expect(resolveOperatorSlackUserId(['slack-main:UOWNER'], 'slack-main', { bots: botMap(), humans })).toEqual({
      userId: 'slack-main:UOWNER',
      slackUserId: 'UOWNER',
    });
  });
});
