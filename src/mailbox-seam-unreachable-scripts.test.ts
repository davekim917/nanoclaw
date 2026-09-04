/**
 * Issue #300: eight standalone scripts flagged as import-graph reachable to
 * the mailbox seam (they transitively `import` a file that reaches
 * `getAgentMailbox`/`withMailboxSession`/`withExistingMailboxSession`) with no
 * `src/mailbox/compose.ts` import — the same shape of finding that PR 7 round
 * 2 found real in `scripts/migrate-workgroup-memory.ts` (fixed in b53a6519).
 *
 * Import-graph reachability is not execution (that's exactly the trap
 * b53a6519's own commit message names: "Bolting compose.js onto eight
 * operational entrypoints to satisfy a static over-approximation is the
 * fix-induced-defect pattern, not safety"). This file traces each of the
 * eight scripts' ACTUAL call graph — which specific bindings they import, and
 * whether those specific bindings ever reach the seam — and proves the
 * negative at runtime rather than by static text-matching alone:
 *
 *   1. Every leaf function these scripts (transitively) call is invoked here
 *      with the mailbox factory deliberately unregistered
 *      (`resetAgentMailboxForTesting`). None of them throw the seam's
 *      signature error, `No agent mailbox registered`.
 *   2. A negative control (below) proves that error DOES fire when the seam
 *      is actually reached in the same unregistered state — so a script that
 *      really did reach the seam would fail loudly here, not pass silently.
 *   3. Source-level assertions pin the exact set of `session-manager.js` /
 *      `storage-manager.ts` / `storage-activity.ts` / `worktree-cleanup.ts` /
 *      `container-runner.ts` bindings each script's import graph touches, so
 *      a future refactor that adds a new import re-triggers this review
 *      instead of silently drifting into reachability.
 *
 * Two of the eight (`init-cli-agent.ts`, `init-first-agent.ts`) and
 * `refresh-backlog-canvas.ts` have NO relative-import path (even
 * over-approximated) into `session-manager.ts`, `container-runner.ts`,
 * `delivery.ts`, or `mailbox/index.ts` at all — verified below by walking
 * their import graphs directly rather than asserting an absence by hand.
 *
 * `migrate-repo-store.ts` and `verify-workgroup-memory-runtime.ts` import
 * `session-manager.ts` for non-seam helpers only.
 * `reclaim-idle-thread-worktrees.ts` and `restore-session-mtimes.ts` reach it
 * only through `storage-manager.ts` / `storage-activity.ts`, which contain NO
 * seam call themselves (asserted below) and only re-export the same
 * non-seam `session-manager.js` helpers. `storage-gc.ts` reaches it only
 * through `worktree-cleanup.ts`, which likewise contains no seam call and
 * only imports the two trivial, seam-free `container-runner.ts` getters
 * (`isContainerRunning`, `isContainerSpawning` — Map/Set lookups, not spawn
 * logic) plus the same non-seam `session-manager.js` helpers.
 *
 * None of the eight import `initSessionFolder`, `resolveSession`,
 * `resolveTaskSession`, `withMailboxSession`, `withExistingMailboxSession`,
 * or `destroySessionMailbox` — the only `session-manager.ts` exports whose
 * own body calls the seam. No compose.ts import is needed for any of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  inboundDbPath,
  isAdmissiblePreTurnTrigger,
  outboundDbPath,
  readThreadDirOwner,
  sessionContextPathFor,
  sessionsBaseDir,
  threadsBaseDir,
  threadWorktreeDir,
} from './session-manager.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { tryRunWithStorageCleanupClaim } from './storage-activity.js';
import { sessionHasOpenWork } from './storage-manager.js';
import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from './mailbox/index.js';

const REPO_ROOT = path.resolve(__dirname, '..');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mailbox-seam-unreachable-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

const NOT_REGISTERED = 'No agent mailbox registered';

/**
 * Run `fn` with the mailbox factory deliberately unregistered — the exact
 * condition a standalone `tsx` script is in, since none of the eight load
 * `src/mailbox/compose.ts`. `src/test-setup.ts` registers the real factory
 * before every test; this suspends that registration for the duration of
 * `fn` and restores it afterward so later tests in this file (and the
 * process, since ESM module state is per-file here) are unaffected.
 */
