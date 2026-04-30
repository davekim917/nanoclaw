export interface FactInput {
  content: string;
  category: 'preference' | 'decision' | 'insight' | 'fact' | 'context';
  importance: number;
  entities?: string[];
  supersedes?: string[];
  provenance: {
    sourceType: 'chat' | 'tool' | 'manual';
    sourceId: string;
    sourceRole?: 'user' | 'assistant' | 'joint' | 'external';
  };
  confidence?: number;
  validFrom?: string;
  validTo?: string | null;
}

export interface RecalledFact {
  id: string;
  content: string;
  category: FactInput['category'];
  importance: number;
  entities: string[];
  score: number;
  createdAt: string;
}

export interface RecallResult {
  facts: RecalledFact[];
  totalAvailable: number;
  latencyMs: number;
  fromCache: boolean;
}

export interface RememberResult {
  action: 'added' | 'updated' | 'replaced' | 'skipped';
  factId: string;
  supersededIds?: string[];
}

export interface MemoryStore {
  recall(
    agentGroupId: string,
    query: string,
    opts?: { limit?: number; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RecallResult>;
  remember(agentGroupId: string, fact: FactInput, opts?: { idempotencyKey?: string }): Promise<RememberResult>;
  health(agentGroupId: string): Promise<{ ok: boolean; reason?: string }>;
}
