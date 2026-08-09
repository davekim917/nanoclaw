// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  /** @deprecated Use container_configs.provider instead. */
  agent_provider: string | null;
  created_at: string;
  /** Workgroup this group belongs to (migration 036). Standalone groups have
   *  workgroup_id === folder. Selected via `SELECT *`; may be absent on rows
   *  written before the migration. */
  workgroup_id?: string | null;
}

/** Per-agent-group container runtime config. Source of truth in the DB;
 *  materialized to `groups/<folder>/container.json` at spawn time. */
export interface ContainerConfigRow {
  agent_group_id: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  image_tag: string | null;
  assistant_name: string | null;
  max_messages_per_prompt: number | null;
  skills: string; // JSON: '"all"' | '["skill1","skill2"]'
  mcp_servers: string; // JSON: Record<string, McpServerConfig>
  packages_apt: string; // JSON: string[]
  packages_npm: string; // JSON: string[]
  additional_mounts: string; // JSON: AdditionalMountConfig[]
  cli_scope: string; // 'disabled' | 'group' | 'global'
  updated_at: string;
}

export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  /**
   * Adapter-instance name. Defaults to channel_type (the "default instance").
   * Column is NOT NULL (migration 016 backfills instance = channel_type);
   * optional on the TS type per the denied_at convention so fixtures that
   * build MessagingGroup objects don't need updating — createMessagingGroup
   * stamps the default.
   */
  instance?: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   *
   * Optional on the TS type so pre-migration-012 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to NULL in SQLite.
   */
  denied_at?: string | null;
  created_at: string;
}

// ── Identity & privilege ──

/**
 * User = a messaging-platform identifier. Namespaced so distinct channels
 * with numeric IDs don't collide: "phone:+1555...", "tg:123", "discord:456",
 * "email:person9@fixture16.example.com". A single human with a phone AND a telegram handle has
 * two separate users — no cross-channel linking (yet).
 */
export interface User {
  id: string;
  kind: string; // 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

/**
 * Role grant. Owner is always global. Admin is either global
 * (agent_group_id = null) or scoped to a specific agent group.
 * Admin @ A implicitly makes the user a member of A — we do not require
 * a separate agent_group_members row for admins.
 */
export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** "Known" membership in an agent group — required for unprivileged users. */
export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

/** Cached DM channel for a user on a specific channel_type. */
export interface UserDm {
  user_id: string;
  channel_type: string;
  messaging_group_id: string;
  resolved_at: string;
}

export type EngageMode = 'pattern' | 'mention' | 'mention-pattern' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

// Session-mode enum shared across router.ts, session-manager.ts, channel-auto-wire,
// agent-route.ts, and types.ts. The local type that used to live in
// channel-auto-wire/index.ts is re-exported from here so there's one source of truth.
export type SessionMode = 'shared' | 'per-thread' | 'agent-shared';
export const SESSION_MODES: readonly SessionMode[] = ['shared', 'per-thread', 'agent-shared'] as const;

// Provider enum. Values are the agent-runner runtime identifier used by
// registerProviderContainerConfig and the container_configs.provider column.
// 'mock' is the in-container test provider (container/agent-runner/src/providers/mock.ts).
export type Provider = 'claude' | 'codex' | 'opencode' | 'mock';
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode', 'mock'] as const;

// Channel-type enum. Covers external adapters (slack, discord, telegram, ...),
// hybrid variants (whatsapp-cloud), and the internal synthetic channels
// ('agent' for agent-to-agent, 'cli' for ncl). Setup migrations may use the
// older alias 'gchat'; normalize via the channel-registry when reading.
export type ChannelType =
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'whatsapp'
  | 'whatsapp-cloud'
  | 'teams'
  | 'linear'
  | 'github'
  | 'imessage'
  | 'webex'
  | 'matrix'
  | 'google-chat'
  | 'resend'
  | 'signal'
  | 'agent'
  | 'cli';
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp-cloud',
  'teams',
  'linear',
  'github',
  'imessage',
  'webex',
  'matrix',
  'google-chat',
  'resend',
  'signal',
  'agent',
  'cli',
] as const;

/**
 * Match a channel_type against a base adapter name. Channel variants are
 * encoded as `<base>-<variant>` (e.g. `slack-thread`, `discord-guild`); this
 * helper returns true for any string that starts with `<base>-`. To check
 * `channelType === 'slack'` specifically (bare base, no variant), use plain
 * equality — bare-base matches must stay separate from variant-prefix matches
 * because some call sites (e.g. router.ts workspace-trust auto-wire) treat
 * bare base as ambiguous and intentionally exclude it.
 *
 * Note: passing `whatsapp` here will also match `whatsapp-cloud`. That's a
 * false positive for that pair (they're distinct channels, not a base/variant
 * relationship). Callers should compare against the specific channel name,
 * not pass 'whatsapp' as a base for that reason.
 */
export function isChannelVariant(channelType: string, base: ChannelType): boolean {
  return channelType.startsWith(`${base}-`);
}

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  /**
   * Regex source string used when engage_mode='pattern'. `'.'` is the sentinel
   * for "match every message" (the "always" flavor). Ignored for 'mention' /
   * 'mention-sticky' modes.
   */
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: SessionMode;
  priority: number;
  /**
   * Per-channel model override (this channel's conversations with this
   * agent use this model by default). Null = fall through to the agent's
   * container.json defaultModel, then the install-wide DEFAULT_OPUS_MODEL
   * constant in container-runner.ts.
   */
  default_model: string | null;
  /**
   * Per-channel effort override. Provider-specific: Claude/OpenCode use their
   * supported levels; Codex additionally supports 'xhigh' | 'max' | 'ultra'.
   * Null = fall through to the agent container config / provider default.
   */
  default_effort: string | null;
  /**
   * Per-channel default tone profile name (matches a file under
   * `tone-profiles/<name>.md`). When set, the host injects the full profile
   * into the container's system prompt on spawn — always-on, not gated by an
   * MCP call. Null = no tone injected; agent falls back to the
   * get_tone_profile MCP tool for on-demand overrides.
   */
  default_tone: string | null;
  /**
   * Per-wiring thread-policy override (migration 019). NULL = inherit the
   * channel adapter's declared default for the wiring's context (DM vs
   * group); 1/0 = explicit override, hard-ANDed with the adapter's raw
   * capability at router fanout (resolveThreadPolicy). Optional on the TS
   * type per the denied_at convention so pre-migration fixtures don't need
   * updating.
   */
  threads?: number | null;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  last_outbound_at?: string | null;
  last_outbound_kind?: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  question: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  created_at: string;
}

// ── Pending approvals (central DB) ──

export interface PendingApproval {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string; // JSON
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  platform_message_id: string | null;
  /**
   * For OneCLI credential rows, the gateway's request TTL. For a module
   * approval held by "Reject with reason…", the deadline after which the
   * host sweep finalizes a plain reject (set by markApprovalAwaitingReason).
   */
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'awaiting_reason';
  title: string;
  question: string;
  options_json: string;
  /** When set, only this exact user may resolve the approval. */
  approver_user_id: string | null;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}

export interface AgentMessagePolicy {
  from_agent_group_id: string;
  to_agent_group_id: string;
  approver: string;
  created_at: string;
}
