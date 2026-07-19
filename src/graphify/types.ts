export const SOURCE_KINDS = ['code', 'document', 'conversation', 'structured', 'image', 'media'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATES = ['pending', 'indexed', 'metadata_only', 'quarantined', 'failed', 'deleted'] as const;

export type SourceState = (typeof SOURCE_STATES)[number];

export interface GraphEvidence {
  sourceId: string;
  relativePath: string;
  line?: number;
  page?: number;
  sheet?: string;
  messageId?: string;
  sentAt?: string;
  excerpt?: string;
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  evidence?: GraphEvidence[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  structural: boolean;
  description?: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  evidence?: GraphEvidence[];
}

export interface GraphHyperedgeMember {
  nodeId: string;
  role?: string;
}

export interface GraphHyperedge {
  id: string;
  type: string;
  name?: string;
  description?: string;
  members: GraphHyperedgeMember[];
  properties?: Record<string, unknown>;
  confidence?: number;
  evidence?: GraphEvidence[];
}

export interface ExtractionBundle {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hyperedges: GraphHyperedge[];
}

/** The immutable source identity plus its current filesystem/archive metadata. */
export interface SourceInput {
  id: string;
  workgroupId: string;
  kind: SourceKind;
  relativePath: string;
  contentHash: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface SourceRecord extends SourceInput {
  state: SourceState;
  generation: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type GraphNodeWithEvidence = Omit<GraphNode, 'evidence'> & {
  evidence: GraphEvidence[];
};

export type GraphEdgeWithEvidence = Omit<GraphEdge, 'evidence'> & {
  evidence: GraphEvidence[];
};

export type GraphHyperedgeWithEvidence = Omit<GraphHyperedge, 'evidence'> & {
  evidence: GraphEvidence[];
};

export interface GraphQueryResult {
  term: string;
  nodes: GraphNodeWithEvidence[];
  edges: GraphEdgeWithEvidence[];
  hyperedges: GraphHyperedgeWithEvidence[];
  indexedGeneration: number;
}

export interface GraphExplainResult {
  node: GraphNodeWithEvidence;
  evidence: GraphEvidence[];
  incoming: GraphEdgeWithEvidence[];
  outgoing: GraphEdgeWithEvidence[];
  hyperedges: GraphHyperedgeWithEvidence[];
  indexedGeneration: number;
}

export interface GraphPathResult {
  from: string;
  to: string;
  nodes: GraphNodeWithEvidence[];
  edges: GraphEdgeWithEvidence[];
  indexedGeneration: number;
}

export interface GraphAffectedResult {
  source: string;
  nodes: GraphNodeWithEvidence[];
  edges: GraphEdgeWithEvidence[];
  indexedGeneration: number;
}

export type SourceStateCounts = Record<SourceState, number>;

export interface WorkgroupGraphStatus {
  workgroupId: string;
  counts: SourceStateCounts;
  currentGeneration: number;
  completeGeneration: number;
  pendingJobs: number;
  failures: SourceRecord[];
  quarantines: SourceRecord[];
}
