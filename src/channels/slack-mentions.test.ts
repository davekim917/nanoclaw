import { describe, expect, it, vi } from 'vitest';

import { fetchSlackBotIdentity, resolveSlackMentions, type SlackBotIdentity } from './slack-mentions.js';

const ILLY_TEAM = 'T-ILLYSIUM';
const MR_TEAM = 'T-MADISONREED';

function makeBots(): Map<string, SlackBotIdentity> {
  const bots = new Map<string, SlackBotIdentity>();
  bots.set('slack-illysium', { userId: 'U-ILLIE', username: 'illie', teamId: ILLY_TEAM });
  bots.set('slack-illysium-codex', { userId: 'U-CODEX', username: 'illie-codex', teamId: ILLY_TEAM });
  bots.set('slack-madisonreed', { userId: 'U-BO', username: 'bo', teamId: MR_TEAM });
  return bots;
}

describe('resolveSlackMentions', () => {
  it('returns text unchanged when no bots are registered', () => {
    expect(resolveSlackMentions('@illie-codex hello', 'slack-illysium', new Map())).toBe('@illie-codex hello');
  });

  it('returns text unchanged when current channel has no registered bot identity', () => {
    expect(resolveSlackMentions('@illie-codex hello', 'slack-unknown', makeBots())).toBe('@illie-codex hello');
  });

  it('rewrites @sibling → <@USER_ID> within the same workspace', () => {
    expect(resolveSlackMentions('@illie-codex take this', 'slack-illysium', makeBots())).toBe('<@U-CODEX> take this');
  });

  it('rewrites case-insensitively', () => {
    expect(resolveSlackMentions('@Illie-Codex hi', 'slack-illysium', makeBots())).toBe('<@U-CODEX> hi');
    expect(resolveSlackMentions('@ILLIE-CODEX hi', 'slack-illysium', makeBots())).toBe('<@U-CODEX> hi');
  });

  it('rewrites bracketed `<@name>` (agent emits Slack-style wrapper but with username)', () => {
    expect(resolveSlackMentions('<@illie-codex> picking up', 'slack-illysium', makeBots())).toBe(
      '<@U-CODEX> picking up',
    );
  });

  it('does NOT cross workspaces — illie can not @-mention bo (different teamId)', () => {
    // illie (Illysium workspace) writes about MR's bot. Slack tenants are
    // disjoint, so the rewrite must NOT happen — Slack would reject the
    // user ID at post time and the message would 400.
    expect(resolveSlackMentions('@bo is in another workspace', 'slack-illysium', makeBots())).toBe(
      '@bo is in another workspace',
    );
  });

  it('leaves existing `<@USER_ID>` alone — already canonical', () => {
    expect(resolveSlackMentions('<@U0AKALV5HRP> hi', 'slack-illysium', makeBots())).toBe('<@U0AKALV5HRP> hi');
  });

  it('leaves channel mentions `<#C…>` alone', () => {
    expect(resolveSlackMentions('see <#C0AJA89MN2E>', 'slack-illysium', makeBots())).toBe('see <#C0AJA89MN2E>');
  });

  it('does not parse `email@domain.com` as a mention', () => {
    expect(resolveSlackMentions('write to ops@illie-codex.example.com', 'slack-illysium', makeBots())).toBe(
      'write to ops@illie-codex.example.com',
    );
  });

  it('skips fenced code blocks', () => {
    const input = 'before\n```\n@illie-codex inside code\n```\nafter';
    expect(resolveSlackMentions(input, 'slack-illysium', makeBots())).toBe(input);
  });

  it('skips inline code', () => {
    expect(resolveSlackMentions('inline `@illie-codex` literal', 'slack-illysium', makeBots())).toBe(
      'inline `@illie-codex` literal',
    );
  });

  it('rewrites multiple mentions in one message', () => {
    expect(resolveSlackMentions('over to @illie-codex and back to @illie', 'slack-illysium', makeBots())).toBe(
      'over to <@U-CODEX> and back to <@U-ILLIE>',
    );
  });

  it('handles trailing punctuation correctly (no greedy capture)', () => {
    expect(resolveSlackMentions('your turn, @illie-codex.', 'slack-illysium', makeBots())).toBe(
      'your turn, <@U-CODEX>.',
    );
    expect(resolveSlackMentions('hey @illie-codex, ready?', 'slack-illysium', makeBots())).toBe(
      'hey <@U-CODEX>, ready?',
    );
    expect(resolveSlackMentions('@illie-codex!', 'slack-illysium', makeBots())).toBe('<@U-CODEX>!');
  });

  it('leaves unknown @-names alone (fail-soft)', () => {
    expect(resolveSlackMentions('@randomuser hi', 'slack-illysium', makeBots())).toBe('@randomuser hi');
  });
});

describe('fetchSlackBotIdentity', () => {
  it('returns identity when auth.test succeeds', async () => {
    const client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          ok: true,
          user_id: 'U-ILLIE',
          user: 'illie',
          team_id: ILLY_TEAM,
        }),
      },
    };
    const id = await fetchSlackBotIdentity(client);
    expect(id).toEqual({ userId: 'U-ILLIE', username: 'illie', teamId: ILLY_TEAM });
  });

  it('returns null on incomplete response', async () => {
    const client = {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: 'U-X' }) },
    };
    expect(await fetchSlackBotIdentity(client)).toBeNull();
  });

  it('returns null when auth.test rejects', async () => {
    const client = {
      auth: { test: vi.fn().mockRejectedValue(new Error('not_authed')) },
    };
    expect(await fetchSlackBotIdentity(client)).toBeNull();
  });
});
