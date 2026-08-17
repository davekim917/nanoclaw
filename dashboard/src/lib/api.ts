export interface AuthMe {
  user_id: string;
  scopes: { role: string; allowed_group_ids: string[]; no_filter: boolean };
}

export type AttentionState = 'needs_me' | 'active' | 'idle' | 'stale';

export interface SessionSummary {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  // Existing
  container_status: 'idle' | 'running' | 'stale' | 'unknown';
  // Enriched by the C3 sessions handler — fields are absent on older
  // backends, hence `?`. The inbox view defaults missing fields to null.
  title?: string | null;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
  last_outbound_kind?: string | null;
  archived_at?: string | null;
  has_pending_recurrence?: boolean;
  attached_task_id?: string | null;
  attached_task_status?: string | null;
  attached_task_needs_input?: boolean | null;
  attention_state?: AttentionState;
  /**
   * Legacy alias — pre-C3 SessionList consumers read this directly. The
   * enriched response still ships it (= last_inbound_at) for back-compat;
   * new code should prefer `last_inbound_at`.
   */
  last_active: string | null;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
}

export interface SessionTranscriptEntry {
  direction: 'in' | 'out';
  kind: string;
  seq: number;
  timestamp: string;
  text: string;
}

export interface SessionDetailResponse {
  session: SessionSummary;
  transcript: SessionTranscriptEntry[];
}

export interface SteerResponse {
  task_id: string;
  message_id: string;
  echo_status: string;
}

export interface ApiError {
  status: number;
  error: string;
  retry_after?: number;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; retry_after?: number };
    const apiErr: ApiError = {
      status: res.status,
      error: body.error ?? 'unknown',
      ...(body.retry_after != null ? { retry_after: body.retry_after } : {}),
    };
    throw apiErr;
  }
  return res.json() as Promise<T>;
}

export async function authMe(): Promise<AuthMe> {
  return apiFetch<AuthMe>('/dashboard/api/auth/me');
}

// Post-build QA fix SF-3: exchange returns {user_id, expires_at} only — no scopes.
// AuthGate refetches authMe() after the cookie lands, so this return value is
// consumed only for type-completeness; tighter type prevents future code from
// mistakenly reading .scopes off the exchange result.
export interface ExchangeResponse {
  user_id: string;
  expires_at: string;
}

