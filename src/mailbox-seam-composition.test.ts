/**
 * Composition guard for the mailbox seam.
 *
 * `initSessionFolder` provisions through `getAgentMailbox()`, which throws
 * `No agent mailbox registered` until the composition slot
 * (`src/mailbox/compose.ts`) has been imported. `src/main.ts` gets it via
 * `src/modules/index.ts`, but `setup/` and `scripts/` are standalone
 * entrypoints that reach session provisioning on their own — a fresh
 * `setup/index.ts --step register` would die after creating the central
 * session row, and the `test-v2-*` harnesses would die on their first routed
 * message.
 *
 * Reaching provisioning is usually INDIRECT: `routeInbound` is two hops from
 * `initSessionFolder`, and a guard that only recognized a direct
 * `session-manager.js` import missed both harnesses. So this walks the import
 * graph: the seeds are the `src/` files that import a provisioning function by
 * name, the closure is every `src/` file that reaches a seed, and an
 * entrypoint importing anything in that closure must load the composition.
 *
 * Upstream pins the same property from the other side in
 * `src/mailbox/registry.test.ts`, which this fork ports in PR 7.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const STANDALONE_ROOTS = ['setup', 'scripts'];

/** Session-provisioning entry points — each reaches getAgentMailbox().prepare(). */
const PROVISIONING_NAMES = ['initSessionFolder', 'resolveSession', 'resolveTaskSession'];

const COMPOSITION_IMPORT = /['"][^'"]*mailbox\/compose\.js['"]/;

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
  return out.sort();
}

const read = (relPath: string): string => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

/** Relative import targets of a file, resolved to repo-relative .ts paths. */
function relativeImports(relPath: string, src: string): string[] {
  const out: string[] = [];
  const importRe = /from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(src))) {
    const specifier = match[1] ?? match[2];
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(relPath), specifier))
      .replace(/\.js$/, '.ts');
    if (fs.existsSync(path.join(REPO_ROOT, resolved))) out.push(resolved);
  }
  return out;
}

/** Does this file import a provisioning function by name from session-manager? */
function importsProvisioningByName(src: string): boolean {
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]*session-manager\.js['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockRe.exec(src))) {
    const names = match[1].split(',').map((name) =>
      name
        .trim()
        .split(/\s+as\s+/)[0]
        .trim(),
    );
    if (names.some((name) => PROVISIONING_NAMES.includes(name))) return true;
  }
  return false;
}

/** Every src/ file that reaches session provisioning, directly or through imports. */
function provisioningClosure(): Set<string> {
  const srcFiles = listTsFiles('src');
  const sources = new Map(srcFiles.map((relPath) => [relPath, read(relPath)]));
  const reaching = new Set(srcFiles.filter((relPath) => importsProvisioningByName(sources.get(relPath)!)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const relPath of srcFiles) {
      if (reaching.has(relPath)) continue;
      if (relativeImports(relPath, sources.get(relPath)!).some((target) => reaching.has(target))) {
        reaching.add(relPath);
        changed = true;
      }
    }
  }
  return reaching;
}

describe('mailbox composition is loaded wherever sessions are provisioned', () => {
  it('every standalone setup/scripts entrypoint that can provision a session imports the composition slot', () => {
    const reaching = provisioningClosure();
    expect(
      reaching.size,
      'the provisioning closure must not be empty — the seed pattern has stopped matching',
    ).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const root of STANDALONE_ROOTS) {
      for (const relPath of listTsFiles(root)) {
        const src = read(relPath);
        const provisions =
          importsProvisioningByName(src) || relativeImports(relPath, src).some((target) => reaching.has(target));
        if (provisions && !COMPOSITION_IMPORT.test(src)) offenders.push(relPath);
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `${offenders.join(', ')} can reach session provisioning but never import src/mailbox/compose.js. ` +
            'initSessionFolder goes through getAgentMailbox(), which throws "No agent mailbox registered" ' +
            'until the composition slot has been imported, and these entrypoints do not load src/modules/index.js.'
        : undefined,
    ).toEqual([]);
  });

  it('src/modules/index.ts still imports the composition slot for the main entrypoint', () => {
    expect(COMPOSITION_IMPORT.test(read('src/modules/index.ts'))).toBe(true);
  });
});
