/**
 * Workgroup FS reconciliation — runs once at host startup AFTER runMigrations.
 *
 * Responsibilities:
 * 1. Drain `_migration036_report` temp table (if present) into:
 *    - logs/migration-036.log (pairings, standalone, suffix_strip_unmatched)
 *    - logs/migration-036-secrets.log (per-workgroup intersection of member secrets)
 *    Then DROP the temp table.
 * 2. Guarantee the shared work-product directory, and each member's compat
 *    link to it, for every workgroup whose `/workspace/workgroup` mount is
 *    actually made (`ensureWorkgroupWorkDirs` applies the mount's own
 *    predicate per workgroup; a link to an unmounted target is worse than no
 *    link).
 * Idempotent — re-running on already-reconciled state is a no-op. On FS failure, throws
 * (caller in src/index.ts logs and exits process.exit(1)).
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { readContainerConfig } from '../../container-config.js';
import { ensureWorkgroupWorkDirs, pruneDanglingWorkgroupCompatLinks } from './shared-dirs.js';

export function reconcileWorkgroupFsState(db: Database.Database): void {
  // ── 1. Drain migration-036 report if present ──────────────────────────
  const reportTableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migration036_report'`)
    .get() as { name: string } | undefined;

  if (reportTableExists) {
    const reportRow = db.prepare(`SELECT report FROM _migration036_report LIMIT 1`).get() as
      | { report: string }
      | undefined;

    if (reportRow) {
      // mkdirSync before writeFileSync — let FS errors propagate to the caller
      fs.mkdirSync(path.join('logs'), { recursive: true });

      fs.writeFileSync(path.join('logs', 'migration-036.log'), reportRow.report + '\n');

      // Compute per-workgroup intersection of member onecliSecrets (S10)
      const secretsReport = computeDuplicateSecretsReport(db);
      fs.writeFileSync(path.join('logs', 'migration-036-secrets.log'), JSON.stringify(secretsReport, null, 2) + '\n');
    }

    // DROP only after both writes succeed (so a partial failure leaves the table intact)
    db.prepare(`DROP TABLE _migration036_report`).run();
    log.info('reconcileWorkgroupFsState: drained migration-036 report');
  }

  // ── 2. Shared work-product directory + per-member compat links ─────────
  // Runs on every boot, unlike the one-time report drain above: a workgroup or
  // member added since the last boot needs it. Which workgroups it acts on is
  // decided inside, by the mount predicate. One member losing a race, or one
  // unusable workgroup row, warns and is skipped rather than stopping the host
  // booting. The one uncontained throw is the workgroups enumeration itself:
  // an unreadable central DB is fail-closed here, exactly as it is for step 1.
  ensureWorkgroupWorkDirs(db);

  // ── 3. Prune compat links whose shared target is gone ──────────────────
  // Order is NOT load-bearing between steps 2 and 3, and two earlier attempts
  // to say why it was were both wrong. Step 3 requires the `.migrated` marker,
  // which lives inside the shared tree, so it acts only where that tree
  // already exists — nothing step 2 creates can change its answer, and the one
  // name step 2 adds (`artifacts`) is reserved and never considered. Kept in
  // this order only so a boot's shared-tree writes precede its reads.
  //
  // Step 3 is NOT the boot's last writer to the shared tree:
  // this whole function runs at src/main.ts:683, and runBootMountQuiescence at
  // :693 then calls reconcileWorkgroupSharedDirs (:515) and the memory gate
  // (:521), both of which add names after this prune has read its listing.
  // That is safe for two separate reasons, not one — `memory` and `artifacts`
  // are held by RESERVED_SHARED_DIR_NAMES and never considered here, and
  // migrateWorkgroup writes a name's shared entry before its compat link
  // (shared-dirs.ts:723/:731 precede :742), so a link this prune could see can
  // never be newer than its target. Contained the same way as step 2 — a
  // workgroup whose shared tree cannot be listed prunes nothing.
  pruneDanglingWorkgroupCompatLinks(db);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * For each workgroup with >1 member, compute the intersection of member
 * `onecliSecrets` arrays. The result surfaces secrets that every member
 * already has declared, which may indicate they should be promoted to
 * workgroup-level secret config instead.
 */
function computeDuplicateSecretsReport(db: Database.Database): Array<{ workgroup: string; intersection: string[] }> {
  const workgroups = db.prepare(`SELECT id FROM workgroups`).all() as Array<{ id: string }>;
  const report: Array<{ workgroup: string; intersection: string[] }> = [];

  for (const wg of workgroups) {
    const members = db.prepare(`SELECT folder FROM agent_groups WHERE workgroup_id = ?`).all(wg.id) as Array<{
      folder: string;
    }>;

    if (members.length <= 1) continue;

    let intersection: Set<string> | undefined;
    for (const m of members) {
      let cfg;
      try {
        cfg = readContainerConfig(m.folder);
      } catch {
        continue;
      }
      const secrets = new Set<string>(cfg.onecliSecrets ?? []);
      if (intersection === undefined) {
        intersection = secrets;
      } else {
        const prev = intersection;
        intersection = new Set<string>([...prev].filter((s) => secrets.has(s)));
      }
    }

    if (intersection !== undefined && intersection.size > 0) {
      report.push({ workgroup: wg.id, intersection: Array.from(intersection) });
    }
  }

  return report;
}
