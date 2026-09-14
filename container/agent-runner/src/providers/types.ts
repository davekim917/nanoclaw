import type { MemorySessionHookRegistration } from '../memory/session-hook.js';

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Register trusted static memory guidance through this provider's lifecycle seam. */
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
   * True when the error means this ACCOUNT is spent (a usage/credit limit
   * that resets on the provider's own schedule), as opposed to a transient
   * server-side rate limit. Nothing inside the container can recover it:
   * every retry on this credential fails until the window resets.
   *
   * Providers surface quota in more than one shape — a classified event on
   * one path, a plain thrown Error on another — so the decision belongs with
   * the provider that knows its own error vocabulary, not with a string match
   * in the poll loop.
   */
  isQuotaExhausted?(err: unknown): boolean;

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
   *
   * `slot`/`position`/`ringSize` are populated whenever `rotated` is true —
   * `slot` is the env var name of the credential now active (e.g.
   * `CLAUDE_CODE_OAUTH_TOKEN_2`), `position` its 1-based place in the ring
   * (primary is 1), and `ringSize` the ring's total length. Poll-loop passes
   * these through to the replayed turn so the agent knows it is running on a
   * different credential than the one that just failed — the rotation catch
   * calls this at poll-loop.ts:1010 and poll-loop.ts:1059 and hands the result
   * to `formatCredentialRetryPrompt` at poll-loop.ts:1017. Omitted (along
   * with `rotated: false`) when no rotation happened.
   */
  rotateApiKey?(): { rotated: boolean; slot?: string; position?: number; ringSize?: number };

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
   * Restore the credential slot persisted by a previous instance of this
   * session's container (circular OAuth ring only — see
   * `ClaudeProvider.restorePersistedCredentialSlot`). Reads session state, so
   * the runner entrypoint calls it once after the mailbox has started
   * (`index.ts:97`) and the provider is built (`index.ts:308`); providers
   * must not call it from their constructor or from `query()`.
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
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

/**
 * One channel attachment, in structured form.
 *
 * Every attachment is ALSO described inline in the formatted prompt (see
 * formatter.ts `formatAttachments`), and that text rendering stays the contract
 * every provider relies on. This is an additive view for providers whose SDK
 * can take a real file part, so a provider that ignores it loses nothing.
 */
export interface PromptAttachment {
  /** Display name, when the channel gave one. */
  filename?: string;
  /** MIME type as reported by the channel. Absent for adapters that omit it. */
  mime?: string;
  /** Absolute path inside the container, when the file was staged to the inbox. */
  path?: string;
  /** Remote URL, when the channel only supplied a link. */
  url?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /** Attachments on the messages the prompt was built from, structured. */
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

  /**
   * Use Codex's fast service tier for this query. Other providers ignore it.
   * Effective value is: one-turn override → sticky override → false.
   */
  fast?: boolean;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

export interface StdioMcpServerConfig {
  /** Omitted `type` defaults to stdio for backward compat with the older config shape. */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory for the server process, as an absolute container path.
   * A provider whose runtime cannot set a spawn directory must shim it — never
   * silently launch in the wrong directory. (upstream 5e15069da)
   */
  cwd?: string;
  /**
   * Container-side root of the plugin this server shipped in, recorded by
   * the host at stamp time. Consumed (and stripped) by plugin-mcp.ts, which
   * expands ${PLUGIN_ROOT}/${PLUGIN_DATA} and injects both env vars before
   * the config reaches a provider.
   */
  pluginRoot?: string;
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
  /**
   * Push a follow-up message into the active query.
   *
   * Attachments are optional and structured exactly like `QueryInput`'s. A
   * provider that keeps one long-lived query per session (OpenCode) sees most
   * real traffic here rather than through `query()`, so media has to travel on
   * this path too. Providers that ignore the argument behave as before — the
   * formatter still describes every attachment inside `message`.
   *
   * Returns the id the provider stamped on the prompt when it tracks prompt
   * ids (see `answeredPrompts`); a provider that does not returns nothing.
   */
  push(message: string, attachments?: PromptAttachment[]): string | void;
  /**
   * The id of the prompt `query()` was created with, when the provider tracks
   * prompt ids. With `push()`'s return value, it is what `answeredPrompts`
   * and `settled` refer to.
   */
  readonly initialPromptId?: string;

