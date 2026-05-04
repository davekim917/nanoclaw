import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../db/migrations/019-mnemon-ingest-db.js';
import { HealthRecorder } from './health.js';
import { setDeadLettersDb, getDueRetries, deleteAfterSuccess } from './dead-letters.js';
import { runChatStreamSweep, setIngestDb } from './classifier.js';
import { SourceIngester, setIngestDb as setSourceIngestDb } from './source-ingest.js';
import { readContainerConfig } from '../container-config.js';
import { GROUPS_DIR, CC_PROJECTS_DIR, CC_MEMORY_MARKER } from '../config.js';
import type { MemoryStore } from '../modules/memory/store.js';

const SWEEP_INTERVAL_MS = 60_000;

export interface DiscoveredGroup {
  agentGroupId: string;
  folder: string;
  // Absolute path to the directory that contains `sources/`. For
  // GROUPS_DIR-discovered groups this is `<GROUPS_DIR>/<folder>`. For
  // CC-discovered groups this is `<CC_PROJECTS_DIR>/<slug>`. Consumers compute
  // inbox / processed paths from this base.
  sourcesBasePath: string;
  enabled: boolean;
}

function discoverMemoryGroups(health?: HealthRecorder): DiscoveredGroup[] {
  const groups: DiscoveredGroup[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(GROUPS_DIR);
    // Successful re-read clears any prior groups-dir failure so the operator
    // can see "transient error → recovered" in memory-health.json instead of
    // a stale failure counter.
    health?.clearMemoryEnabledCheckFailure('__groups_dir__');
  } catch (err) {
    console.warn('[memory-daemon] failed to read groups dir:', err);
    // Emit health signal with a synthetic group key so the failure is visible
    // in memory-health.json even when we can't enumerate group IDs.
    health?.recordMemoryEnabledCheckFailure('__groups_dir__', String(err));
    return groups;
  }

  for (const entry of entries) {
    const fullPath = path.join(GROUPS_DIR, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    let config;
    try {
      config = readContainerConfig(entry);
    } catch (err) {
      console.warn(`[memory-daemon] failed to read container config for ${entry}:`, err);
      health?.recordMemoryEnabledCheckFailure(entry, String(err));
      continue;
    }

    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) continue;

    // Only clear the failure once we've confirmed the config is actually
    // valid (has agentGroupId). readContainerConfig swallows malformed JSON
    // and returns an empty config, so a clean throwless return doesn't
    // necessarily mean the file is recovered — it could just be empty.
    health?.clearMemoryEnabledCheckFailure(entry);

    groups.push({
      agentGroupId,
      folder: entry,
      sourcesBasePath: fullPath,
      enabled: config.memory?.enabled === true,
    });
  }

  // Drop stale entries for groups that no longer exist on disk. The per-loop
  // clear above doesn't fire for deleted entries (the loop never visits them).
  health?.pruneMemoryEnabledCheckFailures(new Set(entries));

  // CC-side discovery: walk ~/.claude/projects/<slug>/ for `.memory-enabled`
  // markers. Each marked project becomes a discovered group with agentGroupId
  // `cc-<slug>` and per-project store at the same name. CC sessions opt in by
  // dropping the marker (the CC hooks at ~/.claude/hooks/cc-mnemon/ create it
  // on first turn for default-on behavior). Discovery is best-effort — a
  // missing CC_PROJECTS_DIR is normal on hosts that don't run CC.
  let ccEntries: string[] = [];
  try {
    ccEntries = fs.readdirSync(CC_PROJECTS_DIR);
  } catch {
    return groups;
  }
  for (const entry of ccEntries) {
    const projectPath = path.join(CC_PROJECTS_DIR, entry);
    try {
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const markerPath = path.join(projectPath, CC_MEMORY_MARKER);
    if (!fs.existsSync(markerPath)) continue;
    groups.push({
      agentGroupId: `cc-${entry}`,
      folder: entry,
      sourcesBasePath: projectPath,
      enabled: true,
    });
  }

  return groups;
}

async function runSweep(ingester: SourceIngester, health: HealthRecorder, store: MemoryStore): Promise<void> {
  const allGroups = discoverMemoryGroups(health);
  const enabledGroups = allGroups.filter((g) => g.enabled);

  ingester.reconcileWatchers(allGroups);

  await runChatStreamSweep(enabledGroups, store, health);

  for (const group of enabledGroups) {
    const inboxPath = path.join(group.sourcesBasePath, 'sources', 'inbox');
    let files: string[];
    let inboxRealPath: string;
    try {
      files = fs.readdirSync(inboxPath);
      inboxRealPath = fs.realpathSync(inboxPath);
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(inboxPath, file);
      // lstat (not stat) so we don't follow symlinks. A container with write
      // access to its own sources/inbox could plant a symlink to another
      // group's file or any host-readable path; following it would let the
      // classifier read & extract facts from cross-tenant data.
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      // Require the realpath to stay under the inbox root — defense in depth
      // in case lstat reports false-negative on a hard link or unusual fs.
      let realPath: string;
      try {
        realPath = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      if (!realPath.startsWith(inboxRealPath + path.sep)) continue;
      await ingester.processInboxFile(group.agentGroupId, group.sourcesBasePath, realPath, store, health);
    }
  }

  for (const group of enabledGroups) {
    const due = getDueRetries(group.agentGroupId, new Date());
    for (const retry of due) {
      if (retry.itemType === 'turn-pair') {
        await runChatStreamSweep([group], store, health);
        break;
      } else if (retry.itemType === 'source-file') {
        if (fs.existsSync(retry.itemKey)) {
          await ingester.processInboxFile(group.agentGroupId, group.sourcesBasePath, retry.itemKey, store, health);
        } else {
          // File no longer exists at the recorded path — already moved to
          // processed/ (success or binary-guard skip) or manually removed.
          // Without this clear, the dead_letter row sits forever and the
          // retry loop keeps finding it on every sweep, doing nothing.
          deleteAfterSuccess(retry.itemKey, group.agentGroupId);
        }
      }
    }
  }

  await health.flush();
}

async function main(): Promise<void> {
  // G3 prereq verification
  try {
    execSync('bash scripts/verify-memory-prereqs.sh', { stdio: 'inherit' });
  } catch {
    const scriptExists = fs.existsSync('scripts/verify-memory-prereqs.sh');
    if (scriptExists) {
      console.error('[memory-daemon] prereq verification failed — exiting');
      process.exit(1);
    } else {
      console.warn('[memory-daemon] scripts/verify-memory-prereqs.sh not found — skipping prereq check');
    }
  }

  const db = openMnemonIngestDb();
  runMnemonIngestMigrations(db);

  setIngestDb(db);
  setSourceIngestDb(db);
  setDeadLettersDb(db);

  const health = new HealthRecorder();

  // Lazy import MnemonStore (Group A)
  const { MnemonStore } = await import('../modules/memory/mnemon-impl.js');
  const store = new MnemonStore();

  const ingester = new SourceIngester();
  // Wire the production runtime so the inotify watcher's fast-path can write
  // facts via MemoryStore. Without this, the watcher silently no-ops because
  // its setImmediate callback hits the Database-only test branch.
  ingester.setRuntime(store, health);

  let inFlight = false;
  let shutdownRequested = false;
  // Wake-up handle so SIGTERM can exit the inter-sweep wait without burning
  // up to SWEEP_INTERVAL_MS of TimeoutStopSec budget.
  let wakeWait: (() => void) | null = null;

  async function sweepLoop(): Promise<void> {
    while (!shutdownRequested) {
      inFlight = true;
      try {
        await runSweep(ingester, health, store);
      } catch (err) {
        console.error('[memory-daemon] sweep error:', err);
      } finally {
        inFlight = false;
      }

      if (shutdownRequested) break;

      await new Promise<void>((resolve) => {
        // The timer is intentionally NOT unref'd — it's the daemon's primary
        // event-loop anchor between sweeps. With it unref'd, Node would see
        // no active handles and exit cleanly the moment a sweep returns.
        // This was a long-standing bug: the daemon was exiting after every
        // sweep cycle, surviving only as long as a sweep took to complete.
        // shutdown() wakes this wait early via wakeWait() so SIGTERM still
        // exits within a few hundred ms.
        const timer = setTimeout(() => {
          wakeWait = null;
          resolve();
        }, SWEEP_INTERVAL_MS);
        wakeWait = () => {
          clearTimeout(timer);
          wakeWait = null;
          resolve();
        };
      });
    }
  }

  async function shutdown(): Promise<void> {
    console.log('[memory-daemon] SIGTERM received — waiting for in-flight sweep to complete');
    shutdownRequested = true;
    // Wake the inter-sweep wait so we don't burn up to 60s on TimeoutStopSec.
    if (wakeWait) wakeWait();

    while (inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await ingester.shutdown();
    await health.flush();
    console.log('[memory-daemon] shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown();
  });

  process.on('SIGINT', () => {
    void shutdown();
  });

  console.log('[memory-daemon] starting sweep loop (interval: 60s)');
  await sweepLoop();
}

main().catch((err) => {
  console.error('[memory-daemon] fatal error:', err);
  process.exit(1);
});
