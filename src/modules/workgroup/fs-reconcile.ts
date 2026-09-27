/**
 * Workgroup FS reconciliation, run at host startup after migrations: drain the
 * migration-036 report table into logs, ensure each workgroup's shared
 * work-product dir and member links, and prune dangling compat links. Only the
 * report drain and the workgroups enumeration throw (the caller exits); the
 * other steps warn and skip per workgroup, so one lost race cannot stop boot.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { readContainerConfig } from '../../container-config.js';
import { ensureWorkgroupWorkDirs, pruneDanglingWorkgroupCompatLinks } from './shared-dirs.js';

export function reconcileWorkgroupFsState(db: Database.Database): void {
  const reportTableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migration036_report'`)
    .get() as { name: string } | undefined;

  if (reportTableExists) {
    const reportRow = db.prepare(`SELECT report FROM _migration036_report LIMIT 1`).get() as
      | { report: string }
      | undefined;

    if (reportRow) {
      fs.mkdirSync(path.join('logs'), { recursive: true });

      fs.writeFileSync(path.join('logs', 'migration-036.log'), reportRow.report + '\n');

      // Per-workgroup intersection of member onecliSecrets.
      const secretsReport = computeDuplicateSecretsReport(db);
      fs.writeFileSync(path.join('logs', 'migration-036-secrets.log'), JSON.stringify(secretsReport, null, 2) + '\n');
    }

    // DROP only after both writes succeed, so a partial failure keeps the table.
    db.prepare(`DROP TABLE _migration036_report`).run();
    log.info('reconcileWorkgroupFsState: drained migration-036 report');
  }

  ensureWorkgroupWorkDirs(db);

  // Not the boot's last writer to the shared tree (the quiescence door later adds
  // names), which is safe: reserved names are never considered here, and the
  // migrator writes a name's shared entry before its compat link, so a link this
  // prune sees is never newer than its target.
  pruneDanglingWorkgroupCompatLinks(db);
}

/**
 * For each workgroup with >1 member, the intersection of member `onecliSecrets`:
 * candidates for promotion to workgroup-level secret config.
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
