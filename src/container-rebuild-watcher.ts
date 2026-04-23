/**
 * Container rebuild watcher.
 *
 * Polls GitHub for merged PRs that touch `container/` and runs
 * `git pull && ./container/build.sh v2` each time it sees a new merge.
 * Posts a completion message to an optional Discord channel.
 *
 * Replaces v1's daily `nanoclaw-update.timer` rebuild path: the timer-based
 * flow rebuilds up to 24h after a PR merges; this watcher rebuilds within
 * one poll interval. Triggered by `/update-container` (agent opens PR) or
 * any other path that lands a container-touching PR on main — the watcher
 * is merge-source-agnostic.
 *
 * Cursor (last-processed PR number) persists to data/container-rebuild-cursor.json
 * so restarts don't re-rebuild already-handled merges.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const CURSOR_PATH = path.join(DATA_DIR, 'container-rebuild-cursor.json');
const POLL_MS = 60_000;
const REPO_ROOT = path.resolve(GROUPS_DIR, '..');

type Notifier = (message: string) => Promise<void>;

interface Cursor {
  lastMergedPrNumber: number;
  lastRebuildAt: string | null;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let notify: Notifier | null = null;

function readCursor(): Cursor {
  try {
    const raw = fs.readFileSync(CURSOR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Cursor;
    if (typeof parsed.lastMergedPrNumber === 'number') return parsed;
  } catch {
    /* fall through */
  }
  return { lastMergedPrNumber: 0, lastRebuildAt: null };
}

function writeCursor(cursor: Cursor): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
  } catch (err) {
    log.warn('Failed to persist container-rebuild cursor', { err });
  }
}

interface MergedPr {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

/**
 * List recently-merged PRs that touch `container/`. We filter with
 * `--search path:container/` so GitHub only returns PRs whose diff touches
 * that directory — avoids rebuilding on every merge to main.
 */
async function listMergedContainerPrs(sinceNumber: number): Promise<MergedPr[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--search',
        'path:container/',
        '--json',
        'number,title,url,mergedAt',
        '--limit',
        '20',
      ],
      { cwd: REPO_ROOT, timeout: 30_000 },
    );
    const all = JSON.parse(stdout) as MergedPr[];
    // gh returns newest-first. Keep ones strictly above the cursor, oldest-first
    // so we rebuild in merge order if multiple stacked up during downtime.
    return all.filter((p) => p.number > sinceNumber).sort((a, b) => a.number - b.number);
  } catch (err) {
    log.warn('gh pr list failed in container-rebuild-watcher', { err });
    return [];
  }
}

async function pullAndBuild(pr: MergedPr): Promise<{ ok: boolean; detail: string }> {
  try {
    await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], {
      cwd: REPO_ROOT,
      timeout: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `git pull failed: ${msg.slice(0, 300)}` };
  }

  try {
    await execFileAsync('bash', [path.join(REPO_ROOT, 'container', 'build.sh'), 'v2'], {
      cwd: REPO_ROOT,
      timeout: 900_000,
    });
    return { ok: true, detail: `PR #${pr.number} merged → image rebuilt` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `build.sh failed: ${msg.slice(0, 500)}` };
  }
}

async function tick(): Promise<void> {
  if (running) return; // previous tick still building
  running = true;
  try {
    const cursor = readCursor();
    const prs = await listMergedContainerPrs(cursor.lastMergedPrNumber);
    if (prs.length === 0) return;

    log.info('Container-touching PR merged — rebuilding', {
      count: prs.length,
      numbers: prs.map((p) => p.number),
    });

    for (const pr of prs) {
      const result = await pullAndBuild(pr);
      const prefix = result.ok ? '✅' : '❌';
      const message = `${prefix} ${pr.title} (#${pr.number})\n${result.detail}\n${pr.url}`;
      log.info('Container rebuild result', {
        pr: pr.number,
        ok: result.ok,
        detail: result.detail,
      });
      if (notify) {
        try {
          await notify(message);
        } catch (err) {
          log.warn('Container-rebuild watcher notify failed', { err });
        }
      }
      // Advance cursor even on build failure — we don't want to retry a
      // broken Dockerfile in a tight loop. Dave sees the failure and fixes
      // forward with another PR.
      writeCursor({
        lastMergedPrNumber: pr.number,
        lastRebuildAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.error('Container-rebuild watcher tick failed', { err });
  } finally {
    running = false;
  }
}

export function startContainerRebuildWatcher(notifier?: Notifier): void {
  if (timer) return;
  notify = notifier ?? null;
  // First tick in 30s (let the service finish booting), then every POLL_MS.
  timer = setTimeout(function loop() {
    void tick().finally(() => {
      timer = setTimeout(loop, POLL_MS);
    });
  }, 30_000);
  log.info('Container-rebuild watcher started', { pollMs: POLL_MS, cursorPath: CURSOR_PATH });
}

export function stopContainerRebuildWatcher(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  notify = null;
}
