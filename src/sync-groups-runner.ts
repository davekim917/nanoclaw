/**
 * Runner for the /sync-groups surface.
 *
 * Thin TS wrapper over scripts/sync-groups/{inspect,sync}.sh so the Discord
 * slash command and the daily drift check can share behavior without
 * reimplementing the classification logic. The scripts are the source of
 * truth — they do the git-history lookups to distinguish stale-trunk from
 * self-mod drift. This module just shells out, parses the JSON, and wires
 * the post-sync container-kill behavior.
 */
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

import { GROUPS_DIR } from './config.js';
import { killContainer, isContainerRunning } from './container-runner.js';
import { log } from './log.js';
import { getSessionsByAgentGroup } from './db/sessions.js';

const execFileAsync = promisify(execFile);

export interface DriftedFile {
  path: string;
  classification: 'stale-trunk' | 'self-mod';
  reason?: string;
}

export interface GroupReport {
  id: string;
  drifted: DriftedFile[];
  in_sync: number;
  total: number;
}

export interface InspectReport {
  groups: GroupReport[];
}

export interface SyncResult {
  synced: string[];
  skipped: string[];
  failed: Array<{ group: string; error: string }>;
  killedContainers: string[];
}

function projectRoot(): string {
  return path.resolve(GROUPS_DIR, '..');
}

function inspectScript(): string {
  return path.join(projectRoot(), 'scripts', 'sync-groups', 'inspect.sh');
}

function syncScript(): string {
  return path.join(projectRoot(), 'scripts', 'sync-groups', 'sync.sh');
}

export async function runInspect(): Promise<InspectReport> {
  const { stdout } = await execFileAsync('bash', [inspectScript()], {
    cwd: projectRoot(),
    timeout: 60_000,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as InspectReport;
}

/** Classify each group: clean (all stale-trunk), dirty (has self-mods), or in-sync. */
function classifyGroup(g: GroupReport): 'in-sync' | 'clean' | 'dirty' {
  if (g.drifted.length === 0) return 'in-sync';
  return g.drifted.some((f) => f.classification === 'self-mod') ? 'dirty' : 'clean';
}

/**
 * Apply syncs to every group that is drifted-and-eligible. "Eligible" means:
 *   - clean (only stale-trunk drift), or
 *   - dirty but force=true.
 * After each successful sync, kill any running container for that group so
 * the next inbound message respawns it with fresh source. The image is not
 * rebuilt — agent-runner is bind-mounted from the per-group overlay, and
 * bun imports TS directly.
 */
export async function runSync(report: InspectReport, opts: { force: boolean }): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], failed: [], killedContainers: [] };

  for (const g of report.groups) {
    const klass = classifyGroup(g);
    if (klass === 'in-sync') continue;
    if (klass === 'dirty' && !opts.force) {
      result.skipped.push(g.id);
      continue;
    }

    const args = [syncScript(), g.id];
    if (opts.force) args.push('--force');
    try {
      await execFileAsync('bash', args, { cwd: projectRoot(), timeout: 120_000, encoding: 'utf-8' });
      result.synced.push(g.id);

      // Kill any running container for this group's sessions so the next
      // inbound message respawns with new overlay code. Sessions are
      // looked up via the central DB — we don't iterate the activeContainers
      // map directly because it's keyed by session id, not group id.
      try {
        const sessions = getSessionsByAgentGroup(g.id);
        for (const s of sessions) {
          if (isContainerRunning(s.id)) {
            killContainer(s.id, '/sync-groups: overlay updated, restart to pick up new code');
            result.killedContainers.push(s.id);
          }
        }
      } catch (err) {
        log.warn('sync-groups: failed to kill containers for synced group', { group: g.id, err });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failed.push({ group: g.id, error: msg.slice(0, 200) });
    }
  }

  return result;
}

export function formatInspectReport(report: InspectReport, opts: { includeRecommendation: boolean }): string {
  const lines: string[] = [];
  let totalDrifted = 0;
  let anyDirty = false;
  for (const g of report.groups) {
    const klass = classifyGroup(g);
    if (klass === 'in-sync') {
      lines.push(`✓ \`${g.id}\` — in sync (${g.in_sync}/${g.total})`);
      continue;
    }
    const stale = g.drifted.filter((f) => f.classification === 'stale-trunk').length;
    const selfmod = g.drifted.filter((f) => f.classification === 'self-mod').length;
    if (selfmod > 0) anyDirty = true;
    totalDrifted += g.drifted.length;
    const parts = [`**\`${g.id}\`** — ${g.drifted.length} drifted`];
    if (stale > 0) parts.push(`${stale} stale-trunk`);
    if (selfmod > 0) parts.push(`${selfmod} self-mod ⚠️`);
    lines.push(parts.join(' · '));
    for (const f of g.drifted.slice(0, 10)) {
      lines.push(`    ${f.classification === 'self-mod' ? '⚠️' : '·'} ${f.path}`);
    }
    if (g.drifted.length > 10) lines.push(`    … +${g.drifted.length - 10} more`);
  }

  if (opts.includeRecommendation) {
    if (totalDrifted === 0) {
      lines.push('', 'All groups in sync with trunk. No action needed.');
    } else if (anyDirty) {
      lines.push(
        '',
        `Drift detected. Run \`/sync-groups mode:apply\` to sync stale-trunk groups, or \`/sync-groups mode:apply-force\` to also overwrite self-modified files.`,
      );
    } else {
      lines.push('', `Drift detected (all stale-trunk). Run \`/sync-groups mode:apply\` to sync.`);
    }
  }

  return lines.join('\n');
}
