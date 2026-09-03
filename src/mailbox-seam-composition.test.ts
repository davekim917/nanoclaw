/**
 * Composition guard for the mailbox seam.
 *
 * `initSessionFolder` provisions through `getAgentMailbox()`, which throws
 * `No agent mailbox registered` until the composition slot
 * (`src/mailbox/compose.ts`) has been imported. `src/main.ts` gets it via
 * `src/modules/index.ts`, but `setup/` and `scripts/` are standalone
 * entrypoints that import `src/session-manager.ts` directly — a fresh
 * `setup/index.ts --step register` reaches session provisioning with nothing
 * registered and dies after creating the central session row.
 *
 * Any standalone entrypoint that provisions a session must therefore load the
 * composition itself. Upstream pins the same property from the other side in
 * `src/mailbox/registry.test.ts`, which this fork ports in PR 7.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const STANDALONE_ROOTS = ['setup', 'scripts'];

/** Session-provisioning entry points — each reaches getAgentMailbox().prepare(). */
const PROVISIONING_NAMES = ['initSessionFolder', 'resolveSession', 'resolveTaskSession'];

const COMPOSITION_IMPORTS = [
  /from\s+['"][^'"]*mailbox\/compose\.js['"]/,
  /import\s+['"][^'"]*mailbox\/compose\.js['"]/,
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
  return out.sort();
}

function importsProvisioning(src: string): boolean {
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

describe('mailbox composition is loaded wherever sessions are provisioned', () => {
  it('every standalone setup/scripts entrypoint that provisions a session imports the composition slot', () => {
    const offenders: string[] = [];
    for (const root of STANDALONE_ROOTS) {
      for (const relPath of listTsFiles(root)) {
        const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
        if (!importsProvisioning(src)) continue;
        if (!COMPOSITION_IMPORTS.some((pattern) => pattern.test(src))) offenders.push(relPath);
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `${offenders.join(', ')} provision sessions but never import src/mailbox/compose.js. ` +
            'initSessionFolder goes through getAgentMailbox(), which throws "No agent mailbox registered" ' +
            'until the composition slot has been imported, and these entrypoints do not load src/modules/index.js.'
        : undefined,
    ).toEqual([]);
  });

  it('src/modules/index.ts still imports the composition slot for the main entrypoint', () => {
    const barrel = fs.readFileSync(path.join(REPO_ROOT, 'src/modules/index.ts'), 'utf8');
    expect(COMPOSITION_IMPORTS.some((pattern) => pattern.test(barrel))).toBe(true);
  });
});
