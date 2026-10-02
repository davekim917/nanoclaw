/**
 * Storage GC: reports only unless NANOCLAW_STORAGE_GC=apply is set. Kept out of the host process:
 * a pass is minutes of synchronous work that would stall message routing.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { previewCloneCheckoutCleanup, runStorageGcOnce, type GcCategory } from '../src/worktree-cleanup.js';

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
console.log(
  `  skips (count, held)${report.unmeasuredSkips ? ` — ${report.unmeasuredSkips} past the size budget, unmeasured` : ''}:`,
);
for (const [reason, count] of Object.entries(report.skips).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(5)}  ${gb(report.skipBytes[reason] ?? 0).padStart(9)}  ${reason}`);
}
for (const candidate of report.candidates.filter((entry) => entry.collect)) {
  console.log(
    `  ${report.mode === 'apply' ? 'collected' : 'would collect'} [${candidate.category}] ${gb(candidate.bytes).padStart(9)}  ${candidate.path}`,
  );
}

// The 6h worktree cleanup applies its clone decisions itself; a dry run shows what its next pass would take.
if (report.mode === 'dry-run') {
  const preview = await previewCloneCheckoutCleanup();
  if (preview === null) {
    console.error('clone checkout preview DID NOT RUN — session inventory unavailable');
    process.exit(1);
  }
  const total = preview.collectable.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(
    `worktree cleanup would collect ${preview.collectable.length} of ${preview.examined} clone checkouts: ${gb(total)}`,
  );
  for (const [reason, count] of Object.entries(preview.refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(5)}  ${reason}`);
  }
}
