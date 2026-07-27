import { callClaudeCliStructured, type ClaudeCredentialSlot, type ClaudeStructuredResult } from '../../llm.js';
import { CURATOR_OUTPUT_SCHEMA, type CuratorModelDecision } from './curator-contract.js';

export const MEMORY_CURATOR_MODEL = 'claude-sonnet-5';
export const MEMORY_CURATOR_EFFORT = 'medium' as const;
export const MEMORY_CURATOR_MAX_TOKENS = 8192;
export const MEMORY_CURATOR_TIMEOUT_MS = 120_000;

export type CuratorModelCall = <T>(
  request: {
    model: string;
    effort: 'medium';
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    timeoutMs: number;
    signal?: AbortSignal;
  },
  options?: {
    credentialSlot?: ClaudeCredentialSlot;
  },
) => Promise<ClaudeStructuredResult<T>>;

export interface CuratorBackendResult {
  decision: CuratorModelDecision;
  model: string;
  credentialSlot: ClaudeStructuredResult<unknown>['credentialSlot'];
  usage: ClaudeStructuredResult<unknown>['usage'];
}

export class MemoryCuratorBackend {
  constructor(private readonly call: CuratorModelCall = callClaudeCliStructured) {}

  async curate(
    system: string,
    user: string,
    credentialSlot: ClaudeCredentialSlot,
    signal?: AbortSignal,
  ): Promise<CuratorBackendResult> {
    const result = await this.call<CuratorModelDecision>(
      {
        model: MEMORY_CURATOR_MODEL,
        effort: MEMORY_CURATOR_EFFORT,
        system,
        user,
        schema: CURATOR_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: MEMORY_CURATOR_MAX_TOKENS,
        timeoutMs: MEMORY_CURATOR_TIMEOUT_MS,
        signal,
      },
      { credentialSlot },
    );
    return {
      decision: result.value,
      model: result.model,
      credentialSlot: result.credentialSlot,
      usage: result.usage,
    };
  }
}
