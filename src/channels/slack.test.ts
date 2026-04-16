import { describe, expect, it } from 'vitest';

import { parseSlackWorkspaces } from './slack.js';

describe('parseSlackWorkspaces', () => {
  it('returns an empty list when no credentials present', () => {
    expect(parseSlackWorkspaces({})).toEqual([]);
  });

  it('registers the primary workspace as channelType "slack"', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-primary',
      SLACK_SIGNING_SECRET: 'sig-primary',
    });
    expect(ws).toEqual([
      { channelType: 'slack', botToken: 'xoxb-primary', signingSecret: 'sig-primary' },
    ]);
  });

  it('registers suffixed workspaces as channelType "slack-<suffix>" (lowercased)', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN_ILLYSIUM: 'xoxb-ill',
      SLACK_SIGNING_SECRET_ILLYSIUM: 'sig-ill',
      SLACK_BOT_TOKEN_NEWJOB: 'xoxb-new',
      SLACK_SIGNING_SECRET_NEWJOB: 'sig-new',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack-illysium', 'slack-newjob']);
  });

  it('registers primary and suffixed workspaces together', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_SECOND: 'xoxb-s',
      SLACK_SIGNING_SECRET_SECOND: 'sig-s',
    });
    expect(ws.map((w) => w.channelType).sort()).toEqual(['slack', 'slack-second']);
  });

  it('skips workspaces missing a signing secret', () => {
    const ws = parseSlackWorkspaces({
      SLACK_BOT_TOKEN: 'xoxb-p',
      SLACK_SIGNING_SECRET: 'sig-p',
      SLACK_BOT_TOKEN_ORPHAN: 'xoxb-orphan',
    });
    expect(ws).toEqual([
      { channelType: 'slack', botToken: 'xoxb-p', signingSecret: 'sig-p' },
    ]);
  });

  it('skips workspaces missing a bot token', () => {
    const ws = parseSlackWorkspaces({
      SLACK_SIGNING_SECRET_ORPHAN: 'sig-orphan',
    });
    expect(ws).toEqual([]);
  });
});
