/**
 * Seam 3 tripwires for two async-hazard classes that no type checker or lint
 * rule sees (docs/specs/upstream-async-central-db-seam/plan.md §4.5, #411
 * round 3):
 *
 *  1. In the spawn path, the `running` status write became an await. If it
 *     runs before the child's `close`/`error` handlers are attached, a
 *     container that dies at boot exits while the write is pending and
 *     finalizeContainer never runs — the dead process stays in
 *     activeContainers with its reservations. Only a restart shows it, so the
 *     ordering is pinned here.
 *
 *  2. `scripts/` and `setup/` are covered by no tsconfig (#413), and a bare
 *     call to a now-async leaf (`ensureContainerConfig(id)` as a statement)
 *     is not even a type error there. Every call to a converted leaf export
 *     in those trees must be awaited (or explicitly `void`ed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('spawnContainer attaches the exit handlers before its first await', () => {
  it('awaits the running-status write only after close/error are registered', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/container-runner.ts'), 'utf8');
    const start = source.indexOf('async function spawnContainer(');
    expect(start).toBeGreaterThan(-1);
    // The function ends at the next top-level `\n}\n` after its start.
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);
    // Since #460 round 2 the listeners are attached INSIDE the lease block,
    // on the child `spawn()` just returned, before the block hands it back.
    const onClose = body.indexOf("child.on('close'");
    const onError = body.indexOf("child.on('error'");
    const statusAwait = body.indexOf('await markContainerRunning(');
    expect(onClose).toBeGreaterThan(-1);
    expect(onError).toBeGreaterThan(-1);
    expect(statusAwait).toBeGreaterThan(-1);
    expect(statusAwait).toBeGreaterThan(onClose);
    expect(statusAwait).toBeGreaterThan(onError);
  });
});

/**
 * Every async export of the central-DB leaves — derived from the tree, not
 * enumerated, so the next conversion cannot float a call in `scripts/` or
 * `setup/` without failing here (Codex round 1 on #460).
 */
function asyncLeafExports(): string[] {
  const names = new Set<string>();
  const leafDirs = [path.join(REPO_ROOT, 'src/db')];
  const modulesRoot = path.join(REPO_ROOT, 'src/modules');
  for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const db = path.join(modulesRoot, entry.name, 'db');
      if (fs.existsSync(db)) leafDirs.push(db);
    }
  }
  for (const dir of leafDirs) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const m of source.matchAll(/^export async function (\w+)/gm)) names.add(m[1]);
    }
  }
  return [...names].sort();
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

describe('scripts/ and setup/ await every converted leaf call', () => {
  it('derives a leaf set that contains the seam', () => {
    const leaves = asyncLeafExports();
    expect(leaves.length).toBeGreaterThan(100);
    for (const name of ['getSession', 'createMessagingGroupAgent', 'getMessagingGroup', 'ensureContainerConfig']) {
      expect(leaves).toContain(name);
    }
  });

  it('has no bare call to an async leaf export', () => {
    const ASYNC_LEAF_CALLS = asyncLeafExports();
    const offenders: string[] = [];
    for (const root of ['scripts', 'setup']) {
      for (const file of listTs(path.join(REPO_ROOT, root))) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        for (const name of ASYNC_LEAF_CALLS) {
          const re = new RegExp(`(^|[^\\w.])${name}\\(`, 'g');
          let m: RegExpExecArray | null;
          while ((m = re.exec(source)) !== null) {
            const before = source.slice(Math.max(0, m.index - 40), m.index + m[1].length);
            // Accepted forms: `await X(`, `return X(`, `void X(`, and a
            // definition/import (`function X(`, `{ X }`), plus `.then(X`.
            if (/(await|return|void|function|async function)\s+$/.test(before)) continue;
            if (/\bimport\b|\{\s*$|,\s*$/.test(before) && /\}/.test(source.slice(m.index, m.index + 200)) === false)
              continue;
            const line = source.slice(0, m.index).split('\n').length;
            offenders.push(`${path.relative(REPO_ROOT, file)}:${line} ${name}(`);
          }
        }
      }
    }
    expect(
      offenders,
      'bare calls to async leaf exports in untypechecked trees (await them, or void them with a reason)',
    ).toEqual([]);
  });
});
