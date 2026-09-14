/**
 * Per-query Codex rate-limit tracker: owns the held `RateLimitSnapshot`, the
 * `account/rateLimits/read` pull at each app-server bind, the
 * `account/rateLimits/updated` push subscription, and the sample rows both
 * write. codex.ts asks it two questions per turn — "should this turn be
 * parked?" and "what window do I stamp on turn_usage?".
 *
 * I/O is injected (RPC, auth.json read, sample writer, clock) so the whole
 * lifecycle runs against a fake app-server in tests with no network and no
 * `codex` binary — the hermeticity test depends on that.
 *
 * Failure policy mirrors claude.ts's `samplePlanUsage`: a read that errors or
 * exceeds its deadline is NOT SAMPLED (no row, no park) and logged; it never
 * fails or delays the turn beyond the deadline. The systemError park in the
 * poll-loop / host remains the fallback for a session whose read never
 * answers.
 */
import fs from 'fs';
import path from 'path';

import { recordRateLimitSamples, type AccountIdentity, type RateLimitSample } from '../modules/mailbox/index.js';
import { type AppServer, type JsonRpcNotification, readCodexAccountRateLimits } from './codex-app-server.js';
import {
  CODEX_RATE_LIMITS_UPDATED_METHOD,
  type CodexRateLimitPark,
  type CodexRateLimitSnapshot,
  type CodexRateLimitsReadResponse,
  classifyCodexRateLimitWindows,
  codexSnapshotToSamples,
  codexTurnRateLimit,
  decideCodexRateLimitPark,
  mergeCodexRateLimitSnapshot,
  parseCodexRateLimitsUpdated,
  readCodexAccountIdFromAuthJson,
} from './codex-rate-limits.js';

/**
 * Re-read cadence when no push has refreshed the snapshot — same interval as
 * Claude's `USAGE_PULL_MIN_INTERVAL_MS`. Checked before each turn; the read
 * is awaited (bounded below) because the park decision needs it BEFORE the
 * turn starts to be worth anything.
 */
export const CODEX_RATE_LIMITS_REFRESH_MS = 5 * 60_000;
/** Deadline for one read. Same reasoning as claude.ts's `USAGE_PULL_TIMEOUT_MS`. */
export const CODEX_RATE_LIMITS_READ_TIMEOUT_MS = 10_000;

export interface CodexRateLimitTrackerDeps {
  read: (server: AppServer, timeoutMs: number) => Promise<CodexRateLimitsReadResponse>;
  readAuthJson: (codexHome: string) => string | null;
  record: (samples: RateLimitSample[]) => void;
  log: (msg: string) => void;
  now: () => number;
  readTimeoutMs: number;
  refreshMs: number;
}

