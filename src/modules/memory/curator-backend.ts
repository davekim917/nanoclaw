import { callClaudeCliStructured, type ClaudeCredentialSlot, type ClaudeStructuredResult } from '../../llm.js';
import {
  CONSOLIDATION_OUTPUT_SCHEMA,
  CURATOR_OUTPUT_SCHEMA,
  type ConsolidationModelDecision,
  type CuratorModelDecision,
} from './curator-contract.js';

export const MEMORY_CURATOR_MODEL = 'claude-sonnet-5';
export const MEMORY_CURATOR_EFFORT = 'medium' as const;
export const MEMORY_CURATOR_MAX_TOKENS = 8192;
export const MEMORY_CURATOR_TIMEOUT_MS = 120_000;
// A consolidation pass can legitimately return up to CONSOLIDATION_MAX_FILES
// (12) files at up to CONSOLIDATION_FILE_MAX_BYTES (8,192) each — a ceiling
// the episode budget (8,192 output tokens total) cannot fit even once
// content is well under a quarter of that ceiling. Same model/effort as
// episodes, but the timeout must scale with the output budget: observed
// successful consolidation passes already ran ~101s at a THIRD of this
// 32,768 ceiling, so the unscaled 120s episode timeout was killing every
// large-workgroup pass (execFile SIGTERM, exit 143) before it could finish.
export const MEMORY_CONSOLIDATOR_MAX_TOKENS = 32_768;
export const MEMORY_CONSOLIDATOR_TIMEOUT_MS = 480_000;

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

export interface ConsolidationBackendResult {
  decision: ConsolidationModelDecision;
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

  /** Parallel to curate(), for pillar-2 topic-file consolidation passes (P2.4 item 9). */
  async consolidate(
    system: string,
    user: string,
    credentialSlot: ClaudeCredentialSlot,
    signal?: AbortSignal,
  ): Promise<ConsolidationBackendResult> {
    const result = await this.call<ConsolidationModelDecision>(
      {
        model: MEMORY_CURATOR_MODEL,
        effort: MEMORY_CURATOR_EFFORT,
        system,
        user,
        schema: CONSOLIDATION_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: MEMORY_CONSOLIDATOR_MAX_TOKENS,
        timeoutMs: MEMORY_CONSOLIDATOR_TIMEOUT_MS,
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
