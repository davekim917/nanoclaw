import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * True when the session outgrew the model's context window: the poll-loop clears the continuation and retries
   * the same message once on a fresh session. Providers without a distinct signal return false.
   */
  isContextTooLong?(err: unknown): boolean;

  /** Transient upstream failure (429, overloaded, upstream_error) that warrants `rotateApiKey` before a retry. */
  isRetryable?(err: unknown): boolean;

  /**
   * Transient SERVER-side rate limit / overload (429/529, "not your usage limit"), unlike `isRetryable`, which
   * also covers credential quota: rotating keys is useless, so the poll-loop waits and retries the same request.
   * Omit when the runtime already retries overloads to exhaustion and then throws.
   */
  isTransientOverload?(err: unknown): boolean;

  /**
   * True when this ACCOUNT is spent (usage/credit limit) until the provider's window resets; no retry on this
   * credential can recover it.
   */
  isQuotaExhausted?(err: unknown): boolean;

  /**
   * Advance to the next fallback credential; `rotated: false` when none remain. The continuation survives
   * rotation because the SDK's `resume:` reads a LOCAL `.jsonl` transcript not bound to an account.
   * When `rotated`, `slot` is the now-active env var name, `position` its 1-based ring place (primary is 1) and
   * `ringSize` the ring length; the poll-loop tells the replayed turn it runs on a different credential.
   */
  rotateApiKey?(): { rotated: boolean; slot?: string; position?: number; ringSize?: number };

  /**
   * Whether resuming `continuation` provably loads `prompt` as a user message recorded at or after `sinceMs`, so
   * a rotation retry can point at it instead of re-sending. Absent or false means re-send.
   */
  transcriptHasPrompt?(continuation: string | undefined, prompt: string, sinceMs: number): boolean;

  /**
   * Reset the per-turn rotation budget. The active ring position is sticky across turns, but each turn gets a
   * fresh full cycle so a healed credential can be retried. The poll-loop calls it at the start of every turn.
   */
  resetRotationCycle?(): void;

  /**
   * Restore the credential slot a previous container of this session persisted. Reads session state, so call it
   * only after the mailbox has started, never from the constructor or `query()`.
   */
  restorePersistedCredentialSlot?(): void;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];

  /**
   * Per-provider sticky config from container.json.providerConfig, validated in-container against the provider's
   * configSchema before persistence. Each provider reads only its own slice.
   */
  providerConfig?: Record<string, unknown>;
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

/**
 * One channel attachment, structured. Every attachment is also described inline in the formatted prompt, and that
 * text stays the contract every provider relies on; this is an additive view for SDKs that take a real file part.
 */
export interface PromptAttachment {
  filename?: string;
  /** MIME type as reported by the channel. Absent for adapters that omit it. */
  mime?: string;
  /** Absolute path inside the container, when the file was staged to the inbox. */
  path?: string;
  url?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  attachments?: PromptAttachment[];

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Per-turn model override; providers without per-query model selection ignore it. Effective model: turn
   * override → sticky override → provider default.
   */
  model?: string;

  effort?: string;

  /**
   * Ultracode (xhigh effort + standing workflow orchestration). The Claude provider applies it via the SDK
   * `applyFlagSettings` control request; effort is already forced to xhigh by the caller.
   */
  ultracode?: boolean;

  /** Codex fast service tier; other providers ignore it. Effective: one-turn override → sticky → false. */
  fast?: boolean;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

interface StdioMcpServerConfig {
  /** Omitted `type` defaults to stdio for backward compat with the older config shape. */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Absolute container path. A provider whose runtime cannot set a spawn directory must shim it, never silently
   * launch in the wrong directory.
   */
  cwd?: string;
  /** Consumed and stripped by plugin-mcp.ts before the config reaches a provider. */
  pluginRoot?: string;
}

/** The OneCLI gateway injects credentials via HTTPS_PROXY; the container never sees the token. */
interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  /**
   * Returns the prompt id when the provider tracks prompt ids (see `answeredPrompts`). OpenCode receives most
   * traffic here rather than through `query()`, so attachments must travel on this path too.
   */
  push(message: string, attachments?: PromptAttachment[]): string | void;
  /** Id of the `query()` prompt, when the provider tracks prompt ids. */
  readonly initialPromptId?: string;

  /**
   * True while the provider holds an accepted `push()` queued as its own future turn rather than merged into the
   * running one. Claude reports a prompt queued until a result echoes its id or the CLI goes idle, since its CLI
   * can answer a turn it started itself while the runner's prompt waits behind it.
   *
   * The poll-loop reads it at `result` before lowering the busy level: otherwise idle is published across the
   * gap before the queued turn starts and the host's reaper can kill the container, losing the follow-up. The
   * poll-loop's own prompt ledger over-counts once a merging provider absorbs a push, so it cannot substitute.
   */
  hasQueuedWork?(): boolean;