  /**
   * Optional. True when the provider is holding work it has ACCEPTED but not
   * started running: a `push()` it queued as its own future turn rather than
   * merging into the turn already in flight.
   *
   * `opencode.ts` has no merge path at all: every push lands in `pending` and
   * is dequeued later as a separate turn. `codex.ts` counts queued pushes and
   * steers still in flight. `claude.ts` merges a push into the running turn
   * when it can, but its CLI can also answer a turn it started itself (a
   * synthetic resume turn, a background-task notification) while the
   * runner's prompt is still queued behind it. So it reports a prompt as
   * queued until a result echoes the prompt's id or the CLI goes idle, and
   * only once the CLI has shown it emits session-state events.
   *
   * The poll-loop reads it at `result` to decide whether it may lower the
   * published busy level. Without it, the result that ends turn A publishes
   * idle across the whole gap before queued turn B starts — no due row, no
   * processing claim, no continuation, no busy flag — and the host's task
   * reaper can kill the container and lose the follow-up. The provider's own
   * queue is the only honest source: the poll-loop's prompt ledger over-counts
   * permanently once a merging provider absorbs a mid-turn push (see the
   * `turnIdle` comment in poll-loop.ts).
   */
  hasQueuedWork?(): boolean;

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
   * An omitted `model` means "no per-TURN override" — the same thing it means
   * at query creation — and the implementation must RESOLVE it to the value a
   * fresh query would have used, not leave the stream on whatever it had.
   * Absence meaning "unchanged" here while meaning "fall through to the default"
   * at creation is how a suppressed turn keeps running on a stale model.
   * Returning the resolved model lets the caller attribute usage to what
   * actually ran; a provider that cannot report it may still return void.
   *
   * Providers without in-flight controls (codex/opencode are sticky-only),
   * or with immutable query-start runtime context, omit this or set
   * requiresRestartForRuntimeContext so the poll-loop opens a fresh query.
   * MUST throw when the requested combination can't be expressed live (e.g.
   * the effortLevel control has no 'max') so the caller can use that fallback.
   */
  applySettings?(settings: { model?: string; effort?: string; ultracode?: boolean }): Promise<void>;

  /**
   * True when the provider's runtime identity is installed in immutable
   * query-start instructions. The poll-loop keeps a settings-bearing follow-up
   * pending until the active query is idle, then ends and reopens rather than
   * leave a later prompt with a stale identity statement.
   */
  readonly requiresRestartForRuntimeContext?: boolean;

  /**
   * The model this query is ACTUALLY running, resolved by the provider.
   *
   * THE single source for usage attribution, and the reason it lives on the
   * query rather than being returned from the calls that change it: a caller
   * passes `model: undefined` meaning "the group default" and cannot resolve
   * that itself — `stickyConfig.model` (a group's `providerConfig.model`)
   * outranks `ANTHROPIC_DEFAULT_OPUS_MODEL` and is invisible outside the
   * provider. A group on this install sets exactly that and has a live unpinned
   * series, so a caller-side guess would mis-attribute a real production task.
   *
   * Reading it from the query covers every path by construction: creation
   * sets it, `applySettings` updates it, and a NEW path cannot forget to
   * report because there is nothing to report — the caller reads. Recording
   * absence instead is what put a NULL model on unpinned fires in
   * `task_run_outcomes`, the "can't tell what actually ran" hole #549 and
   * #561 exist to close.
   *
   * REQUIRED, deliberately. It was optional for one release and the two
   * providers that did not implement it were simply forgotten — three review
   * rounds each closed this hole at one more site (the live path, the initial
   * path, then codex and opencode) because "optional" and "forgettable" are
   * the same thing in a structural type. Required is what makes a fourth site
   * impossible rather than merely unlikely.
   *
   * A provider that genuinely cannot name an effective model must return an
   * explicit known-unknown marker, never `undefined` or `''`: the ledger
   * distinguishing "ran on something we can't name" from "we didn't look" is
   * the entire point, and silence reads as the latter.
   */
  readonly resolvedModel: string;
}