function defaultReadAuthJson(codexHome: string): string | null {
  try {
    return fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf-8');
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: CodexRateLimitTrackerDeps = {
  read: readCodexAccountRateLimits,
  readAuthJson: defaultReadAuthJson,
  record: recordRateLimitSamples,
  log: (msg) => console.error(`[codex-rate-limits] ${msg}`),
  now: () => Date.now(),
  readTimeoutMs: CODEX_RATE_LIMITS_READ_TIMEOUT_MS,
  refreshMs: CODEX_RATE_LIMITS_REFRESH_MS,
};

export class CodexRateLimitTracker {
  private readonly deps: CodexRateLimitTrackerDeps;
  private server: AppServer | null = null;
  private handler: ((n: JsonRpcNotification) => void) | null = null;
  private snapshot: CodexRateLimitSnapshot | null = null;
  private who: AccountIdentity = { account: null, credentialSet: null, lane: null };
  private lastReadAt = 0;
  /** Telemetry only: pushes never advance `lastReadAt` (see `onNotification`). */
  private lastPushAt = 0;
  /**
   * Monotonic push counter. `read()` captures it before its await and
   * compares after: a push that lands mid-read is newer than the read's
   * answer, so the answer is discarded rather than overwriting the merge.
   */
  private pushSeq = 0;
  private readInFlight: Promise<void> | null = null;

  constructor(deps: Partial<CodexRateLimitTrackerDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** The held snapshot (read merged with every push since). Test/diagnostic surface. */
  get current(): CodexRateLimitSnapshot | null {
    return this.snapshot;
  }

  /** Who the samples are about. `account` is the ChatGPT account id; see `bind`. */
  get identity(): AccountIdentity {
    return this.who;
  }

  /** Clock of the last push merged (0 = none). Telemetry/diagnostic surface. */
  get lastPushMs(): number {
    return this.lastPushAt;
  }

  /**
   * Attach to a freshly initialized app-server and pull once. Called at every
   * server (re)spawn in codex.ts's gen() — initial, control-plane replacement,
   * primary-auth refresh and OAuth-home rotation — because each is a new
   * process and a rotation is a new ACCOUNT: the prior snapshot describes the
   * account we just left, so it is dropped rather than merged into.
   *
   * `credentialSet` names the CODEX_HOME slot the reading came from
   * (`codex:.codex` = primary, `codex:.codex-fallback-N` = a declared
   * fallback), the Codex analogue of Claude's `global`/`group:<folder>`:
   * with it a reader can tell which of a group's identities is being drained.
   * `account` is the ChatGPT account id — `accountId` from the read when the
   * backend supplies it, else `tokens.account_id` from that home's auth.json.
   * Unlike Claude's slot names it is globally unique, so the pair caveat on
   * RATE_LIMIT_SAMPLES_DDL does not bite here.
   */
  async bind(server: AppServer, codexHome: string): Promise<void> {
    this.detach();
    this.server = server;
    this.snapshot = null;
    this.lastReadAt = 0;
    this.who = {
      account: readCodexAccountIdFromAuthJson(this.deps.readAuthJson(codexHome)),
      credentialSet: `codex:${path.basename(codexHome)}`,
      lane: null,
    };
    this.handler = (n) => this.onNotification(n);
    server.notificationHandlers.push(this.handler);
    await this.read();
  }

  /** Remove the push subscription from the current server (idempotent). */
  detach(): void {
    if (this.server && this.handler) {
      const idx = this.server.notificationHandlers.indexOf(this.handler);
      if (idx >= 0) this.server.notificationHandlers.splice(idx, 1);
    }
    this.server = null;
    this.handler = null;
  }

  /**
   * Re-pull when the last FULL read is older than the refresh interval. Pushes
   * deliberately do not reset this clock: they are sparse, so fields a push
   * omits — a window, `rateLimitReachedType`, `credits` — only ever refresh
   * through a full read, and a steady push stream must not starve it.
   */
  async refreshIfStale(): Promise<void> {
    if (!this.server) return;
    if (this.deps.now() - this.lastReadAt < this.deps.refreshMs) return;
    await this.read();
  }

  parkDecision(): CodexRateLimitPark | null {
    return decideCodexRateLimitPark(this.snapshot);
  }

  turnRateLimit(): { type: string | null; utilization: number | null; resetsAt: string | null } | null {
    return codexTurnRateLimit(this.snapshot);
  }

  private async read(): Promise<void> {
    if (!this.server) return;
    if (this.readInFlight) return this.readInFlight;
    const server = this.server;
    // Advance BEFORE awaiting so a slow read cannot stack a second one.
    this.lastReadAt = this.deps.now();
    // Check-then-act across the await: the snapshot this answer will replace
    // is the one held NOW; a push merged during the await is newer than the
    // answer, so the answer must not win (review round 1 on #812).
    const seq = this.pushSeq;
    this.readInFlight = (async () => {
      try {
        const res = await this.deps.read(server, this.deps.readTimeoutMs);
        if (this.server !== server) return; // rebound mid-read: the answer is about the old server's account
        if (this.pushSeq !== seq) {
          // The push already updated state and recorded its rows; sampling
          // this older full response would write stale numbers and could
          // flip the park decision back. The next cadence read re-fetches
          // whatever the push omitted.
          this.deps.log('read superseded by push, discarding');
          return;
        }
        if (res.accountId) this.who = { ...this.who, account: res.accountId };
        this.snapshot = res.rateLimits;
        this.logAssumedWindows(res.rateLimits, 'read');
        if (res.rateLimitsByLimitId && Object.keys(res.rateLimitsByLimitId).length > 0) {
          // Multi-bucket view keyed by metered limit_id. Logged, not modelled
          // (plan item 0.7): nothing reads it until a bucket other than the
          // default one is observed in production.
          this.deps.log(`rateLimitsByLimitId (debug): ${JSON.stringify(res.rateLimitsByLimitId).slice(0, 2000)}`);
        }
        this.deps.record(codexSnapshotToSamples(res.rateLimits, this.who, 'usage_pull'));
        const park = this.parkDecision();
        if (park) this.deps.log(`park condition after read: ${park.message}`);
      } catch (err) {
        this.deps.log(
          `rate-limit read failed (telemetry only, not sampled): ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.readInFlight = null;
      }
    })();
    return this.readInFlight;
  }

  private onNotification(n: JsonRpcNotification): void {
    if (n.method !== CODEX_RATE_LIMITS_UPDATED_METHOD) return;
    const update = parseCodexRateLimitsUpdated(n.params);
    if (!update) return;
    this.pushSeq += 1;
    this.snapshot = mergeCodexRateLimitSnapshot(this.snapshot, update);
    // Not `lastReadAt`: full reads run on their own clock (see refreshIfStale).
    this.lastPushAt = this.deps.now();
    this.logAssumedWindows(update, 'push');
    // The row records what THIS push said (sparse: only the windows it
    // carried), attributed with the plan the merged snapshot knows.
    const rows = codexSnapshotToSamples(update, this.who, 'rate_limit_event').map((r) => ({
      ...r,
      subscriptionType: r.subscriptionType ?? this.snapshot?.planType ?? null,
    }));
    this.deps.record(rows);
    const park = this.parkDecision();
    if (park) this.deps.log(`park condition after push: ${park.message}`);
  }

  private logAssumedWindows(snapshot: CodexRateLimitSnapshot, via: 'read' | 'push'): void {
    for (const w of classifyCodexRateLimitWindows(snapshot)) {
      if (w.assumed) {
        this.deps.log(
          `windowDurationMins missing on ${via}; assumed ${w.limitType} from position (usedPercent=${w.usedPercent})`,
        );
      }
    }
  }
}
