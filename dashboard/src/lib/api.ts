export interface AuthMe {
  user_id: string;
  scopes: { role: string; allowed_group_ids: string[]; no_filter: boolean };
}

export interface TaskSummary {
  task_id: string;
  parent_session_id: string;
  task_content: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  admitted_at: string;
  last_progress_message?: string;
  fail_reason?: string;
  /** 0/1 boolean — worker has stopped and is waiting for operator steer. */
  needs_input?: number;
  /** Optional one-line summary of what the worker is asking for. */
  steer_question?: string | null;
  /** ISO timestamp when an operator dismissed this task from the board; null = visible. */
  archived_at?: string | null;
}

// Matches backend src/dashboard/api/tasks.ts TranscriptEntry exactly.
// Post-build QA fix MF-4: previous shape was {seq, role, text, ts} which had
// no overlap with backend {id, seq, kind, timestamp, content, direction, source}
// — TaskDetail rendered empty rows for every transcript entry.
export interface TranscriptEntry {
  id: string;
  seq: number;
  kind: string;
  timestamp: string;          // ISO 8601 — host writes T+ms+Z; container writes 'YYYY-MM-DD HH:MM:SS'
  content: unknown;           // JSON-parsed; usually has a `text` field for human-readable rendering
  direction: 'inbound' | 'outbound';
  source: 'dashboard' | 'chat' | 'agent' | 'system';
}

export interface TaskDetail extends TaskSummary {
  started_at?: string;
  completed_at?: string;
  failed_at?: string;
  // Backend SELECT * on detail returns child_session_id; SPA uses it to filter
  // chokidar-emitted SSE inbound_message events (post-build QA fix SF-8).
  child_session_id?: string | null;
  // Set by the child via spawn_complete / spawn_failed. Empty for tasks the
  // watchdog reaped before the child got a chance to emit a terminal action.
  result_summary?: string | null;
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

export interface TaskListResponse {
  tasks: TaskSummary[];
}

export interface TaskDetailResponse {
  task: TaskDetail;
  transcript: TranscriptEntry[];   // top-level, NOT nested in task
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

export async function listTasks(
  filter?: { status?: string; limit?: number; before?: string; group_id?: string; include_archived?: boolean }
): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.limit != null) params.set('limit', String(filter.limit));
  if (filter?.before) params.set('before', filter.before);
  if (filter?.group_id) params.set('group_id', filter.group_id);
  if (filter?.include_archived) params.set('include_archived', '1');
  const qs = params.toString();
  return apiFetch<TaskListResponse>(`/dashboard/api/tasks${qs ? `?${qs}` : ''}`);
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

export async function getTask(id: string): Promise<TaskDetailResponse> {
  return apiFetch<TaskDetailResponse>(`/dashboard/api/tasks/${encodeURIComponent(id)}`);
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

export async function postSteer(
  taskId: string,
  body: { idempotency_key: string; text: string }
): Promise<SteerResponse> {
  return apiFetch<SteerResponse>(
    `/dashboard/api/tasks/${encodeURIComponent(taskId)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
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

export interface RetryResponse {
  status: 'admitted';
  original_task_id: string;
  idempotency_key: string;
}

export async function retryTask(taskId: string): Promise<RetryResponse> {
  return apiFetch<RetryResponse>(
    `/dashboard/api/tasks/${encodeURIComponent(taskId)}/retry`,
    { method: 'POST' }
  );
}

export interface ArchiveResponse {
  task_id: string;
  archived_at?: string;
}

export async function archiveTask(taskId: string): Promise<ArchiveResponse> {
  return apiFetch<ArchiveResponse>(
    `/dashboard/api/tasks/${encodeURIComponent(taskId)}/archive`,
    { method: 'POST' },
  );
}

export async function unarchiveTask(taskId: string): Promise<ArchiveResponse> {
  return apiFetch<ArchiveResponse>(
    `/dashboard/api/tasks/${encodeURIComponent(taskId)}/unarchive`,
    { method: 'POST' },
  );
}

export interface BulkArchiveResponse {
  archived: number;
}

/** Mirrors backend `TerminalTaskStatus` in `src/modules/orchestrator-dispatch/db/tasks.ts`. */
export type TerminalTaskStatus = 'failed' | 'completed' | 'cancelled';

export async function bulkArchive(
  status: TerminalTaskStatus,
  group_id: string,
): Promise<BulkArchiveResponse> {
  return apiFetch<BulkArchiveResponse>('/dashboard/api/tasks/bulk-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, group_id }),
  });
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
