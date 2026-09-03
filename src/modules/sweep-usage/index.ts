/**
 * Sweep family: usage rollup (seam 2, S2-PR12 — plan.md §5 "S2-PR12 usage
 * rollup (G22)", §8 "S2-PR12 — usage rollup"). Registers T19 (usage-rollup)
 * on `tick:post-session` at order 40 — reuses the tick's own `ctx.sessions`
 * (constraint 4), no extra `getActiveSessions()` call.
 *
 * Moved from src/host-sweep.ts UNCHANGED (cut/paste, same statements, same
 * log strings, same thresholds, same helper calls), and carrying mailbox PR 7's
 * shape for the read: `readSessionOutbound` is the module's OUTBOUND read
 * session, which exposes exactly the `listTurnUsageSince` op
 * `rollupSessionUsage` asks for (mailbox seam PR 6).
 *
 * Deliberately NOT routed through a mailbox session (`withExistingNanoclawSession`):
 * this projection touches outbound.db only, and the seam's existence check is
 * keyed on inbound.db — routing it through a session would add a gate the
 * pre-seam code never had, so a session whose inbound.db is gone while
 * outbound.db remains would stop being rolled up at all, and its turn_usage
 * rows would never reach the central totals (constraint 21). `outPath`'s own
 * `fs.statSync` is the only gate that belongs here: no outbound file, no
 * rollup.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { rollupSessionUsage, pruneOldTurnUsage } from '../../db/usage.js';
import type { Session } from '../../types.js';
import { readSessionOutbound, sessionMailboxPath } from '../mailbox/index.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

const id = SWEEP_DUTY_INVENTORY;

// Per-session cache of the outbound.db mtime last successfully rolled up, so
// a session whose outbound.db hasn't changed since the last tick costs one
// fs.statSync and nothing else — no DB open, no query. Same shape as
// host-sweep.ts's `quietSessions` cache (module-level Map, bounded to
// sessions still active). Lost on host restart, which just means the next
// tick re-checks every session once; rollupSessionUsage's own watermark still
// guarantees no double-counting either way.
const usageRollupMtimeCache = new Map<string, number>(); // session.id -> outbound.db mtimeMs

/** Pure so the cache decision has one thing to unit-test. */
export function shouldSkipUsageRollup(cachedMtimeMs: number | undefined, currentMtimeMs: number): boolean {
  return cachedMtimeMs === currentMtimeMs;
}

export async function sweepUsageRollup(sessions: readonly Session[]): Promise<void> {
  for (const session of sessions) {
    try {
      const outPath = sessionMailboxPath({ agentGroupId: session.agent_group_id, sessionId: session.id }, 'outbound');
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(outPath).mtimeMs;
      } catch {
        continue; // container never spawned yet — no outbound.db to roll up
      }
      if (shouldSkipUsageRollup(usageRollupMtimeCache.get(session.id), mtimeMs)) continue;

      // Read through the module's OUTBOUND read session, not a mailbox
      // session. The seam's existence check is keyed on inbound.db, and gating
      // a pure outbound projection on that stranded the turn_usage rows of any
      // session whose inbound.db was gone (mailbox seam PR 5). `outPath` above
      // is already the gate that belongs here: no outbound file, no rollup.
      //
      // The two options restate what the read-write outbound funnel does, so
      // this keeps PR 5's behavior exactly: the write path's 5s busy_timeout,
      // and the hot-journal rollback without which a SIGKILLed container's
      // outbound.db is unreadable forever. `readSessionOutbound` carries the
      // same `assertQueryable` classification, so a present-but-unopenable DB
      // raises SessionDbUnopenableError here just as the opener would — and
      // this loop's own catch below is the per-session error rule that
      // classified it before the seam.
      //
      // `rollupSessionUsage` asks for only the op it uses (mailbox seam PR 6),
      // and the read session exposes exactly that op.
      const rolled = readSessionOutbound(
        { agentGroupId: session.agent_group_id, sessionId: session.id },
        (mailbox) => {
          rollupSessionUsage(mailbox, session.agent_group_id, `${session.agent_group_id}/${session.id}`);
          return true;
        },
        { busyTimeoutMs: 5000, recoverJournal: true },
      );
      // Only a rollup that RAN may claim this mtime as processed.
      if (!rolled) continue;
      usageRollupMtimeCache.set(session.id, mtimeMs);
    } catch (err) {
      log.warn('Usage rollup failed for session', { err, sessionId: session.id });
    }
  }
  // Bound the cache to sessions that still exist, mirroring the quietSessions
  // cleanup in host-sweep.ts — closed sessions would otherwise accumulate
  // forever.
  if (usageRollupMtimeCache.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const sessionId of usageRollupMtimeCache.keys())
      if (!live.has(sessionId)) usageRollupMtimeCache.delete(sessionId);
  }
}

/**
 * Registers T19. A named export, not just an import-time side effect, so it
 * can be handed to `registerSweepDutySource` below — the registry replays
 * every recorded source's registrar on a default (builtins-restoring) test
 * reset, which is what lets this module's duty survive
 * `_resetSweepRegistryForTesting()` in src/host-sweep-registry.test.ts instead
 * of only host-sweep.ts's own in-file builtins coming back.
 */
export function registerUsageSweepDuties(): void {
  registerSweepDuty({
    name: id.T19,
    phase: 'tick:post-session',
    order: 40,
    // Fleet-hardening Phase 0.1 (per-turn usage accounting): roll per-session
    // turn_usage rows into the central usage_daily table for `ncl usage`.
    // Reuses the same `sessions` list the per-session loop above already
    // fetched — no extra DB query. Isolated so a rollup failure never blocks
    // the rest of the tick. `pruneOldTurnUsage` is its companion, not a
    // separate duty: fleet volume is ~300-600 turns/day, so trimming the
    // ledger the rollup just fed is trivial per-tick cost.
    run: async (ctx) => {
      try {
        await sweepUsageRollup(ctx.sessions);
      } catch (err) {
        log.warn('Usage rollup sweep step failed', { err });
      }
      pruneOldTurnUsage();
    },
  });
}

registerSweepDutySource('sweep-usage', registerUsageSweepDuties);
