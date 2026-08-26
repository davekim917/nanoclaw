/**
 * One-off repair for topic files written before the curator emitted OKF
 * frontmatter, and for the stacked `<!-- consolidated -->` headers the old
 * write path accumulated (up to ten on one live file).
 *
 * Normalizes every curator-owned topic file to the exact bytes
 * writeMemoryTopicFile produces today, then rebuilds each workgroup's index
 * map. Both operations are idempotent, so a second run reports nothing.
 *
 *   pnpm exec tsx scripts/repair-memory-topic-frontmatter.ts                        # dry run
 *   pnpm exec tsx scripts/repair-memory-topic-frontmatter.ts --apply --backup-dir DIR
 *   … --apply --backup-dir DIR --workgroup <workgroup-id>
 *
 * Dry run by default because this rewrites live memory, and the dry run
 * previews EVERYTHING --apply does, index rewrites included — a preview that
 * hides the index changes hides the part an operator most needs to consent to.
 *
 * --backup-dir is REQUIRED for --apply. Each workgroup's whole memory tree is
 * snapshotted there before anything is written, because this is a one-shot
 * pass over hand-written memory with no other undo, and it CREATES index files
 * as well as rewriting them — so a per-file copy would not be restorable.
 *
 *   restore:  rm -rf data/workgroups/<wg>/memory
 *             cp -a <backup-dir>/<wg> data/workgroups/<wg>/memory
 *
 * Writes go through the curator's own CAS path, so a container writing the
 * same file concurrently surfaces as a reported conflict rather than a lost
 * update — the host does not need to be stopped.
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
import { PRE_TURN_BOUNDS } from '../src/modules/memory/pre-turn-context.js';
import { workgroupMemoryDir } from '../src/modules/workgroup/shared-dirs.js';

/** Usage errors are for a human at a terminal: one line, exit 2, no stack. */
function fail(message: string): never {
  console.error(`repair-memory-topic-frontmatter: ${message}`);
  process.exit(2);
}

function flagValue(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at < 0) return null;
  const value = process.argv[at + 1] ?? '';
  if (value === '' || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

const apply = process.argv.includes('--apply');
const selected = flagValue('--workgroup');
const backupDir = flagValue('--backup-dir');
if (apply && backupDir === null) {
  fail('--apply requires --backup-dir <dir>: this rewrites hand-written memory and has no other undo');
}

/**
 * Snapshot a workgroup's whole memory tree before the run touches it.
 *
 * A per-file copy taken at write time cannot be an undo: this pass also
 * CREATES index files, and there is no original to copy for those — a restore
 * has to delete them. One `cp -a` of the tree covers modified, created and
 * untouched files alike, and makes the restore a single command. It is also
 * less code than the per-file version it replaces.
 *
 * Never overwritten: re-running --apply into the same directory keeps the
 * first run's snapshot, which is the one that holds the true originals.
 *
 * Copied under a staging name and renamed into place, because `cpSync` is not
 * atomic. A crash or a kill mid-copy leaves a directory that LOOKS like a
 * snapshot, and the "keep the first one" rule above would then trust it — so
 * the rerun rewrites live memory against a backup missing whatever the copy
 * had not reached. The final name only ever appears after the copy returns;
 * a leftover `.incomplete` is discarded on the next run.
 */
function snapshot(workgroupId: string): void {
  const target = path.join(backupDir!, workgroupId);
  if (fs.existsSync(target)) return;
  const staging = `${target}.incomplete`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(workgroupMemoryDir(workgroupId), staging, { recursive: true });
  fs.renameSync(staging, target);
}

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

const targets = workgroupIds();
if (selected !== null && targets.length === 0) {
  fail(`--workgroup ${selected} matched no workgroup with a memory directory`);
}

for (const workgroupId of targets) {
  if (apply) snapshot(workgroupId);
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
  // The agent reads index.md HEAD-first under a hard bound, so a folder pointer
  // past that offset is on disk, correct, and invisible. Measured on the
  // CURATOR'S OWN LINKS, not on the `## Map` heading: the heading being inside
  // the bound proves nothing when the section above the links is long enough
  // (measured: heading at byte 1,881, links previously at 4,308). Report it
  // and let the operator decide — trimming what sits above is their editorial
  // call, not a background job's.
  const rootIndex = readMemoryTopicFile(workgroupId, 'index.md').content;
  const pointerOffset = Math.max(...TOPIC_DIRECTORIES.map((d) => rootIndex.indexOf(`](${d}/index.md)`)));
  if (pointerOffset > PRE_TURN_BOUNDS.markdownCoreChars) {
    console.log(
      `  NOTICE ${workgroupId}: the folder-index links sit at byte ${pointerOffset}, past the ` +
        `${PRE_TURN_BOUNDS.markdownCoreChars}-byte index head the agent reads — the map is correct on disk ` +
        `but the agent never sees it. Shorten what sits above them in index.md.`,
    );
  }

  try {
    const sync = await syncMemoryIndexes(workgroupId, { dryRun: !apply });
    if (sync.updated.length > 0) {
      console.log(`  ${apply ? 'INDEX' : 'WOULD REWRITE INDEX'} ${workgroupId}: ${sync.updated.join(', ')}`);
    }
  } catch (error) {
    console.log(`  INDEX ${workgroupId} FAILED: ${(error as Error).message}`);
    failed += 1;
  }
}

console.log(
  `${apply ? 'repaired' : 'would repair'} ${repaired}, already normalized ${skipped}, ` +
    `blocked by the size cap ${blocked}, failed ${failed}` +
    (apply ? `, memory trees snapshotted to ${backupDir}` : ' — re-run with --apply --backup-dir DIR to write'),
);
// Non-zero whenever work was not completed. A size-blocked file is not a crash
// but it IS an unrepaired file, and an operator scripting this needs to see
// that rather than a green exit over a partial pass.
process.exit(failed > 0 || blocked > 0 ? 1 : 0);