async function withNoMailboxRegistered<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = resetAgentMailboxForTesting();
  try {
    return await fn();
  } finally {
    if (previous) registerAgentMailbox(previous);
  }
}

/** Call `fn` and, if it throws, assert the throw is not the seam's signature error. */
function callNeverReachingSeam(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).not.toBe(NOT_REGISTERED);
  }
}

describe('negative control: the harness actually detects a real seam hit', () => {
  it('getAgentMailbox() throws "No agent mailbox registered" when the factory is unregistered', async () => {
    await withNoMailboxRegistered(() => {
      expect(() => getAgentMailbox()).toThrow(NOT_REGISTERED);
    });
  });
});

describe('scripts/migrate-repo-store.ts — only imports readThreadDirOwner, threadWorktreeDir from session-manager.js', () => {
  it('neither function reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        readThreadDirOwner(tmpDir('read-thread-dir-owner'));
      });
      callNeverReachingSeam(() => {
        threadWorktreeDir('cli', 'thread-1', 'wg-1');
      });
    });
  });
});

describe('scripts/verify-workgroup-memory-runtime.ts', () => {
  it('isAdmissiblePreTurnTrigger (its only session-manager.js import) never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        isAdmissiblePreTurnTrigger({
          id: 'm1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: 'hello',
          trigger: 1,
        } as Parameters<typeof isAdmissiblePreTurnTrigger>[0]);
      });
    });
  });

  // It is NOT eligible for the "no relative-import path to the seam at
  // all" walk below (TARGETS) — it genuinely does reach
  // src/session-manager.ts (a SEAM_ADJACENT_FILES entry), just through a
  // non-seam binding. Adding it there would fail that walk's "zero path"
  // assertion for a correct reason (the path exists) while asserting the
  // wrong thing (the walk can't tell a non-seam binding from a seam one).
  // The right proof for this shape — same one used above for
  // isAdmissiblePreTurnTrigger, and for storage-manager.ts /
  // worktree-cleanup.ts below — is pinning the exact import set so a
  // future import drift re-triggers this review instead of silently
  // widening reachability.
  it('its only session-manager.js imports are isAdmissiblePreTurnTrigger, pinned so a future import here re-triggers this review', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/verify-workgroup-memory-runtime.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/src\/session-manager\.js['"]/.exec(src);
    expect(
      match,
      'verify-workgroup-memory-runtime.ts must import from ../src/session-manager.js for this test to be meaningful',
    ).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['isAdmissiblePreTurnTrigger'].sort());
  });

  // The module-load side of this script — does importing
  // scripts/migrate-workgroup-memory.ts (for parseMigrationReport) run its
  // CLI body, and is the verifier module itself (verify-workgroup-memory-
  // runtime.ts) safe to import bare — is covered in
  // scripts/mailbox-seam-unreachable.test.ts. This file's tsconfig rootDir
  // is src/, so it cannot import a scripts/ module.
});

