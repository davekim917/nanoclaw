/** Shared Observatory contract. Source facts and human review state stay separate. */
export interface SignalPerson {
  id: string;
  name: string;
}
export interface SignalSourceHealth {
  workgroup_id: string;
  source: string;
  as_of: string | null;
  status: 'available' | 'stale' | 'unavailable';
  detail: string | null;
}
export interface SignalProject {
  id: string;
  workgroup_id: string;
  name: string;
  description: string;
  repositories: string[];
  channel_keys: string[];
  version: number;
  updated_at: string | null;
  unmapped: boolean;
  thread_ids: string[];
  decision_ids: string[];
  items: SignalWorkItem[];
}
export interface SignalWorkItem {
  id: string;
  title: string;
  owner_hint: string | null;
  next_action: string | null;
  next_mover: string;
  depends_on: string[] | null;
  source_url: string | null;
  as_of: string | null;
}
export interface SignalDecisionEvent {
  at: string;
  actor: SignalPerson;
  action: 'claim' | 'release' | 'answer';
  note: string | null;
  evidence_hash: string;
}
export interface SignalDecision {
  id: string;
  workgroup_id: string;
  project_id: string | null;
  source_kind: 'release-item' | 'thread-question' | 'approval';
  source_id: string;
  source_as_of: string | null;
  source_url: string | null;
  question: string;
  context: string;
  next_action: string | null;
  owner_hint: string | null;
  owner: SignalPerson | null;
  evidence_hash: string;
  version: number;
  state: 'open' | 'answered' | 'changed';
  answer: string | null;
  answered_by: SignalPerson | null;
  answered_at: string | null;
  thread_id: string | null;
  agent_group_id: string | null;
  blocks_release: boolean;
  dispatch_state: 'not_requested' | 'pending' | 'sent' | 'failed';
  dispatch_error: string | null;
  dispatch_target_thread_id?: string | null;
  dispatch_agent_group_id?: string | null;
  dispatch_evidence_hash?: string | null;
  capabilities: { claim: boolean; answer: boolean; dispatch: boolean; release?: boolean };
  history: SignalDecisionEvent[];
}
export interface SignalAgent {
  id: string;
  workgroup_id: string;
  name: string;
  provider: string;
  awake: boolean;
  active: boolean;
  last_seen_at: string | null;
  thread_ids: string[];
  current_tool: string | null;
  claims?: string[];
  next_task?: { title: string; at: string } | null;
}
export interface SignalActivity {
  id: string;
  workgroup_id: string;
  at: string;
  title: string;
  detail: string;
  thread_id: string | null;
  kind: 'thread' | 'decision';
}
export interface SignalOverview {
  timezone?: string;
  thread_coverage?: {
    workgroup_id: string;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset: number | null;
  }[];
  as_of: string;
  workgroups: { id: string; name: string }[];
  projects: SignalProject[];
  decisions: SignalDecision[];
  agents: SignalAgent[];
  activity: SignalActivity[];
  sources: SignalSourceHealth[];
  capabilities: { manage_projects: boolean };
}
export interface SignalDecisionDetail {
  decision: SignalDecision;
  evidence: { title: string; text: string; at: string | null; url: string | null }[];
  recipients: SignalPerson[];
}
export interface SignalReviewRequest {
  expected_version: number;
  evidence_hash: string;
  action: 'claim' | 'release' | 'answer';
  text?: string;
  idempotency_key: string;
}
export interface SignalDispatchRequest {
  target_thread_id?: string;
  expected_version: number;
  evidence_hash: string;
  agent_group_id: string;
}
