/** A read that errors or passes its deadline is not sampled and never delays the turn beyond that deadline. */
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

/** Awaited before a turn once stale: the park decision is only worth anything before the turn starts. */
const CODEX_RATE_LIMITS_REFRESH_MS = 5 * 60_000;
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
  private lastPushAt = 0;
  private pushSeq = 0;
  /** Seq of the last push that set each field; `read()` keeps its answer only for fields no push set mid-read. */
  private fieldPushSeq: Partial<Record<keyof CodexRateLimitSnapshot, number>> = {};
  private readInFlight: Promise<void> | null = null;

  constructor(deps: Partial<CodexRateLimitTrackerDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  get current(): CodexRateLimitSnapshot | null {
    return this.snapshot;
  }

  get identity(): AccountIdentity {
    return this.who;
  }

  /** 0 = no push merged yet. */
  get lastPushMs(): number {
    return this.lastPushAt;
  }

  /**
   * Call at every app-server (re)spawn: a rotated CODEX_HOME is a new account, so the prior snapshot is dropped,
   * not merged into.
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

  detach(): void {
    if (this.server && this.handler) {
      const idx = this.server.notificationHandlers.indexOf(this.handler);
      if (idx >= 0) this.server.notificationHandlers.splice(idx, 1);
    }
    this.server = null;
    this.handler = null;
  }

  /** Pushes do not reset this clock: fields a sparse push omits refresh only through a full read. */
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
    // Per field: after the await, the read's answer loses only for fields a push set meanwhile.
    const seqAtStart = { ...this.fieldPushSeq };
    this.readInFlight = (async () => {
      try {
        const res = await this.deps.read(server, this.deps.readTimeoutMs);
        if (this.server !== server) return; // rebound mid-read: the answer is about the old server's account
        const merged: CodexRateLimitSnapshot = { ...(this.snapshot ?? {}) };
        let supersededAny = false;
        for (const key of Object.keys(res.rateLimits) as (keyof CodexRateLimitSnapshot)[]) {
          if (this.fieldPushSeq[key] !== seqAtStart[key]) {
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
          this.deps.log(`rateLimitsByLimitId (debug): ${JSON.stringify(res.rateLimitsByLimitId).slice(0, 2000)}`);
        }
        // Sample the merged snapshot so a superseded field carries the push's value, not the stale pre-push one.
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
    for (const key of codexRateLimitSnapshotUpdatedKeys(update)) this.fieldPushSeq[key] = this.pushSeq;
    this.snapshot = mergeCodexRateLimitSnapshot(this.snapshot, update);
    // Not `lastReadAt`: full reads run on their own clock (see refreshIfStale).
    this.lastPushAt = this.deps.now();
    this.logAssumedWindows(update, 'push');
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
