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

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' };
  }
}

function runApply(extra: string[] = []): number {
  return run([
    'scripts/repair-memory-topic-frontmatter.ts',
    '--apply',
    '--backup-dir',
    BACKUP,
    '--workgroup',
    WORKGROUP,
    ...extra,
  ]).status;
}

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

function originalBytes(): Map<string, string> {
  return new Map(filesUnder(MEMORY).map((rel) => [rel, fs.readFileSync(path.join(MEMORY, rel), 'utf8')]));
}

function expectUnchanged(originals: Map<string, string>): void {
  expect(filesUnder(MEMORY).sort()).toEqual([...originals.keys()].sort());
  for (const [relative, body] of originals) {
    expect(fs.readFileSync(path.join(MEMORY, relative), 'utf8')).toBe(body);
  }
}

// THE failure mode, and the one the previous two fixes did not cover because
// the test started from an empty backup directory. A partial `<backup>/<wg>`
// left by an interrupted run — or any directory that happens to be at that
// path — used to be trusted by the "keep the first snapshot" rule, and live
// memory was then rewritten with no complete undo behind it.
it('refuses to write when the existing backup is partial, and touches nothing', () => {
  const originals = originalBytes();
  expect(originals.size).toBe(4);
  // What an interrupted direct-cpSync leaves behind: real files, no marker.
  fs.mkdirSync(path.join(BACKUP, WORKGROUP, 'people'), { recursive: true });
  fs.copyFileSync(path.join(MEMORY, 'index.md'), path.join(BACKUP, WORKGROUP, 'index.md'));

  expect(runApply()).toBe(2);
  expectUnchanged(originals);
  // The partial is left exactly as it was: it may be the operator's own copy,
  // and replacing it silently would destroy whatever it does hold.
  expect(filesUnder(path.join(BACKUP, WORKGROUP))).toEqual(['index.md']);
});

// `cpSync` is not atomic, and a crash mid-copy leaves a directory that LOOKS
// like a finished snapshot. Publication under a staging name keeps the final
// name from appearing at all; the marker is what makes the NEXT run able to
// tell the difference. The crash is forced deterministically with an
// unreadable file partway through the tree, so the copy throws EACCES.
it('never leaves a half-copied snapshot at a name a rerun would trust', () => {
  const originals = originalBytes();

  fs.chmodSync(LOCKED, 0o000);
  expect(runApply()).not.toBe(0);
  unlock();
  expect(fs.existsSync(path.join(BACKUP, WORKGROUP))).toBe(false);
  expect(fs.existsSync(`${path.join(BACKUP, WORKGROUP)}.complete`)).toBe(false);
  // Staging is cleaned up rather than left as litter for the next operator.
  expect(fs.readdirSync(BACKUP).filter((name) => name.includes('.incomplete'))).toEqual([]);
  expectUnchanged(originals);

  // The operator fixes the permission and reruns.
  expect(runApply()).toBe(0);
  const backed = filesUnder(path.join(BACKUP, WORKGROUP));
  for (const [relative, body] of originals) {
    expect(backed).toContain(relative);
    expect(fs.readFileSync(path.join(BACKUP, WORKGROUP, relative), 'utf8')).toBe(body);
  }
  // The marker is a sibling, so a restore copies the memory canon and nothing else.
  expect(fs.existsSync(`${path.join(BACKUP, WORKGROUP)}.complete`)).toBe(true);
  expect(backed).not.toContain('.complete');
  // …and the run really did rewrite the live tree, so the backup mattered.
  expect(fs.readFileSync(path.join(MEMORY, 'people', 'a-ok.md'), 'utf8')).not.toBe(originals.get('people/a-ok.md'));
});

// GUARD: validating the snapshot must not turn into re-taking it. The first
// run's copy is the one holding the true originals, so a marked backup is
// preserved across a rerun.
it('keeps a completed snapshot on a rerun instead of overwriting it with already-repaired files', () => {
  const originals = originalBytes();
  expect(runApply()).toBe(0);
  expect(runApply()).toBe(0);
  for (const [relative, body] of originals) {
    expect(fs.readFileSync(path.join(BACKUP, WORKGROUP, relative), 'utf8')).toBe(body);
  }
});

// Index maintenance is parked with known destructive findings in
// memory-index.ts, and the live indexes carry hand-written Core Memory, map
// links and an HTML comment. --skip-index lets the topic repair — the part
// that is fixed — run without putting frozen, known-buggy code across them.
it('repairs topic files without touching the index under --skip-index', () => {
  const originals = originalBytes();

  expect(runApply(['--skip-index'])).toBe(0);

  expect(fs.readFileSync(path.join(MEMORY, 'index.md'), 'utf8')).toBe(originals.get('index.md'));
  expect(fs.readFileSync(path.join(MEMORY, 'people', 'a-ok.md'), 'utf8')).not.toBe(originals.get('people/a-ok.md'));
  // No folder index conjured either — syncMemoryIndexes CREATES these.
  expect(fs.existsSync(path.join(MEMORY, 'people', 'index.md'))).toBe(false);
});

// The preview has to describe the run it is previewing. A dry run that still
// printed WOULD REWRITE INDEX would tell the operator to expect index writes
// from an invocation that makes none.
it('shows no index rewrite in a --skip-index dry run, and does show one without it', () => {
  const skipped = run(['scripts/repair-memory-topic-frontmatter.ts', '--workgroup', WORKGROUP, '--skip-index']);
  expect(skipped.stdout).not.toContain('WOULD REWRITE INDEX');
  expect(skipped.stdout).toContain('indexes left alone (--skip-index)');
  expect(skipped.stdout).toContain('WOULD REPAIR');

  // GUARD: the default is unchanged — this is opt-out, not a new default.
  const normal = run(['scripts/repair-memory-topic-frontmatter.ts', '--workgroup', WORKGROUP]);
  expect(normal.stdout).toContain('WOULD REWRITE INDEX');
  expectUnchanged(originalBytes());
});
