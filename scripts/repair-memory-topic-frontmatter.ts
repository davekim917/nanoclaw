/**
 * One-off repair for topic files written before the curator emitted OKF
 * frontmatter, and for the stacked `<!-- consolidated -->` headers the old
 * write path accumulated (up to ten on one live file).
 *
 * Normalizes every curator-owned topic file to the exact bytes
 * writeMemoryTopicFile produces today, then rebuilds each workgroup's index
 * map. Both operations are idempotent, so a second run reports nothing.
 *
 *   pnpm exec tsx scripts/repair-memory-topic-frontmatter.ts             # dry run
 *   pnpm exec tsx scripts/repair-memory-topic-frontmatter.ts --apply
 *   pnpm exec tsx scripts/repair-memory-topic-frontmatter.ts --apply --workgroup illysium
 *
 * Dry run by default because this rewrites live memory. Writes go through the
 * curator's own CAS path, so a container writing the same file concurrently
 * surfaces as a reported conflict rather than a lost update — the host does
 * not need to be stopped.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import {
  consolidatedFactsOf,
  isCuratorOwned,
  RESERVED_TOPIC_LEAVES,
  serializeTopicFile,
  TOPIC_DIRECTORIES,
  TOPIC_FILE_PATH_PATTERN,
} from '../src/modules/memory/curator-contract.js';
import { readMemoryTopicFile, syncMemoryIndexes, writeMemoryTopicFile } from '../src/modules/memory/curator-write.js';
import { workgroupMemoryDir } from '../src/modules/workgroup/shared-dirs.js';

const apply = process.argv.includes('--apply');
const workgroupFlagAt = process.argv.indexOf('--workgroup');
const selected = workgroupFlagAt >= 0 ? (process.argv[workgroupFlagAt + 1] ?? '') : null;
if (selected === '') throw new Error('--workgroup needs a workgroup id');

function workgroupIds(): string[] {
  const root = path.join(DATA_DIR, 'workgroups');
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'memory')))
    .map((entry) => entry.name)
    .filter((id) => selected === null || id === selected)
    .sort();
}

function topicPaths(workgroupId: string): string[] {
  const root = workgroupMemoryDir(workgroupId);
  return TOPIC_DIRECTORIES.flatMap((directory) => {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, directory));
    } catch {
      return [];
    }
    return names
      .filter((name) => !RESERVED_TOPIC_LEAVES.has(name) && TOPIC_FILE_PATH_PATTERN.test(`${directory}/${name}`))
      .sort()
      .map((name) => `${directory}/${name}`);
  });
}

let repaired = 0;
let skipped = 0;
let blocked = 0;
let failed = 0;

for (const workgroupId of workgroupIds()) {
  for (const relative of topicPaths(workgroupId)) {
    let current: { content: string; sha256: string | null };
    try {
      current = readMemoryTopicFile(workgroupId, relative);
    } catch (error) {
      console.log(`  UNREADABLE ${workgroupId}/${relative}: ${(error as Error).message}`);
      failed += 1;
      continue;
    }
    if (current.sha256 === null || !isCuratorOwned(current.content)) continue;
    const factsCount = consolidatedFactsOf(current.content);
    const next = serializeTopicFile(relative, current.content, factsCount, current.content);
    if (next === current.content) {
      skipped += 1;
      continue;
    }
    const markers = (current.content.match(/^<!--\s*consolidated/gm) ?? []).length;
    console.log(`  ${apply ? 'REPAIR' : 'WOULD REPAIR'} ${workgroupId}/${relative} (${markers} legacy marker(s))`);
    if (!apply) {
      repaired += 1;
      continue;
    }
    const write = await writeMemoryTopicFile(workgroupId, relative, current.content, current.sha256, factsCount);
    if (write.status === 'success') {
      repaired += 1;
    } else if (write.error?.includes('exceeds')) {
      // Pre-existing condition, not a repair failure: the file's BODY was
      // already past CONSOLIDATION_FILE_MAX_BYTES before this change, so the
      // curator could not write it either. Dropping content to fit is an
      // editorial decision a sweep script has no business making.
      console.log(`    BLOCKED: already over the topic-file size cap (${write.error}) — needs manual trimming`);
      blocked += 1;
    } else {
      console.log(`    FAILED (${write.status}): ${write.error ?? 'unknown'}`);
      failed += 1;
    }
  }
  if (apply) {
    try {
      const sync = await syncMemoryIndexes(workgroupId);
      if (sync.updated.length > 0) console.log(`  INDEX ${workgroupId}: ${sync.updated.join(', ')}`);
    } catch (error) {
      console.log(`  INDEX ${workgroupId} FAILED: ${(error as Error).message}`);
      failed += 1;
    }
  }
}

console.log(
  `${apply ? 'repaired' : 'would repair'} ${repaired}, already normalized ${skipped}, ` +
    `blocked by the size cap ${blocked}, failed ${failed}` +
    (apply ? '' : ' — re-run with --apply to write'),
);
process.exit(failed > 0 ? 1 : 0);
