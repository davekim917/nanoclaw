import type {
  GraphAffectedResult,
  GraphExplainResult,
  GraphPathResult,
  GraphQueryResult,
  WorkgroupGraphStatus,
} from '../graphify/types.js';

export interface WorkgroupRoot {
  absolutePath: string;
  /** Portable provenance prefix inside the workgroup graph. */
  prefix: string;
}

export interface WorkgroupDescriptor {
  id: string;
  memberIds: string[];
  roots: WorkgroupRoot[];
}

export interface TrustedOverlayContext {
  agentGroupId: string;
  sessionId: string;
}

export interface FreshnessStatus {
  dirty: boolean;
  reconciling: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lagMs: number;
  pendingEnrichment: number;
  lastFailure?: string;
  paused: boolean;
}

export interface DaemonWorkgroupStatus extends WorkgroupGraphStatus {
  freshness: FreshnessStatus;
}

export type GraphReadResult = GraphQueryResult | GraphExplainResult | GraphPathResult | GraphAffectedResult | null;

export type ControlCommand =
  | 'query'
  | 'path'
  | 'explain'
  | 'affected'
  | 'status'
  | 'ensure-fresh'
  | 'reindex'
  | 'pause'
  | 'resume';

export interface ControlRequest {
  id: string;
  workgroupId: string;
  command: ControlCommand;
  args: Record<string, unknown>;
  agentGroupId?: string;
  sessionId?: string;
}

export interface GraphifyDaemonApi {
  hasWorkgroup(workgroupId: string): boolean;
  validateOverlayContext(workgroupId: string, context: TrustedOverlayContext): Promise<void> | void;
  query(workgroupId: string, term: string, limit?: number, context?: TrustedOverlayContext): Promise<GraphReadResult>;
  explain(
    workgroupId: string,
    nodeId: string,
    depth?: number,
    context?: TrustedOverlayContext,
  ): Promise<GraphReadResult>;
  path(
    workgroupId: string,
    from: string,
    to: string,
    maxDepth?: number,
    context?: TrustedOverlayContext,
  ): Promise<GraphReadResult>;
  affected(
    workgroupId: string,
    nodeId: string,
    maxDepth?: number,
    context?: TrustedOverlayContext,
  ): Promise<GraphReadResult>;
  status(workgroupId: string): Promise<DaemonWorkgroupStatus> | DaemonWorkgroupStatus;
  ensureFresh(workgroupId: string, timeoutMs?: number, context?: TrustedOverlayContext): Promise<DaemonWorkgroupStatus>;
  markDirty(workgroupId: string): void;
  reindex(workgroupId: string, full: boolean): Promise<void> | void;
  pause(workgroupId: string): void;
  resume(workgroupId: string): void;
}
