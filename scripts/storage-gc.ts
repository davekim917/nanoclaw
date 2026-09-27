/**
 * Storage GC: reports only unless NANOCLAW_STORAGE_GC=apply is set. Kept out of the host process:
 * a pass is minutes of synchronous work that would stall message routing.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runStorageGcOnce, type GcCategory } from '../src/worktree-cleanup.js';

await initDb(path.join(DATA_DIR, 'v2.db'));

const report = await runStorageGcOnce();
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

if (!report.ran) {
  console.error('storage GC DID NOT RUN — session inventory unavailable, nothing was evaluated');
  process.exit(1);
}

console.log(`storage GC ran (${report.mode}): examined ${report.examined}, collected ${report.collected}`);
for (const category of Object.keys(report.reclaimableBytes) as GcCategory[]) {
  console.log(`  reclaimable ${category}: ${gb(report.reclaimableBytes[category])}`);
}
console.log('  skips:');
for (const [reason, count] of Object.entries(report.skips).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(5)}  ${reason}`);
}
for (const candidate of report.candidates.filter((entry) => entry.collect)) {
  console.log(
    `  ${report.mode === 'apply' ? 'collected' : 'would collect'} [${candidate.category}] ${gb(candidate.bytes).padStart(9)}  ${candidate.path}`,
  );
}