/**
 * Per-turn token/cost usage, as reported by the provider's own result
 * payload. Every field is optional/nullable because coverage varies by
 * provider (and by SDK version within a provider) — omit a field the
 * provider doesn't expose rather than guessing. The poll-loop writes
 * whatever arrives (all-NULL included) as one `turn_usage` row per
 * completed turn, so gaps stay visible instead of silently missing.
 *
 * Report the WHOLE turn, never one model request. A turn is many requests,
 * and both codex and opencode once reported only their last one — a 66-step
 * codex turn recorded as 39 output tokens. If the provider exposes
 * per-request figures (OpenCode, Codex), sum them here. Reporting a running
 * total and registering the provider in turn-usage.ts's CUMULATIVE_PROVIDERS
 * is the OTHER option, and it is only safe when that total resets with the
 * process: the delta baseline is an unpersisted module global, so a counter
 * that survives a container respawn (Codex's thread total) comes back raw and
 * books the whole pre-restart history as one turn.
 */
export interface TurnUsageInfo {
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: number | null;
  /**
   * Reasoning effort this entry ran at, EFFECTIVE (post-clamp) — the value
   * actually sent to the provider, `null` when it deliberately sent none
   * (Haiku) or when the entry is a model the effort was not resolved for
   * (a subagent on a multi-model turn). Unlike every field above it is a
   * REQUEST parameter, not something the API bills back, so it is stamped on
   * by `attachTurnEffort` rather than read out of a usage report — see
   * providers/turn-effort.ts for the attribution rule and why NULL here means
   * "not attributable" rather than "no effort".
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
   * `usage` carries whatever token/cost accounting the provider exposed for
   * this turn — see TurnUsageInfo. An array means the turn spanned multiple
   * models (e.g. Opus parent + Sonnet subagents) — one entry per model,
   * each attributed separately rather than collapsed under a NULL model.
   *
   * `steps` is the number of provider API round-trips this turn made — a
   * diagnostic for telling apart a fat-context turn (big prefix, few steps)
   * from a long-loop turn (many sequential calls), not the smoking gun it
   * was first thought to be (corrected estimate: ~20-35 calls/turn, not
   * 150-400 — the original estimate was itself measured against the
   * cumulative-usage bug, see turn-usage.ts). It is turn-level, not
   * per-model, so every row a multi-model `usage` array produces gets the
   * same value. Coverage varies by provider (each reports the closest thing
   * its own protocol exposes — see each provider's result-event
   * construction for what that is); NULL when nothing usable is available,
   * never a guessed count.
   *
   * `rateLimit` is Claude-only: the most recent `rate_limit_event` observed
   * during this turn (utilization/type/resetsAt), or null if none fired.
   * Answers "what share of our weekly allowance have we burned" directly,
   * instead of inferring it from cost estimates.
   */
  | {
      type: 'result';
      text: string | null;
      isError?: boolean;
      /**
       * Ids of the runner's prompts this turn consumed, as the provider saw
       * them echoed. Present only from a provider that tracks prompt ids,
       * which also returns an id from `push()` and exposes `initialPromptId`.
       * Empty when the turn consumed none of them: a turn the CLI started
       * itself, such as its synthetic "Continue from where you left off."
       * turn on resuming an interrupted session, or one a background-task
       * notification started. A prompt consumed with no echo (the SDK lists
       * the cases on SDKResultSuccess/SDKResultError) is reported later
       * through `settled`. Undefined from a provider that does not track
       * prompt ids.
       */
      answeredPrompts?: string[];
      usage?: TurnUsageInfo | TurnUsageInfo[];
      steps?: number | null;
      rateLimit?: { type: string | null; utilization: number | null; resetsAt: string | null } | null;
    }
  /**
   * The provider went idle holding prompts it accepted but never saw
   * answered: their echo was dropped. The last result that answered none of
   * the runner's prompts is the one that consumed them. Only a provider that
   * tracks prompt ids emits it.
   */
  | { type: 'settled'; unansweredPrompts: string[] }
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
