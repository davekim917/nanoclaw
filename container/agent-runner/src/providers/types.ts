export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional. When true, the runner scaffolds a persistent `memory/` tree in the
   * agent's workspace at boot. Providers with their own native memory (e.g.
   * Claude's `CLAUDE.local.md`) omit this and get nothing — memory is opt-in per
   * provider, never gated on a provider name.
   */
  readonly usesMemoryScaffold?: boolean;

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
   * True if the given error indicates the session has grown past the model's
   * context window. Poll-loop uses this to trigger in-turn recovery: clear
   * the continuation AND retry the same user message once with a fresh
   * session, so long-lived sessions don't dead-turn the user.
   *
   * Optional because not every provider has a distinct prompt-too-long
   * signal; those that don't should return false (poll-loop falls back to
   * the error-write path).
   */
  isContextTooLong?(err: unknown): boolean;

  /**
   * True if the given error is a transient upstream failure (429, rate
   * limit, overloaded, upstream_error, External provider returned).
   * Providers with credential rotation (multiple API keys) can use this
   * to trigger `rotateApiKey` before in-turn retry.
   */
  isRetryable?(err: unknown): boolean;

  /**
   * True if the error is a *transient server-side* rate limit / overload
   * (HTTP 429/529, "temporarily limiting requests", explicitly "not your
   * usage limit") — distinct from `isRetryable`, which also covers
   * credential-quota exhaustion. The server is busy, not the credential, so
   * rotating keys is useless; the cure is to wait and retry the SAME request.
   * Poll-loop uses this to back off and retry in-turn (no rotation) instead
   * of dispatching the provider's error text to the user as the agent's reply.
   *
   * Optional: providers whose runtime already retries overloads to exhaustion
   * and then THROWS (vs. returning the error as result text) can omit this.
   */
  isTransientOverload?(err: unknown): boolean;

  /**
   * Advance to the next configured fallback credential (API key or OAuth
   * token). Returns `rotated: true` if a rotation happened, false if no
   * more fallbacks remain. The stored continuation is preserved across
   * rotations: the Claude Code SDK's `resume:` reads a LOCAL `.jsonl`
   * transcript (`~/.claude/projects/<hash>/<session>.jsonl`), and the
   * Anthropic API has no server-side session object that's bound to an
   * account — replaying the prior history under a new token works the
   * same as a `/login` mid-conversation in interactive Claude Code.
   *
   * Poll-loop pairs this with `isRetryable` to auto-recover from upstream
   * flakiness without dead-turning the user.
   */
  rotateApiKey?(): { rotated: boolean };

  /**
   * Reset the per-turn rotation cycle budget. Rotation is circular — on a
   * retryable error the poll-loop keeps calling `rotateApiKey` to cycle
   * through the whole credential pool (wrapping back to the primary) until
   * one succeeds or the pool is exhausted *this turn*. The active position is
   * sticky across turns (a recovered credential keeps serving), but each new
   * turn gets a fresh full-cycle budget so a credential that's since healed
   * can be retried. Poll-loop calls this once at the start of every turn.
   */
  resetRotationCycle?(): void;

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
   * Per-provider sticky config from container.json.providerConfig.
   * Validated by the create_agent MCP handler against the provider's
   * configSchema before it reaches the host for persistence (container is
   * the validation authority — see decision D4 / C11). Each provider reads
   * only its own slice in its constructor or query() method.
   */
  providerConfig?: Record<string, unknown>;
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

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
   * Per-turn model override. Passed to the SDK as the query's `model`
   * option. Providers that don't support per-query model selection should
   * ignore this. Effective model is: turn override → sticky override →
   * provider default.
   */
  model?: string;

  /** Per-turn effort level override (SDK option `effort`, first-class since Opus 4.6). */
  effort?: string;

  /**
   * Enable ultracode for the session (xhigh effort + standing dynamic-workflow
   * orchestration). Set via `-e ultracode`. The Claude provider applies it via
   * the Agent SDK `applyFlagSettings` control request; effort is already forced
   * to xhigh upstream. Providers that don't support it ignore this field.
   */
  ultracode?: boolean;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

export interface StdioMcpServerConfig {
  /** Omitted `type` defaults to stdio for backward compat with the older config shape. */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Remote MCP server over HTTP(S). Used for OAuth-gated services where the
 * host's OneCLI gateway injects credentials via HTTPS_PROXY — the container
 * never sees the token. See `granola` wiring in the host container-runner.
 */
export interface HttpMcpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface SseMcpServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;

  /**
   * Apply -m/-e flag changes to the LIVE query — same conversation, same
   * stream, no teardown (claude: SDK setModel + applyFlagSettings control
   * requests, mirroring interactive Claude Code's /model). Optional:
   * providers without in-flight controls (codex/opencode are sticky-only)
   * omit it and the poll-loop falls back to ending the stream so the next
   * query picks the flags up. MUST throw when the requested combination
   * can't be expressed live (e.g. the effortLevel control has no 'max') so
   * the caller can use the same fallback.
   */
  applySettings?(settings: { model?: string; effort?: string; ultracode?: boolean }): Promise<void>;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * A completed turn. `isError` is set when the underlying SDK flagged the
   * turn as an error (e.g. a non-retryable Anthropic 403 billing_error). The
   * poll-loop uses it to surface the result text to the user instead of
   * dropping it as un-wrapped scratchpad, and to skip the re-wrap nudge.
   */
  | { type: 'result'; text: string | null; isError?: boolean }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Provider-produced file artifact that should be delivered to the
   * originating channel as an attachment. The poll-loop owns routing and
   * outbox staging; providers only report the local path.
   */
  | { type: 'file'; path: string; filename?: string; text?: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   */
  | { type: 'compacted'; text: string };
