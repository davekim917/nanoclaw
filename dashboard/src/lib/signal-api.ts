import type {
  SignalOverview,
  SignalDecision,
  SignalDecisionDetail,
  SignalReviewRequest,
  SignalDispatchRequest,
} from '../../../src/dashboard/observatory-v2/types.js';
export class SignalApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/dashboard/api/observatory/v2${path}`, {
    credentials: 'include',
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: string };
    throw new SignalApiError(response.status, failure.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export const getSignalOverview = (workgroup: string, threadOffset = 0) =>
  request<SignalOverview>(`?workgroup=${encodeURIComponent(workgroup)}&thread_offset=${threadOffset}&thread_limit=200`);
export const getSignalDecision = (id: string) => request<SignalDecisionDetail>(`/decisions/${encodeURIComponent(id)}`);
export const reviewSignalDecision = (id: string, body: SignalReviewRequest) =>
  request<{ decision: SignalDecision }>(`/decisions/${encodeURIComponent(id)}/review`, 'POST', body);
export const dispatchSignalDecision = (id: string, body: SignalDispatchRequest) =>
  request<{ decision: SignalDecision }>(`/decisions/${encodeURIComponent(id)}/dispatch`, 'POST', body);
export interface ProjectInput {
  workgroup_id: string;
  name: string;
  description: string;
  repositories: string[];
  channel_keys: string[];
  expected_version: number;
}
export const saveSignalProject = (id: string, body: ProjectInput) =>
  request<unknown>(`/projects/${encodeURIComponent(id)}`, 'PUT', body);