  /**
   * Whether the CLI still has live background work (a `run_in_background` subagent above all) that will report
   * back after this turn's `result`. Latched: it releases at the CLI's idle with nothing live, not when the set
   * empties, because the CLI withholds idle for subagents until their follow-up turn; task types whose idle the CLI
   * does not gate release at their drain once that has been observed.
   *
   * The poll-loop reads it wherever it would lower the busy level; otherwise a turn that launches a background
   * agent and ends publishes idle and the host's reaper kills the container, and the agent with it.
   */
  hasBackgroundWork?(): boolean;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;

  /**
   * Apply -m/-e changes to the LIVE query (claude: SDK setModel + applyFlagSettings). MUST throw when the
   * combination can't be expressed live (e.g. effortLevel has no 'max') so the caller can open a fresh query.
   * Providers without live controls omit this or set requiresRestartForRuntimeContext.
   */
  applySettings?(settings: { model?: string; effort?: string; ultracode?: boolean }): Promise<void>;

  /**
   * True when runtime identity lives in immutable query-start instructions: the poll-loop holds a settings-bearing
   * follow-up until the query is idle, then reopens rather than leave a stale identity statement.
   */
  readonly requiresRestartForRuntimeContext?: boolean;

  /**
   * The model this query ACTUALLY runs, resolved by the provider: the single source for usage attribution, since
   * callers cannot resolve the group default (`providerConfig.model` outranks the env default) themselves.
   * Required on purpose; a provider that cannot name its model returns an explicit known-unknown marker, never
   * `undefined` or `''`.
   */
  readonly resolvedModel: string;

  /**
   * The effort this query actually RUNS at after precedence and clamp, never what the turn requested. `null`
   * means the turn runs with no effort setting.
   */
  readonly resolvedEffort: string | null;
}

/**
 * Per-turn token/cost usage from the provider's own result payload. Omit a field the provider doesn't expose
 * rather than guessing.
 *
 * Report the WHOLE turn, never one model request: sum per-request figures. Reporting a running total (turn-usage.ts
 * CUMULATIVE_PROVIDERS) is safe only when it resets with the process, because the delta baseline is not persisted.
 */
export interface TurnUsageInfo {
  /** Counter lifetime supplied by the provider; a resumed session can open a new query counter. */
  accounting?: { kind: 'cumulative'; scope: string } | { kind: 'per-turn' };
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  /**
   * EFFECTIVE (post-clamp) effort sent; `null` when none was sent or the entry is not attributable (see
   * providers/turn-effort.ts). Stamped by `attachTurnEffort`, not read from the usage report.
   */
  effort?: string | null;
  /** Pre-clamp result of the effort resolution chain. See `effort`. */
  effortRequested?: string | null;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   * `usage` as an array means the turn spanned multiple models: one entry per model.
   *
   * `steps` is the provider's API round-trip count or its closest proxy, turn-level (every multi-model `usage` row
   * gets the same value); NULL when unavailable, never guessed.
   *
   * `rateLimit` — Claude: the latest `rate_limit_event` this turn; Codex: the weekly (else five-hour) window of the
   * account snapshot; OpenCode leaves it unset.
   */
  | {
      type: 'result';
      text: string | null;
      isError?: boolean;
      /**
       * Ids of the runner's prompts this turn consumed, as echoed. Empty for a turn the CLI started itself (resume
       * continuation, background-task notification); a prompt consumed without an echo is reported later through
       * `settled`. Undefined from a provider that does not track prompt ids.
       */
      answeredPrompts?: string[];
      usage?: TurnUsageInfo | TurnUsageInfo[];
      steps?: number | null;
      rateLimit?: { type: string | null; utilization: number | null; resetsAt: string | null } | null;
    }
  /**
   * The provider went idle holding accepted prompts whose echo was dropped; the last result that answered none of
   * the runner's prompts consumed them.
   */
  | { type: 'settled'; unansweredPrompts: string[] }
  /**
   * Background level at the CLI's idle signal, which is withheld while background agents run, so `live === 0`
   * means no completion-started follow-up turn is coming. Reporting at the membership change instead would let a
   * sweep reap the container before the follow-up turn's `init`.
   */
  | { type: 'background_work'; live: number }
  /**
   * `resetAt` is a MEASURED recovery instant (ISO-8601 UTC): the host parks until exactly then, unlike a reset
   * parsed from error prose, which it treats as an upper bound.
   */
  | { type: 'error'; message: string; retryable: boolean; classification?: string; resetAt?: string | null }
  | { type: 'progress'; message: string }
  /**
   * The Codex account at `home` (a CODEX_HOME inside the container) is at its quota and the provider is moving to
   * the next one. Reported to the host so new containers start past it.
   */
  | { type: 'codex_account_exhausted'; home: string }
  /** File to deliver as an attachment; the poll-loop owns routing and outbox staging. */
  | { type: 'file'; path: string; filename?: string; text?: string }
  /**
   * Text the agent wrote before a tool call in the same turn, so the `result` won't carry it. The poll-loop
   * delivers its complete `<message to="…">` blocks and drops the rest. Top-level assistant text only.
   */
  | { type: 'interim_text'; text: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The SDK auto-compacted the context: the poll-loop re-injects a destination reminder so `<message to="…">`
   * wrapping survives. Distinct from `result` so it neither completes the turn nor is dispatched.
   */
  | { type: 'compacted'; text: string };
