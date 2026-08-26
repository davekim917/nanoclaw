import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, expect, it } from 'vitest';

// The script resolves DATA_DIR from src/config.js at import time in its own
// process, so there is nothing to mock — it has to run against this
// checkout's real `data/` tree, the same way curator-write.test.ts does.
const ROOT = process.cwd();
const WORKGROUP = `test-repair-${process.pid}`;
const MEMORY = path.join(ROOT, 'data', 'workgroups', WORKGROUP, 'memory');
const BACKUP = path.join(ROOT, 'data', `test-repair-backup-${process.pid}`);
const LOCKED = path.join(MEMORY, 'people', 'b-locked.md');

function unlock(): void {
  try {
    fs.chmodSync(LOCKED, 0o644);
  } catch {
    // Not created yet, or already gone.
  }
}

beforeEach(() => {
  unlock();
  fs.rmSync(path.dirname(MEMORY), { recursive: true, force: true });
  fs.rmSync(BACKUP, { recursive: true, force: true });
  fs.mkdirSync(path.join(MEMORY, 'people'), { recursive: true });
  for (const [name, body] of [
    ['a-ok.md', 'Ana owns the SLSDA tickets.'],
    ['b-locked.md', 'Brian runs the release train.'],
    ['c-ok.md', 'Cara owns the depletions lane.'],
  ] as const) {
    fs.writeFileSync(path.join(MEMORY, 'people', name), `<!-- consolidated: facts=2 -->\n${body}\n`);
  }
  fs.writeFileSync(
    path.join(MEMORY, 'index.md'),
    '---\nokf_version: "0.1"\n---\n\n# Memory Index\n\n## Core Memory\n\n- x\n',
  );
});

afterEach(() => {
  unlock();
  fs.rmSync(path.dirname(MEMORY), { recursive: true, force: true });
  fs.rmSync(BACKUP, { recursive: true, force: true });
});

function runApply(): number {
  try {
    execFileSync(
      path.join(ROOT, 'node_modules', '.bin', 'tsx'),
      ['scripts/repair-memory-topic-frontmatter.ts', '--apply', '--backup-dir', BACKUP, '--workgroup', WORKGROUP],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

// `cpSync` is not atomic, and the guard that preserves the FIRST snapshot used
// to trust whatever sat at the final name — including a directory a crash had
// left half-copied. The rerun then rewrote live memory against an incomplete
// backup, which is the one thing the backup exists to prevent.
//
// The crash is forced deterministically with an unreadable file partway
// through the tree, so the copy throws EACCES after copying some of it.
it('never leaves a half-copied snapshot at a name a rerun would trust', () => {
  const originals = new Map(filesUnder(MEMORY).map((rel) => [rel, fs.readFileSync(path.join(MEMORY, rel), 'utf8')]));
  expect(originals.size).toBe(4);

  fs.chmodSync(LOCKED, 0o000);
  expect(runApply()).not.toBe(0);
  unlock();
  // Nothing at the final name — a crashed copy must not look like a snapshot.
  expect(fs.existsSync(path.join(BACKUP, WORKGROUP))).toBe(false);

  // The operator fixes the permission and reruns.
  expect(runApply()).toBe(0);
  const backed = filesUnder(path.join(BACKUP, WORKGROUP));
  for (const [relative, body] of originals) {
    expect(backed).toContain(relative);
    expect(fs.readFileSync(path.join(BACKUP, WORKGROUP, relative), 'utf8')).toBe(body);
  }
  // …and the run really did rewrite the live tree, so the backup mattered.
  expect(fs.readFileSync(path.join(MEMORY, 'people', 'a-ok.md'), 'utf8')).not.toBe(originals.get('people/a-ok.md'));
});