describe('storage-manager.ts / storage-activity.ts contain no literal seam call', () => {
  it('storage-manager.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-manager.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it('storage-activity.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-activity.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it("storage-manager.ts's only session-manager.js imports are the non-seam path helpers", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-manager.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/session-manager\.js['"]/.exec(src);
    expect(
      match,
      'storage-manager.ts must import from session-manager.js for this test to be meaningful',
    ).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    // 1553790a moved storage-manager.ts's DB-path lookups (inboundDbPath,
    // outboundDbPath) onto the mailbox module's own sessionMailboxPath — the
    // remaining session-manager.js imports are only the thread/session
    // directory-layout helpers, none of which reach the seam.
    expect(names.sort()).toEqual(
      ['sessionContextPathFor', 'sessionsBaseDir', 'threadsBaseDir', 'threadWorktreeDir'].sort(),
    );
  });
});

describe('scripts/reclaim-idle-thread-worktrees.ts — only imports getStorageReport from storage-manager.ts', () => {
  it("storage-manager.ts's session-manager.js re-imports never reach the mailbox seam", async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('reclaim');
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => outboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => sessionContextPathFor(dir));
      callNeverReachingSeam(() => sessionsBaseDir());
      callNeverReachingSeam(() => threadsBaseDir());
      callNeverReachingSeam(() => threadWorktreeDir('cli', 'thread-1', 'wg-1'));
    });
  });
});

describe('scripts/restore-session-mtimes.ts — imports tryRunWithStorageCleanupClaim (storage-activity.ts) and sessionHasOpenWork (storage-manager.ts)', () => {
  it('tryRunWithStorageCleanupClaim never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('cleanup-claim');
      let ran = false;
      callNeverReachingSeam(() => {
        const claimed = tryRunWithStorageCleanupClaim(dir, () => {
          ran = true;
        });
        expect(claimed).toBe(true);
      });
      expect(ran).toBe(true);
    });
  });

  it('sessionHasOpenWork never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('open-work');
      callNeverReachingSeam(() => {
        sessionHasOpenWork('ag1', 's1', dir);
      });
    });
  });
});

describe('worktree-cleanup.ts contains no literal seam call, and the only container-runner.ts bindings storage-gc.ts pulls in are trivial getters', () => {
  it('worktree-cleanup.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it("worktree-cleanup.ts's only container-runner.ts imports are isContainerRunning, isContainerSpawning", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/container-runner\.js['"]/.exec(src);
    expect(match).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['isContainerRunning', 'isContainerSpawning'].sort());
  });

  // 1553790a moved worktree-cleanup.ts's DB-path lookups (inboundDbPath,
  // openOutboundDb) off session-manager.js entirely, onto the mailbox
  // module's own sessionMailboxPath and openOutboundDb — the file now has no
  // session-manager.js import at all. Pinning stays on the two files that
  // replaced it, so a future import there still re-triggers this review.
  it('worktree-cleanup.ts no longer imports from session-manager.js', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    expect(/from\s*['"]\.\/session-manager\.js['"]/.test(src)).toBe(false);
  });

  it("worktree-cleanup.ts's only modules/mailbox/openers.js import is openOutboundDb, and its only modules/mailbox/index.js import is sessionMailboxPath — pinned so a future import here re-triggers this review", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');

    const openersMatch = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/modules\/mailbox\/openers\.js['"]/.exec(src);
    expect(openersMatch).not.toBeNull();
    const openersNames = openersMatch![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(openersNames.sort()).toEqual(['openOutboundDb'].sort());

    const indexMatch = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/modules\/mailbox\/index\.js['"]/.exec(src);
    expect(indexMatch).not.toBeNull();
    const indexNames = indexMatch![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(indexNames.sort()).toEqual(['sessionMailboxPath'].sort());
  });
});

describe('scripts/storage-gc.ts — only imports runStorageGcOnce from worktree-cleanup.ts', () => {
  it('isContainerRunning and isContainerSpawning (Map/Set lookups, not spawn logic) never reach the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        expect(isContainerRunning('nonexistent-session')).toBe(false);
      });
      callNeverReachingSeam(() => {
        expect(isContainerSpawning('nonexistent-session')).toBe(false);
      });
    });
  });

  it('inboundDbPath never reaches the mailbox seam (openOutboundDb is exercised indirectly via sessionHasOpenWork above)', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
    });
  });
});

