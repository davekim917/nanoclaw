/**
 * Workgroup FS reconciliation — runs once at host startup AFTER runMigrations.
 *
 * Responsibilities:
 * 1. Drain `_migration036_report` temp table (if present) into:
 *    - logs/migration-036.log (pairings, standalone, suffix_strip_unmatched)
 *    - logs/migration-036-secrets.log (per-workgroup intersection of member secrets)
 *    Then DROP the temp table.
 * 2. For each agent_groups row where `workgroup_id !== folder` (auto-paired sibling),
 *    write `recall_scope: 'workgroup'` to container.json's memory block if not already set.
 *    Standalone groups (workgroup_id === folder) are untouched.
 *
 * Idempotent — re-running on already-reconciled state is a no-op. On FS failure, throws
 * (caller in src/index.ts logs and exits process.exit(1)).
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { readContainerConfig, writeContainerConfig } from '../../container-config.js';

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

  // ── 2. Write recall_scope: 'workgroup' to paired groups' container.json ──
  const rows = db.prepare(`SELECT id, folder, workgroup_id FROM agent_groups`).all() as Array<{
    id: string;
    folder: string;
    workgroup_id: string | null;
  }>;

  for (const ag of rows) {
    // Skip standalone groups (workgroup_id === folder) and null workgroup_id rows
    if (!ag.workgroup_id || ag.workgroup_id === ag.folder) continue;

    let cfg;
    try {
      cfg = readContainerConfig(ag.folder);
    } catch (err) {
      log.warn('reconcileWorkgroupFsState: could not read container.json', { folder: ag.folder, err });
      continue;
    }

    // Already set — skip (idempotent)
    if (cfg.memory?.recall_scope === 'workgroup') continue;

    cfg.memory = { ...(cfg.memory ?? { enabled: true }), recall_scope: 'workgroup' };
    writeContainerConfig(ag.folder, cfg);
    log.info('reconcileWorkgroupFsState: wrote recall_scope=workgroup', { folder: ag.folder });
  }
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