export async function exchangeToken(token: string): Promise<ExchangeResponse> {
  return apiFetch<ExchangeResponse>('/dashboard/api/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export interface GroupSummary {
  id: string;
  name: string;
}

export interface GroupListResponse {
  groups: GroupSummary[];
}

export async function listGroups(): Promise<GroupListResponse> {
  return apiFetch<GroupListResponse>('/dashboard/api/groups');
}

export interface MessagingGroupSummary {
  id: string;
  name: string;
}

export interface MessagingGroupListResponse {
  messaging_groups: MessagingGroupSummary[];
}

export async function listMessagingGroups(): Promise<MessagingGroupListResponse> {
  return apiFetch<MessagingGroupListResponse>('/dashboard/api/messaging-groups');
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  return apiFetch<SessionDetailResponse>(`/dashboard/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listSessions(filter?: {
  group_id?: string;
  include_archived?: boolean;
  limit?: number;
}): Promise<SessionsResponse> {
  const params = new URLSearchParams();
  if (filter?.group_id) params.append('group_id', filter.group_id);
  if (filter?.include_archived) params.append('include_archived', '1');
  if (filter?.limit) params.append('limit', String(filter.limit));
  const qs = params.toString();
  return apiFetch<SessionsResponse>(`/dashboard/api/sessions${qs ? `?${qs}` : ''}`);
}

export async function postSessionMessage(
  sessionId: string,
  body: { idempotency_key: string; text: string }
): Promise<SteerResponse> {
  return apiFetch<SteerResponse>(
    `/dashboard/api/sessions/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

export async function archiveSession(sessionId: string): Promise<{ session_id: string; archived_at: string }> {
  return apiFetch<{ session_id: string; archived_at: string }>(
    `/dashboard/api/sessions/${encodeURIComponent(sessionId)}/archive`,
    { method: 'POST' }
  );
}

export async function unarchiveSession(sessionId: string): Promise<{ session_id: string }> {
  return apiFetch<{ session_id: string }>(
    `/dashboard/api/sessions/${encodeURIComponent(sessionId)}/unarchive`,
    { method: 'POST' }
  );
}

// ─── Scheduled-tasks board (Group E) ────────────────────────────────────────
//
// Types mirror the host-side frozen contract: the verb×state matrix
// (src/dashboard/api/scheduled-board-matrix.ts), the assembly ScheduledRow /
// ScheduledSnapshot shapes (src/dashboard/api/scheduled-assembly.ts), and the
// 9 routes under /dashboard/api/scheduled (design §3b). The SPA never
// re-derives health or verb availability — `health` and `available_verbs`
// arrive computed from the API and are the single source of truth.

/** Health states — derived server-side per design §4.1; never read from `status`. */
export type HealthState =
  | 'healthy'
  | 'late'
  | 'stalled'
  | 'paused'
  | 'processing'
  | 'unknown'
  | 'strand';

/** Series kind — a column-mask AND'd with the health-state cell (matrix §4.0). */
export type SeriesKind = 'recurring' | 'one_off' | 'thread_loop';

/** Operator verbs — the matrix output. Buttons are enabled iff the verb is in `available_verbs`. */
export type ScheduledVerb = 'edit' | 'pause' | 'resume' | 'run_now' | 'cancel' | 'move';

/** Per-fire history outcome labels (design §4.1; the D16 F-amendment merge). */
export type FireOutcomeLabel =
  | 'ran'
  | 'completed (no chat output)'
  | 'failed'
  | 'missed'
  | 'cancelled';

export interface FireOutcome {
  /** Live row id / fire id for this entry. */
  id?: string;
  /** ISO timestamp of the fire (due/process_after for the entry). */
  ts?: string | null;
  outcome: FireOutcomeLabel;
}

export interface ScheduledRow {
  /** base64url(agentGroupId/sessionId/seriesId) — a LOCATOR, never an authz input (§4.5). */
  key: string;
  series_id: string;
  agent_group_id: string;
  agent_group_name: string;
  provider: string | null;
  channel_name: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: SeriesKind;
  cron: string | null;
  /** Next fire rendered in UTC and in service-local time — both shown (C6). */
  next_fire_utc: string | null;
  next_fire_local: string | null;
  /** Server-derived health — the load-bearing field. Never recompute client-side. */
  health: HealthState;
  /** Non-null on module-owned series (memory/mnemon/support, C5) → owner badge + reseed warning. */
  module_owner: string | null;
  quiet_status: boolean;
  /** Per-fire flagIntent override (model/effort) — brief-required metadata; opaque to the SPA. */
  flag_intent: Record<string, unknown> | null;
  /** Host-side pre-task script execution flag — drives the "host-gated" badge. */
  script_host: boolean;
  last_fires: FireOutcome[];
  /** The matrix output. Verb buttons render solely from this (single source of truth, E4). */
  available_verbs: ScheduledVerb[];
}

/** counts keyed by health state plus the two observability/kind extras. */
export type ScheduledCounts = Partial<Record<HealthState | 'unreadable' | 'one_off', number>>;

export interface ScheduledSnapshot {
  rows: ScheduledRow[];
  degraded: boolean;
  counts: ScheduledCounts;
  assembled_at: string;
}

export interface ScheduledAuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  correlation_id?: string | null;
  [extra: string]: unknown;
}

export interface ScheduledDetail {
  row: ScheduledRow;
  prompt: string;
  script: string | null;
  history: FireOutcome[];
  /** Present ONLY for mutation-tier callers (owner/global-admin); absent for read-only (M5). */
  audit_tail?: ScheduledAuditRow[];
}

export interface MovePreviewResult {
  wiringOk: boolean;
  /** Secret NAMES the series gains at the target — never values (D8). */
  gains: string[];
  /** Secret NAMES the series loses at the target — never values (D8). */
  losses: string[];
  crossWorkgroup: boolean;
  scriptPresent: boolean;
  /** Always false in v1 — only the secret delta is checked; wider env is not (W2). */
  environmentDeltaChecked: false;
  /** Echoed back to /move as confirmedDeltaHash to close the preview→execute TOCTOU (SEC-2). */
  deltaHash: string;
}

export async function listScheduled(params?: { group_id?: string }): Promise<ScheduledSnapshot> {
  const qs = new URLSearchParams();
  if (params?.group_id) qs.set('group_id', params.group_id);
  const query = qs.toString();
  return apiFetch<ScheduledSnapshot>(`/dashboard/api/scheduled${query ? `?${query}` : ''}`);
}

/**
 * Prompt/title search: returns the scope-filtered row keys whose name/group/
 * channel/cron OR prompt/script match `q`. Server-side because prompt/script are
 * deliberately absent from the lean list snapshot. Returns only KEYS (no prompt
 * text on the wire); the board unions these with its instant on-row haystack.
 */
export async function searchScheduled(q: string, params?: { group_id?: string }): Promise<{ keys: string[] }> {
  const qs = new URLSearchParams();
  qs.set('q', q);
  if (params?.group_id) qs.set('group_id', params.group_id);
  return apiFetch<{ keys: string[] }>(`/dashboard/api/scheduled/search?${qs.toString()}`);
}

export async function getScheduledDetail(key: string): Promise<ScheduledDetail> {
  return apiFetch<ScheduledDetail>(`/dashboard/api/scheduled/${encodeURIComponent(key)}`);
}

export async function editScheduled(
  key: string,
  body: { prompt?: string; script?: string; cron?: string },
): Promise<{ updated: true }> {
  return apiFetch<{ updated: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function pauseScheduled(key: string): Promise<{ paused?: true }> {
  return apiFetch<{ paused?: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}/pause`, {
    method: 'POST',
  });
}

export async function resumeScheduled(key: string): Promise<{ resumed?: true }> {
  return apiFetch<{ resumed?: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}/resume`, {
    method: 'POST',
  });
}

export async function runNowScheduled(
  key: string,
  opts?: { force?: boolean },
): Promise<{ fired: true }> {
  return apiFetch<{ fired: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}/run-now`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Only send a body when forcing; an absent body keeps force=false at the host.
    ...(opts?.force ? { body: JSON.stringify({ force: true }) } : {}),
  });
}

export async function cancelScheduled(key: string): Promise<{ cancelled: true }> {
  return apiFetch<{ cancelled: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}/cancel`, {
    method: 'POST',
  });
}

export async function moveScheduledPreview(
  key: string,
  body: { targetAgentGroupId: string; targetMessagingGroupId: string },
): Promise<MovePreviewResult> {
  return apiFetch<MovePreviewResult>(
    `/dashboard/api/scheduled/${encodeURIComponent(key)}/move/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export async function moveScheduled(
  key: string,
  body: { targetAgentGroupId: string; targetMessagingGroupId: string; confirmedDeltaHash: string },
): Promise<{ moved: true }> {
  return apiFetch<{ moved: true }>(`/dashboard/api/scheduled/${encodeURIComponent(key)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Workgroup dashboard (fleet-hardening Phase 3) ──────────────────────────
//
// Read-only. Types mirror the host-side contract in
// src/dashboard/api/workgroups.ts.

export interface WorkgroupSummary {
  id: string;
  name: string;
}

export interface WorkgroupsResponse {
  workgroups: WorkgroupSummary[];
}

export async function listWorkgroups(): Promise<WorkgroupsResponse> {
  return apiFetch<WorkgroupsResponse>('/dashboard/api/workgroups');
}

export interface WorkgroupBoardSummary {
  /** Raw markdown of `releases/board.md`, or null if the workgroup has no release board. */
  board: string | null;
  /** Tail of the newest `releases/gates/*.jsonl` file — opaque gate log entries. */
  gates: Record<string, unknown>[];
}

export async function getWorkgroupSummary(id: string): Promise<WorkgroupBoardSummary> {
  return apiFetch<WorkgroupBoardSummary>(`/dashboard/api/workgroup/${encodeURIComponent(id)}/summary`);
}

/** Mirrors central-DB `usage_daily` — src/db/usage.ts `UsageDailyRow`. */
export interface WorkgroupUsageRow {
  date: string;
  agent_group_id: string;
  provider: string;
  model: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface WorkgroupUsageResponse {
  usage: WorkgroupUsageRow[];
}

export async function getWorkgroupUsage(id: string, days?: number): Promise<WorkgroupUsageResponse> {
  const qs = new URLSearchParams();
  if (days != null) qs.set('days', String(days));
  const query = qs.toString();
  return apiFetch<WorkgroupUsageResponse>(
    `/dashboard/api/workgroup/${encodeURIComponent(id)}/usage${query ? `?${query}` : ''}`,
  );
}

export interface WorkgroupClaim {
  slug: string;
  owner: string | null;
  claimed_at: string | null;
  ttl_hours: number | null;
  note: string | null;
  escalated_at: string | null;
  stale: boolean;
  escalated: boolean;
}

/** Read-only projection of a live task series — see ScheduledRow for the full shape. */
export interface WorkgroupSeriesRow {
  series_id: string;
  agent_group_id: string;
  agent_group_name: string;
  cron: string | null;
  health: HealthState;
  next_fire_utc: string | null;
  next_fire_local: string | null;
  last_fires: FireOutcome[];
  script_host: boolean;
}

export interface WorkgroupClaimsResponse {
  claims: WorkgroupClaim[];
  series: WorkgroupSeriesRow[];
}

export async function getWorkgroupClaims(id: string): Promise<WorkgroupClaimsResponse> {
  return apiFetch<WorkgroupClaimsResponse>(`/dashboard/api/workgroup/${encodeURIComponent(id)}/claims`);
}

// ─── Observatory (agents' office ambient status view) ───────────────────────
//
// Read-only. Polled every 15s by the view itself (no SSE).

export interface ObservatoryRoom {
  key: string;
  name: string;
  platform: string;
  memberAgentIds: string[];
  lastActivityAt: string | null;
  permalink: string | null;
}

export interface ObservatoryAgent {
  id: string;
  /** Channel-facing persona name — what renders on the chip. */
  name: string;
  /** Infra name (agent_groups.name) — secondary detail only. */
  canonicalName: string;
  folder: string;
  provider: string;
  awake: boolean;
  /** Doing something in `location` right now (awake AND that room spoke inside
   *  the server's tight working window). `awake` alone is container liveness
   *  anywhere, which is why it must never drive the pulse. */
  active: boolean;
  location: string | null;
  lastSeenAt: string | null;
  /** Session this agent last spoke in — where a steer should land. Null if none. */
  lastSessionId: string | null;
  holding: string[];
  nextTask: { title: string; at: string } | null;
  /** Bot's real Slack avatar (public slack-edge CDN URL), null when none. */
  avatarUrl: string | null;
  /**
   * The agent's most-recent session that carries a room — same source as
   * `location`, but carrying a session id and thread link. Null when the
   * agent has no room-scoped session inside the location window. A caller
   * asking about a specific room must compare `channelKey` against it —
   * this is not a per-room map, just "where do I currently point".
   */
  liveSession: { channelKey: string; sessionId: string; threadUrl: string | null; lastOutboundAt: string | null } | null;
}

export type ObservatoryClaimState = 'live' | 'expiring' | 'stale' | 'parked';

export interface ObservatoryClaim {
  slug: string;
  owner: string | null;
  note: string | null;
  state: ObservatoryClaimState;
  staleMs: number;
  threadId: string | null;
  /** Permalink to the thread the work was claimed in — null when unresolvable. */
  threadUrl: string | null;
  escalated: boolean;
}

/** Who moves an open release-blocking item forward next. */
export type ReleaseNextMover = 'human' | 'agent' | 'nobody';

export interface ReleaseHold {
  kind: string;
  reason?: string;
  since?: string;
}

export interface ReleaseItem {
  /** e.g. "XZO#860" */
  id: string;
  /** pr | finding | decision | claim | ops | anything else the watcher emits */
  kind: string;
  title: string;
  nextMover: ReleaseNextMover;
  owner?: string;
  blocksRelease?: boolean;
  why?: string;
  since?: string;
  url?: string;
  /**
   * Ids of items on this board that must land before this one can. OMITTING
   * this field means "nobody checked"; an explicit `[]` means "checked, nothing
   * blocks it". The dependency view relies on that distinction — undeclared and
   * independent must never render alike. See views/release-graph.ts.
   */
  dependsOn?: string[];
  /**
   * When this item's CURRENT owner has promised the next transition by. An
   * owned item with no `dueAt` is a promise with no clock, which is
   * indistinguishable from no promise — the ledger reports those as a coverage
   * gap rather than treating them as on track. See views/commitments.ts.
   */
  dueAt?: string;
  /** What the mover has promised to do next, one line. Shown on the row. */
  nextAction?: string;
  /** Slack channel the work lives in, e.g. '#qa-room'. Routes assignment. */
  channel?: string;
}

export interface ReleaseState {
  /** When the release watcher generated this snapshot. */
  asOf: string;
  generatedBy?: string;
  release?: { moratorium?: boolean; holds?: ReleaseHold[] };
  items: ReleaseItem[];
}

export interface ObservatorySnapshot {
  workgroupId: string;
  asOf: string;
  rooms: ObservatoryRoom[];
  agents: ObservatoryAgent[];
  claims: ObservatoryClaim[];
  /** Null until the release watcher has published release-state.json. */
  releaseState: ReleaseState | null;
  /** Themed-floor slot bindings (normalized channel name → office-map.js
   *  slot) — install config, absent when the operator hasn't set any. See
   *  office-data.ts's buildOfficeData. */
  themedSlots?: Record<string, string>;
}

/** Assign a board item to an agent: creates a one-shot task in the item's own
 *  channel. The server composes the prompt from the board — this sends ids only. */
export async function assignItem(
  workgroupId: string,
  itemId: string,
  agentGroupId: string,
): Promise<{ ok: boolean; seriesId: string | null; channel: string; agent: string }> {
  return apiFetch('/dashboard/api/observatory/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workgroupId, itemId, agentGroupId }),
  });
}

/** Push a stalled claim forward: creates a one-shot task in the claim's OWN
 *  thread. The server composes the prompt from the claim file — ids only. */
export async function nudgeClaim(
  workgroupId: string,
  claimSlug: string,
  agentGroupId: string,
): Promise<{ ok: boolean; seriesId: string | null; threadUrl: string | null }> {
  return apiFetch('/dashboard/api/observatory/nudge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workgroupId, claimSlug, agentGroupId }),
  });
}

/**
 * Say something, in the operator's own words, into the thread a piece of work
 * lives in. Nudge's inverse: nudge sends ids only and the server writes the
 * ask, steer carries TEXT the person typed. Everything else is nudge's shape —
 * one-shot task, the work's own thread, the same role gate.
 *
 * `channel` is only read when a claim has no thread yet, and only then does the
 * server open one; without it that case is refused rather than guessed at.
 */
export async function steerWork(
  workgroupId: string,
  target: { claimSlug: string } | { itemId: string },
  agentGroupId: string,
  text: string,
  channel?: string,
): Promise<{ ok: boolean; seriesId: string | null; threadUrl: string | null; threadCreated?: boolean }> {
  return apiFetch('/dashboard/api/observatory/steer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workgroupId, agentGroupId, text, ...target, ...(channel ? { channel } : {}) }),
  });
}

export async function getObservatory(workgroupId: string): Promise<ObservatorySnapshot> {
  return apiFetch<ObservatorySnapshot>(
    `/dashboard/api/observatory?workgroup=${encodeURIComponent(workgroupId)}`,
  );
}