describe('scripts/init-cli-agent.ts, scripts/init-first-agent.ts, scripts/refresh-backlog-canvas.ts have no relative-import path to the seam', () => {
  const STANDALONE_ROOTS = ['scripts'];
  const TARGETS = ['scripts/init-cli-agent.ts', 'scripts/init-first-agent.ts', 'scripts/refresh-backlog-canvas.ts'];
  const SEAM_ADJACENT_FILES = [
    'src/session-manager.ts',
    'src/container-runner.ts',
    'src/delivery.ts',
    'src/mailbox/index.ts',
  ];

  function listTsFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(REPO_ROOT, root));
    return out;
  }

  const read = (relPath: string): string => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

  /**
   * `true` if the import/export statement enclosing source offset `pos`
   * (a position `ts.preProcessFile` reports somewhere inside that
   * statement's specifier) is a whole-statement `import type { … } from` or
   * `export type { … } from` — erased at compile time, no runtime edge. A
   * per-specifier `import { type X, Y } from` is NOT type-only (Y is a real
   * value import) and is intentionally not matched here, same as before.
   *
   * This is a cheap text check, not a parse: walk back to the nearest
   * preceding `;` (or start of file) — the statement terminator every
   * import/export in this codebase's prettier-formatted style carries — and
   * check what the statement starts with.
   */
  function isTypeOnlyStatement(src: string, pos: number): boolean {
    const prevSemicolon = src.lastIndexOf(';', pos);
    const statement = src.slice(prevSemicolon + 1, pos).trimStart();
    return /^import\s+type\b/.test(statement) || /^export\s+type\b/.test(statement);
  }

  /**
   * Relative import/export specifiers that create a runtime module-graph
   * edge — VALUE imports only; `import type` / `export type { … } from` are
   * erased at compile time and create no runtime edge. Uses TypeScript's own
   * scanner (`ts.preProcessFile`, an existing dependency) rather than a
   * lexical regex walk, which previously let a lazy pattern spanning
   * newlines swallow a bare side-effect import sitting between a
   * non-relative `from` clause and the next relative one (see the
   * "side-effect import" test below). `preProcessFile` reports every
   * specifier from static imports (including bare side-effect imports),
   * dynamic `import('./x.js')` with a string-literal specifier, and
   * `export … from` re-exports in one pass; type-only statements are
   * filtered out separately via `isTypeOnlyStatement` since
   * `preProcessFile` reports those too.
   */
  function relativeValueSpecifiers(src: string): string[] {
    const { importedFiles } = ts.preProcessFile(src, /* readImportFiles */ true, /* detectJavaScriptImports */ false);
    const specifiers = new Set<string>();
    for (const { fileName, pos } of importedFiles) {
      if (!fileName.startsWith('.')) continue; // package import — no repo-relative edge
      if (isTypeOnlyStatement(src, pos)) continue;
      specifiers.add(fileName);
    }
    return [...specifiers];
  }

  /** Resolve a relative specifier from `relPath` to a repo-root-relative .ts file path under `root`, if one exists. */
  function resolveSpecifier(relPath: string, specifier: string, root: string): string | undefined {
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(relPath), specifier))
      .replace(/\.js$/, '.ts');
    if (fs.existsSync(path.join(root, resolved))) return resolved;
    const idx = resolved.replace(/\.ts$/, '') + '/index.ts';
    if (fs.existsSync(path.join(root, idx))) return idx;
    return undefined;
  }

  function relativeValueImports(relPath: string, src: string, root: string = REPO_ROOT): string[] {
    const out: string[] = [];
    for (const specifier of relativeValueSpecifiers(src)) {
      const resolved = resolveSpecifier(relPath, specifier, root);
      if (resolved) out.push(resolved);
    }
    return out;
  }

  for (const target of TARGETS) {
    it(`${target} never value-imports (transitively) session-manager.ts, container-runner.ts, delivery.ts, or mailbox/index.ts`, () => {
      const allFiles = [...listTsFiles('src'), ...STANDALONE_ROOTS.flatMap(listTsFiles)];
      const sources = new Map(allFiles.map((p) => [p, read(p)]));
      const visited = new Set([target]);
      const queue = [target];
      while (queue.length) {
        const cur = queue.shift()!;
        const src = sources.get(cur);
        if (!src) continue;
        for (const dep of relativeValueImports(cur, src)) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      const hit = SEAM_ADJACENT_FILES.find((f) => visited.has(f));
      expect(hit, `${target} reaches ${hit} — this proof is stale, re-run the trace`).toBeUndefined();
    });
  }

  describe('relativeValueImports walker — dynamic import() and re-export edges', () => {
    it('resolves a dynamic import(), an `export * from`, and an `export { … } from` specifier, each to its target file', () => {
      const dir = tmpDir('walker-edges');
      fs.writeFileSync(
        path.join(dir, 'entry.ts'),
        [
          'export async function loadDynamic() {',
          "  return await import('./dynamic-target.js');",
          '}',
          "export * from './star-target.js';",
          "export { value } from './named-target.js';",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(dir, 'dynamic-target.ts'), 'export const dynamicValue = 1;\n');
      fs.writeFileSync(path.join(dir, 'star-target.ts'), 'export const starValue = 1;\n');
      fs.writeFileSync(path.join(dir, 'named-target.ts'), 'export const value = 1;\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps.sort()).toEqual(['dynamic-target.ts', 'named-target.ts', 'star-target.ts'].sort());
    });

    it('does not resolve an `export type { … } from` re-export (erased at compile time, no runtime edge)', () => {
      const dir = tmpDir('walker-type-only');
      fs.writeFileSync(path.join(dir, 'entry.ts'), "export type { Foo } from './types-only.js';\n");
      fs.writeFileSync(path.join(dir, 'types-only.ts'), 'export type Foo = { x: number };\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps).toEqual([]);
    });

    it('follows a dynamic import() transitively across two hops', () => {
      const dir = tmpDir('walker-transitive');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'entry.ts'), "export const load = () => import('./middle.js');\n");
      fs.writeFileSync(path.join(dir, 'middle.ts'), "export * from './leaf.js';\n");
      fs.writeFileSync(path.join(dir, 'leaf.ts'), 'export const leaf = 1;\n');

      const sources = new Map(
        ['entry.ts', 'middle.ts', 'leaf.ts'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
      );
      const visited = new Set(['entry.ts']);
      const queue = ['entry.ts'];
      while (queue.length) {
        const cur = queue.shift()!;
        const src = sources.get(cur);
        if (!src) continue;
        for (const dep of relativeValueImports(cur, src, dir)) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }

      expect(visited).toEqual(new Set(['entry.ts', 'middle.ts', 'leaf.ts']));
    });

    it('resolves a side-effect `import`, even when a package import with a `from` clause precedes it on an earlier line', () => {
      // Regression: a lazy, newline-spanning regex here previously let a
      // preceding non-relative `import path from 'path';` statement's `from`
      // clause absorb everything up to the NEXT `from '<relative>'` it could
      // find, silently swallowing this bare side-effect import in between —
      // exactly the shape `scripts/init-cli-agent.ts` and
      // `scripts/init-first-agent.ts` use for `import '../src/channels/index.js';`.
      const dir = tmpDir('walker-side-effect');
      fs.writeFileSync(
        path.join(dir, 'entry.ts'),
        [
          "import path from 'node:path';",
          "import './side-effect-target.js';",
          "import { later } from './later-target.js';",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(dir, 'side-effect-target.ts'), 'export const ranSideEffect = true;\n');
      fs.writeFileSync(path.join(dir, 'later-target.ts'), 'export const later = 1;\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps.sort()).toEqual(['later-target.ts', 'side-effect-target.ts'].sort());
    });
  });
});
