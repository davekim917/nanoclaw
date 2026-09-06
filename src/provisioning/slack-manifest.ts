// Manifest constants, types, and builder copied byte-for-byte from
// upstream/channels src/provisioning/slack-app.ts at 6d5c1d089.
// This module performs no provisioning requests or credential reads.
export const BOT_SCOPES = [
  // Required by the app_mention event subscription; the Slack UI adds it
  // implicitly, so the manual walkthrough never lists it.
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'groups:read',
  'users:read',
  // users:read.email is deliberately ABSENT: it is outside the approved
  // scope set for provisioned apps. Scope additions must be approved for
  // that set BEFORE landing in any transport, or the manual-install
  // fallback breaks on the unapproved scope.
  'reactions:write',
  'mpim:write',
  'mpim:history',
  'mpim:read',
  'im:write',
  // Room-canvas surface: create/edit conversation canvases; files:read is
  // the read-back path (canvases are files, HTML download carries section ids).
  'canvases:read',
  'canvases:write',
  'files:read',
  // send_file: agents deliver files they produce (charts, documents,
  // generated artifacts) via files upload — live-verified missing_scope
  // failure without it (filesUploadV2 needs files:write).
  'files:write',
];

// member_joined/left_channel ride on the channels/groups/mpim:read scopes
// already present above (join-time adopt flow + membership bookkeeping).
export const BOT_EVENTS = [
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'app_mention',
  'member_joined_channel',
  'member_left_channel',
];

/**
 * Agent-mode (features.agent_view) additions — the default variant. Slack
 * auto-adds assistant:write when agent_view is enabled; declared explicitly
 * so the manifest states what the app holds. Guests are hard-blocked from
 * agent-enabled apps, so agentView:false selects the plain variant instead.
 */
export const AGENT_BOT_SCOPES = ['assistant:write'];

export const AGENT_BOT_EVENTS = ['app_home_opened', 'app_context_changed'];

/**
 * Fixed attribution: admins see this line, never a caller-supplied text.
 * Also the agent_view.agent_description (≤300 chars) on the agent-mode variant.
 */
export const MANAGED_APP_DESCRIPTION =
  'Personal AI agent, provisioned and managed by the NanoClaw app. Learn more at nanoclaw.dev/slack.';

/**
 * Optional request-origin metadata fields, all additive. On the broker
 * transport they ride the POST /v1/apps HTTP body verbatim (sent only when
 * defined — JSON serialization drops undefined values); a service that does
 * not know them ignores them. They NEVER influence the Slack app manifest,
 * scopes, or events, and the direct-Slack transport has nowhere to record
 * them, so it ignores them entirely. Field names are the wire contract —
 * snake_case, shared across every transport that provisions managed apps.
 */
export interface ProvisionAttribution {
  /** Slack user id of the human who asked for this app, when known. */
  requested_by?: string;
  /** The creating agent's own Slack app id, when an agent created this agent. */
  parent_app_id?: string;
  /** Template name, when the app was stamped from one. */
  template?: string;
  /** The installing host's package.json version. */
  client_version?: string;
}

export interface ManagedAppSpec extends ProvisionAttribution {
  name: string;
  description?: string;
  /**
   * agent_view is a one-way door decided at provision time (default true):
   * installs never fail on free plans (chrome degrades to a plain DM), but
   * agent apps are unusable by workspace guests — pass false for workspaces
   * that need guest access.
   */
  agentView?: boolean;
}

export function buildManagedAppManifest(spec: ManagedAppSpec): object {
  const agentView = spec.agentView ?? true;
  return {
    display_information: {
      name: spec.name,
      description: MANAGED_APP_DESCRIPTION,
    },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: spec.name,
        always_online: true,
      },
      ...(agentView ? { agent_view: { agent_description: MANAGED_APP_DESCRIPTION } } : {}),
    },
    oauth_config: {
      // Copies, not the module constants — callers extend these per app.
      scopes: { bot: agentView ? [...BOT_SCOPES, ...AGENT_BOT_SCOPES] : [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { bot_events: agentView ? [...BOT_EVENTS, ...AGENT_BOT_EVENTS] : [...BOT_EVENTS] },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
