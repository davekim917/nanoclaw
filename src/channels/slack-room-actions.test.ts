/**
 * The adapter's narrow per-instance room call surface (T6 PR 5).
 *
 * These pin the boundary the design turns on: `src/modules/slack-rooms/`
 * names an INSTANCE and never holds a bot token, so the instance → token
 * resolution, the Slack argument shapes, and the two failure modes all belong
 * to `src/channels/slack.ts` and are asserted here rather than in the feature
 * module's tests.
 *
 * `../env.js` is mocked because `slack.ts` reads the Slack env dict at module
 * scope (the declaration-only registrations) — the mock is hoisted, so the
 * import below sees this fixture rather than whatever `.env` the working
 * directory happens to hold.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFileMatching: (pattern: RegExp) =>
    Object.fromEntries(
      Object.entries({
        SLACK_BOT_TOKEN: 'xoxb-default',
        SLACK_APP_TOKEN: 'xapp-default',
        SLACK_BOT_TOKEN_ALPHA: 'xoxb-alpha',
        SLACK_APP_TOKEN_ALPHA: 'xapp-alpha',
      }).filter(([key]) => pattern.test(key)),
    ),
  readEnvFile: () => ({}),
}));

const { createConversation, inviteUsers, UnknownSlackInstanceError } = await import('./slack.js');
const { SlackApiError } = await import('./slack-lib.js');

type Call = { token: string; method: string; body: Record<string, unknown>; step: string };

function recorder(responses: Record<string, Record<string, unknown>>) {
  const calls: Call[] = [];
  const api = async (token: string, method: string, body: Record<string, unknown>, step: string) => {
    calls.push({ token, method, body, step });
    const response = responses[method];
    if (!response) throw new SlackApiError(step, `slack ${method} failed: not_stubbed`);
    return response;
  };
  return { calls, api };
}

describe('createConversation', () => {
  it('creates a private channel on the named instance token', async () => {
    const { calls, api } = recorder({
      'conversations.create': { ok: true, channel: { id: 'C100', name: 'ops-room' } },
    });

    const room = await createConversation('slack-alpha', { name: 'Ops Room' }, api);

    expect(room).toEqual({ channelId: 'C100', name: 'ops-room' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.token).toBe('xoxb-alpha');
    expect(calls[0]!.method).toBe('conversations.create');
    expect(calls[0]!.body).toEqual({ name: 'Ops Room', is_private: true });
  });

  it('resolves the unsuffixed instance to the default bot token', async () => {
    const { calls, api } = recorder({ 'conversations.create': { ok: true, channel: { id: 'C101', name: 'x' } } });

    await createConversation('slack', { name: 'x' }, api);

    expect(calls[0]!.token).toBe('xoxb-default');
  });

  it('returns the name Slack assigned, not the name that was asked for', async () => {
    // Slack normalizes room names (lowercase, dashes, length cap); persisting
    // the requested spelling would make the stored room name unfindable.
    const { api } = recorder({ 'conversations.create': { ok: true, channel: { id: 'C102', name: 'ops-room-2' } } });

    expect((await createConversation('slack-alpha', { name: 'Ops Room' }, api)).name).toBe('ops-room-2');
  });

  it('honours an explicit public request', async () => {
    const { calls, api } = recorder({ 'conversations.create': { ok: true, channel: { id: 'C103', name: 'x' } } });

    await createConversation('slack-alpha', { name: 'x', isPrivate: false }, api);

    expect(calls[0]!.body.is_private).toBe(false);
  });

  it('refuses an instance with no configured bot token before any Slack call', async () => {
    const { calls, api } = recorder({ 'conversations.create': { ok: true, channel: { id: 'C1', name: 'x' } } });

    await expect(createConversation('slack-missing', { name: 'x' }, api)).rejects.toBeInstanceOf(
      UnknownSlackInstanceError,
    );
    expect(calls).toEqual([]);
  });

  it('fails loudly when Slack returns no channel id', async () => {
    const { api } = recorder({ 'conversations.create': { ok: true } });

    await expect(createConversation('slack-alpha', { name: 'x' }, api)).rejects.toThrow(/no channel id/);
  });
});

describe('inviteUsers', () => {
  it('invites the whole list in one call on the named instance token', async () => {
    const { calls, api } = recorder({ 'conversations.invite': { ok: true } });

    await inviteUsers('slack-alpha', 'C100', ['U1', 'U2', 'U3'], api);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.token).toBe('xoxb-alpha');
    expect(calls[0]!.method).toBe('conversations.invite');
    expect(calls[0]!.body).toEqual({ channel: 'C100', users: 'U1,U2,U3' });
  });

  it('is a no-op for an empty invitee list', async () => {
    const { calls, api } = recorder({});

    await inviteUsers('slack-alpha', 'C100', [], api);

    expect(calls).toEqual([]);
  });

  it('swallows already_in_channel so a re-run of a half-applied room action is idempotent', async () => {
    const api = async (_t: string, method: string, _b: Record<string, unknown>, step: string) => {
      throw new SlackApiError(step, `slack ${method} failed: already_in_channel`);
    };

    await expect(inviteUsers('slack-alpha', 'C100', ['U1'], api)).resolves.toBeUndefined();
  });

  it('propagates any other Slack error', async () => {
    const api = async (_t: string, method: string, _b: Record<string, unknown>, step: string) => {
      throw new SlackApiError(step, `slack ${method} failed: not_in_channel`);
    };

    await expect(inviteUsers('slack-alpha', 'C100', ['U1'], api)).rejects.toThrow(/not_in_channel/);
  });

  it('never puts a token in the error a caller may surface', async () => {
    const api = async (_t: string, method: string, _b: Record<string, unknown>, step: string) => {
      throw new SlackApiError(step, `slack ${method} failed: channel_not_found`);
    };

    const err = await inviteUsers('slack-alpha', 'C100', ['U1'], api).catch((e: unknown) => e);
    expect(String(err)).toContain('channel_not_found');
    expect(String(err)).not.toContain('xoxb-');
  });
});
