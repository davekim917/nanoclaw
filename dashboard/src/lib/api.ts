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

export interface SessionSummary {
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  last_active: string | null;
  container_status: 'idle' | 'running' | 'stale' | 'unknown';
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

export async function listSessions(): Promise<SessionsResponse> {
  return apiFetch<SessionsResponse>('/dashboard/api/sessions');
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
