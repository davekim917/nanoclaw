/**
 * Shared Slack channel-layer library: a minimal fetch-based Web API client plus the bot-token .env key convention, so
 * Slack HTTP plumbing has one home. Failures become SlackApiError(step, …) where `step` is the caller's context tag.
 * Tokens travel only in the Authorization header and must never appear in messages or logs.
 */

/** The Web API base, ending in `/`. `SLACK_API_URL` is the override the Slack adapter itself reads. */
export function slackApiUrl(): string {
  const configured = process.env.SLACK_API_URL?.trim();
  if (!configured) return 'https://slack.com/api/';
  return configured.endsWith('/') ? configured : `${configured}/`;
}

/** `message` MUST never contain a token value. */
export class SlackApiError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/**
 * Returns the parsed response when `ok: true`; throws SlackApiError otherwise (network, timeout, non-JSON, or a Slack
 * error string).
 */
export async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  step: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${slackApiUrl()}${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new SlackApiError(step, `slack ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SlackApiError(step, `slack ${method} failed: HTTP ${res.status}, non-JSON body`);
  }
  if (json.ok !== true) {
    throw new SlackApiError(step, `slack ${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

/** `url` is the workspace URL (`https://<domain>.slack.com/`). */
export async function slackAuthTest(
  token: string,
  step: string,
): Promise<{ userId: string; teamId?: string; team?: string; url?: string }> {
  const json = await slackCall(token, 'auth.test', {}, step);
  const userId = typeof json.user_id === 'string' ? json.user_id : null;
  if (!userId) throw new SlackApiError(step, 'slack auth.test failed: no user_id in response');
  return {
    userId,
    teamId: typeof json.team_id === 'string' ? json.team_id : undefined,
    team: typeof json.team === 'string' ? json.team : undefined,
    url: typeof json.url === 'string' ? json.url : undefined,
  };
}

/** One user id opens the 1:1 IM; two or more open an MPIM. Idempotent on Slack's side. */
export async function slackConversationsOpen(token: string, userIds: string[], step: string): Promise<string> {
  const json = await slackCall(token, 'conversations.open', { users: userIds.join(',') }, step);
  const channel = json.channel as Record<string, unknown> | undefined;
  const channelId = typeof channel?.id === 'string' ? channel.id : null;
  if (!channelId) throw new SlackApiError(step, 'slack conversations.open failed: no channel id in response');
  return channelId;
}

export async function slackPostMessage(
  token: string,
  channel: string,
  text: string,
  step = 'post-message',
): Promise<void> {
  await slackCall(token, 'chat.postMessage', { channel, text }, step);
}

export async function slackConversationsInfo(
  token: string,
  channelId: string,
  step: string,
): Promise<{ isMpim: boolean; name?: string; creator?: string }> {
  const json = await slackCall(token, 'conversations.info', { channel: channelId }, step);
  const channel = json.channel as Record<string, unknown> | undefined;
  return {
    isMpim: channel?.is_mpim === true,
    name: typeof channel?.name === 'string' ? channel.name : undefined,
    creator: typeof channel?.creator === 'string' ? channel.creator : undefined,
  };
}

/** Cursor-paginated with a page cap; membership comparisons only run over small rooms (MPIMs are ≤9 members). */
export async function slackConversationsMembers(token: string, channelId: string, step: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const json = await slackCall(
      token,
      'conversations.members',
      { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) },
      step,
    );
    for (const m of (json.members as unknown[] | undefined) ?? []) {
      if (typeof m === 'string') members.push(m);
    }
    const meta = json.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor || undefined;
    if (!cursor) break;
  }
  return members;
}

function envSuffix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * FORK DELTA: everything above is a byte-copy of upstream's `channels`-branch slack-lib.ts; everything below is the
 * fork's own. Upstream registers `slack-<slug>` as an instance of one `channel_type = 'slack'`; the fork derives a
 * distinct channel_type per suffixed token pair (instance always equals channel_type). These helpers are the only
 * sanctioned way to convert between slug (`research-2`), channel type (`slack-research-2`) and env suffix
 * (`RESEARCH_2`); slack-lib.test.ts pins the round trip against `parseSlackWorkspaces` itself.
 */

const DEFAULT_SLACK_CHANNEL_TYPE = 'slack';

/**
 * ONLY the empty slug is the default adapter. `'slack'` is a legal slug (an agent named "Slack") and maps to
 * `slack-slack` with its own `SLACK_BOT_TOKEN_SLACK`; treating it as the default would overwrite the install's
 * default Slack app credentials when provisioning that agent. The asymmetry with `slugForSlackChannelType` is
 * deliberate.
 */
export function slackChannelTypeForSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) return DEFAULT_SLACK_CHANNEL_TYPE;
  return `${DEFAULT_SLACK_CHANNEL_TYPE}-${trimmed}`;
}

/** Inverse of `slackChannelTypeForSlug`; the default adapter's slug is ''. */
export function slugForSlackChannelType(channelType: string): string {
  if (channelType === DEFAULT_SLACK_CHANNEL_TYPE) return '';
  return channelType.replace(/^slack-/, '');
}

/**
 * The .env bot-token key name for a channel type: `SLACK_BOT_TOKEN` for the default, else `SLACK_BOT_TOKEN_<SUFFIX>`
 * in the shape `parseSlackWorkspaces` reads back.
 */
export function botTokenKeyForChannelType(channelType: string): string {
  if (channelType === DEFAULT_SLACK_CHANNEL_TYPE) return 'SLACK_BOT_TOKEN';
  return `SLACK_BOT_TOKEN_${envSuffix(slugForSlackChannelType(channelType))}`;
}

/**
 * Socket Mode's second credential; `apps.manifest.create` returns it, so a provisioned bot lands as the same
 * BOT_TOKEN/APP_TOKEN pair a hand-made Socket Mode bot uses.
 */
export function appTokenKeyForChannelType(channelType: string): string {
  if (channelType === DEFAULT_SLACK_CHANNEL_TYPE) return 'SLACK_APP_TOKEN';
  return `SLACK_APP_TOKEN_${envSuffix(slugForSlackChannelType(channelType))}`;
}
