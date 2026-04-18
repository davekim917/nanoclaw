/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports multiple concurrent Slack workspaces via env-var suffixes:
 *
 *   SLACK_BOT_TOKEN=xoxb-…                         → channelType "slack"
 *   SLACK_SIGNING_SECRET=…
 *   SLACK_BOT_TOKEN_<SUFFIX>=xoxb-…                → channelType "slack-<suffix>"
 *   SLACK_SIGNING_SECRET_<SUFFIX>=…
 *
 * Each workspace is a separate Slack app (created per-workspace at
 * api.slack.com/apps, "Not distributed"). Suffix is any [A-Za-z0-9]+ and
 * is lowercased for the channelType.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFileMatching } from '../env.js';
import { log } from '../log.js';
import { parseTextStyles } from '../text-styles.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

export interface SlackWorkspace {
  channelType: string;
  botToken: string;
  signingSecret: string;
}

/**
 * Pure helper — parse workspace configs from an env key/value map.
 * Exported for testing.
 */
export function parseSlackWorkspaces(env: Record<string, string>): SlackWorkspace[] {
  const bySuffix = new Map<string, { botToken?: string; signingSecret?: string }>();

  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(?:_([A-Za-z0-9]+))?$/);
    if (!m) continue;
    const [, kind, rawSuffix] = m;
    const suffix = rawSuffix ? rawSuffix.toLowerCase() : '';
    const entry = bySuffix.get(suffix) ?? {};
    if (kind === 'BOT_TOKEN') entry.botToken = value;
    else entry.signingSecret = value;
    bySuffix.set(suffix, entry);
  }

  const workspaces: SlackWorkspace[] = [];
  for (const [suffix, pair] of bySuffix) {
    if (!pair.botToken) continue;
    if (!pair.signingSecret) {
      log.warn('Slack workspace missing signing secret, skipping', {
        suffix: suffix || '(primary)',
      });
      continue;
    }
    workspaces.push({
      channelType: suffix ? `slack-${suffix}` : 'slack',
      botToken: pair.botToken,
      signingSecret: pair.signingSecret,
    });
  }
  return workspaces;
}

const workspaces = parseSlackWorkspaces(readEnvFileMatching(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(_[A-Za-z0-9]+)?$/));

for (const ws of workspaces) {
  registerChannelAdapter(ws.channelType, {
    factory: () => {
      const slackAdapter = createSlackAdapter({
        botToken: ws.botToken,
        signingSecret: ws.signingSecret,
      });
      return createChatSdkBridge({
        adapter: slackAdapter,
        concurrency: 'concurrent',
        supportsThreads: true,
        channelType: ws.channelType,
        // Convert Markdown (**bold**, [text](url), ## heading) to Slack's
        // mrkdwn syntax (*bold*, <url|text>, *heading*) before delivery.
        // Without this, Claude's Markdown renders literally in Slack
        // (asterisks shown, headings ignored, links broken).
        transformOutboundText: (t) => parseTextStyles(t, 'slack'),
      });
    },
  });
}

if (workspaces.length > 1) {
  log.info('Multiple Slack workspaces registered', {
    channelTypes: workspaces.map((w) => w.channelType),
  });
}
