/**
 * Every container process that can reach the mailbox must boot it.
 *
 * The runner, the MCP server, the PreCompact hook and the Codex hook CLI are
 * four separate processes that share no module state, so each one has to
 * import the module barrel and call `mailbox.start()` itself. Forgetting one is
 * silent until an op runs: `getAgentMailbox()` throws "No agent mailbox
 * registered", and on the Codex hook path that throw lands in a fail-closed
 * catch and denies every gated command. Found in review on PR #254; this test
 * is the tripwire so the next entrypoint cannot repeat it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dir);

/** A file is a process entrypoint if it can be exec'd on its own. */
const ENTRYPOINT_MARKERS = [/^#!/, /import\.meta\.main/, /^main\(\)\.(?:catch|then)\(/m];

/**
 * Entrypoints that reach the mailbox but do not need to boot it. Importing is
 * harmless — registration is a side effect of modules/index.ts, and nothing in
 * the mailbox module runs at import time. An entry belongs here only when the
 * process calls no op that depends on the started singletons; each one names
 * why, and adding one is a deliberate act, not a way to quiet the tripwire.
 */
const NO_BOOT_REQUIRED: Record<string, string> = {
  'mcp-tools/memory-write-process-helper.ts':
    'imports mcp-tools/memory-write.ts for writeMemoryFile; the mailbox arrives via that module’s registerTools import and no mailbox op is ever called',
  'scheduling/wiki-lint-gate.ts':
    'calls exactly one op, readSeriesLastCompletedRun, which opens its own read-only inbound and outbound handles and closes them; the gate runs as a pre-task subprocess alongside the runner that owns outbound.db, so booting would make a read-only gate a second writer of the fork schema',
};

/** Modules whose functions all go through getAgentMailbox(). */
const MAILBOX_MODULES = [
  'mailbox/index.ts',
  'modules/mailbox/',
  'db/messages-in.ts',
  'db/messages-out.ts',
  'db/session-state.ts',
  'db/session-routing.ts',
  'db/container-state.ts',
  'db/delivery-acks.ts',
  'db/index.ts',
];

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function resolveImport(spec: string, from: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  const candidate = base.endsWith('.js') ? base.slice(0, -3) + '.ts' : base + '.ts';
  return fs.existsSync(candidate) ? candidate : null;
}

/** Every module the entrypoint pulls in, following static and dynamic imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [, spec] of source.matchAll(IMPORT_RE)) {
      const target = resolveImport(spec, file);
      if (target) stack.push(target);
    }
  }
  return seen;
}

const entrypoints = listSources(SRC)
  .filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return ENTRYPOINT_MARKERS.some((marker) => marker.test(source));
  })
  .map((file) => path.relative(SRC, file))
  .sort();

describe('container entrypoints boot the mailbox', () => {
  it('finds the known process entrypoints', () => {
    // A new entrypoint should land here deliberately, not by surprise.
    expect(entrypoints).toContain('index.ts');
    expect(entrypoints).toContain('mcp-tools/index.ts');
    expect(entrypoints).toContain('codex-hooks/cli.ts');
    expect(entrypoints).toContain('compact-instructions.ts');
  });

  it.each(entrypoints)('%s starts the mailbox if it can reach one', (relative) => {
    const entry = path.join(SRC, relative);
    const closure = importClosure(entry);
    const reaches = [...closure]
      .map((file) => path.relative(SRC, file))
      .some((file) => MAILBOX_MODULES.some((module) => file === module || file.startsWith(module)));
    if (!reaches) return;

    const source = fs.readFileSync(entry, 'utf8');
    const boots = source.includes('getAgentMailbox') && source.includes('.start(');
    if (NO_BOOT_REQUIRED[relative]) {
      expect(
        boots,
        `${relative} is allowlisted as not needing a boot but now boots the mailbox — drop it from NO_BOOT_REQUIRED`,
      ).toBe(false);
      return;
    }
    expect(
      boots,
      `${relative} can reach the mailbox but never calls start(). Add the modules/index.js barrel import ` +
        'and `await getAgentMailbox().start(await readMailboxContext())`, or add it to NO_BOOT_REQUIRED with ' +
        'the reason it calls no op that needs the started singletons.',
    ).toBe(true);
  });
});
