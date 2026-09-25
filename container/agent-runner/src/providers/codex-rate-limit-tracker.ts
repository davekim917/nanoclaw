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
 * Failure policy: a read that errors or exceeds its deadline is NOT SAMPLED
 * (no row, no park) and logged; it never fails or delays the turn beyond the
 * deadline. The systemError park in the poll-loop / host remains the fallback
 * for a session whose read never answers.
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
  codexRateLimitSnapshotUpdatedKeys,
  codexSnapshotToSamples,
  codexTurnRateLimit,
  decideCodexRateLimitPark,
  mergeCodexRateLimitSnapshot,
  parseCodexRateLimitsUpdated,
  readCodexAccountIdFromAuthJson,
} from './codex-rate-limits.js';

/**
 * Re-read cadence when no push has refreshed the snapshot. Checked before each
 * turn; the read is awaited (bounded below) because the park decision needs it
 * BEFORE the turn starts to be worth anything.
 */
const CODEX_RATE_LIMITS_REFRESH_MS = 5 * 60_000;
/** Deadline for one read, so a read that never answers cannot hold the turn. */
const CODEX_RATE_LIMITS_READ_TIMEOUT_MS = 10_000;

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
   * Monotonic push counter, source for `fieldPushSeq` below. Not read
   * directly by `read()` any more — round 2 fix: a single scalar seq made
   * `read()` discard the WHOLE response when ANY field had an intervening
   * push, even an unrelated one (e.g. a sparse primary-only push would
   * blank out a read's fresh secondary=96% reading and leave it unchecked
   * for the next 5-minute cadence). Per-field tracking below fixes that.
   */
  private pushSeq = 0;
  /**
   * Per-field push freshness: `fieldPushSeq[key]` is the `pushSeq` value at
   * the last push that actually set `key` (see
   * `codexRateLimitSnapshotUpdatedKeys` for which keys a given update
   * touches). `read()` snapshots this map before its await and, per field,
   * keeps the read's answer only where the map is unchanged after —
   * i.e. no push touched that specific field while the read was in flight.
   */
  private fieldPushSeq: Partial<Record<keyof CodexRateLimitSnapshot, number>> = {};
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
    this.fieldPushSeq = {};
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
    // Check-then-act across the await, per FIELD: a
    // whole-snapshot seq made the read discard EVERY field when ANY one had
    // an intervening push, e.g. a sparse primary-only push would blank out
    // the read's own fresh secondary reading and leave it unchecked for a
    // full cadence interval. Snapshot each field's push-freshness marker now;
    // after the await, a field wins from the read unless ITS marker moved.
    const seqAtStart = { ...this.fieldPushSeq };
    this.readInFlight = (async () => {
      try {
        const res = await this.deps.read(server, this.deps.readTimeoutMs);
        if (this.server !== server) return; // rebound mid-read: the answer is about the old server's account
        const merged: CodexRateLimitSnapshot = { ...(this.snapshot ?? {}) };
        let supersededAny = false;
        for (const key of Object.keys(res.rateLimits) as (keyof CodexRateLimitSnapshot)[]) {
          if (this.fieldPushSeq[key] !== seqAtStart[key]) {
            // A push set THIS field while the read was in flight; the push's
            // value (already merged into this.snapshot) is newer than the
            // read's answer for it, so keep it — don't let the read blank
            // out or roll back a field it wasn't asking about.
            supersededAny = true;
            continue;
          }
          (merged as Record<string, unknown>)[key] = res.rateLimits[key];
        }
        if (supersededAny) {
          this.deps.log('read partially superseded by an intervening push; kept the push-updated field(s)');
        }
        if (res.accountId) this.who = { ...this.who, account: res.accountId };
        this.snapshot = merged;
        this.logAssumedWindows(merged, 'read');
        if (res.rateLimitsByLimitId && Object.keys(res.rateLimitsByLimitId).length > 0) {
          // Multi-bucket view keyed by metered limit_id. Logged, not modelled
          // (plan item 0.7): nothing reads it until a bucket other than the
          // default one is observed in production.
          this.deps.log(`rateLimitsByLimitId (debug): ${JSON.stringify(res.rateLimitsByLimitId).slice(0, 2000)}`);
        }
        // Sampled from the resolved (post-merge) snapshot, not the raw
        // response: a superseded field's row then carries the push's own
        // value (already recorded once as rate_limit_event) rather than a
        // stale pre-push number — redundant at worst, never wrong.
        this.deps.record(codexSnapshotToSamples(merged, this.who, 'usage_pull'));
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
    // Stamp only the fields THIS push actually sets — same eligibility rule
    // `mergeCodexRateLimitSnapshot` uses, so a read in flight can tell a
    // push that touched, say, `primary` from one that didn't.
    for (const key of codexRateLimitSnapshotUpdatedKeys(update)) this.fieldPushSeq[key] = this.pushSeq;
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
