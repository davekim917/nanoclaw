/**
 * Usage rollup. Deliberately NOT a provisioning mailbox session: that seam's
 * existence check keys on inbound.db, so a session whose inbound.db is gone
 * but outbound.db remains would never be rolled up. The outbound file's own
 * stat is the gate.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { getUsageWatermark, rollupSessionUsage, pruneOldTurnUsage } from '../../db/usage.js';
import type { Session } from '../../types.js';
import { readSessionOutbound, sessionMailboxPath } from '../mailbox/index.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

const id = SWEEP_DUTY_INVENTORY;

// Skips an unchanged outbound.db at the cost of one stat. Losing it on restart
// is harmless: rollupSessionUsage's watermark prevents double-counting.
const usageRollupMtimeCache = new Map<string, number>(); // session.id -> outbound.db mtimeMs

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

      // `recoverJournal` + 5s busy timeout: without them a session whose
      // container crashed mid-write (hot journal) throws every tick and never
      // advances its watermark. The central transaction runs after the handle
      // closes (the two cannot nest); rollupSessionUsage re-reads the watermark
      // inside it, so a batch read by two sweeps is folded once.
      const sessionDirKey = `${session.agent_group_id}/${session.id}`;
      const watermark = await getUsageWatermark(sessionDirKey);
      const rows = readSessionOutbound(
        { agentGroupId: session.agent_group_id, sessionId: session.id },
        (mailbox) => mailbox.listTurnUsageSince(watermark),
        { busyTimeoutMs: 5000, recoverJournal: true },
      );
      // Only a rollup that RAN may claim this mtime, or an unreadable session
      // would be skipped for as long as its file stays untouched.
      if (rows === undefined) continue;
      await rollupSessionUsage(rows, session.agent_group_id, sessionDirKey);
      usageRollupMtimeCache.set(session.id, mtimeMs);
    } catch (err) {
      log.warn('Usage rollup failed for session', { err, sessionId: session.id });
    }
  }
  // Bound the cache to live sessions.
  if (usageRollupMtimeCache.size > sessions.length + 500) {
    const live = new Set(sessions.map((s) => s.id));
    for (const sessionId of usageRollupMtimeCache.keys())
      if (!live.has(sessionId)) usageRollupMtimeCache.delete(sessionId);
  }
}

function registerUsageSweepDuties(): void {
  registerSweepDuty({
    name: id.T19,
    phase: 'tick:post-session',
    order: 40,
    // Isolated so a rollup failure never blocks the rest of the tick.
    run: async (ctx) => {
      try {
        await sweepUsageRollup(ctx.sessions);
      } catch (err) {
        log.warn('Usage rollup sweep step failed', { err });
      }
      await pruneOldTurnUsage();
    },
  });
}

registerSweepDutySource('sweep-usage', registerUsageSweepDuties);
