/**
 * Containment gate for the Agent Plugins reader.
 *
 * T5 PR 1 landed `src/templates/manifest.ts`, `src/templates/plugin-dir.ts` and
 * `src/templates/skills.ts` with zero callers. T5 PR 3 wires them into
 * `src/templates/parse.ts`, `src/templates/mcp.ts` and
 * `src/templates/create-agent.ts`, and that module is the ONLY place they may
 * be reached from: it owns the hardened copier and the per-component failure
 * boundaries, so a reader import anywhere else means plugin content is being
 * handled outside that boundary. The gate therefore stops asserting "no
 * callers" and starts asserting "only these callers", in both directions — a
 * new importer outside `src/templates/` fails, and so does a silent un-wiring
 * of the three the stamp path depends on.
 *
 * `mcpServerPluginOwner` keeps its own separate, EXACT allowlist. This
 * tripwire originally reserved that guard-site wiring for a planned "T5 PR 4":
 * T2 PR 3 landed it instead, so T5 PR 4 is a no-op for this site.
 * `ncl groups config add-mcp-server` and `config remove-mcp-server`
 * (`src/cli/resources/groups.ts`) refuse a direct edit of a plugin-owned MCP
 * server, the same refusal upstream's guard-site commit (6b08907a7) modeled,
 * reworded for the fork's lack of an in-place restamp verb. The T5 theme's
 * plan.md needs a one-line correction marking its former PR 4 as already done.
 * The allowlist below is EXACT, not a broad exemption, so the gate keeps its
 * tripwire value: a THIRD caller still fails this test.
 *
 * Modeled on src/request-wake-inert.test.ts (T0 PR 1's equivalent gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const TEMPLATES_DIR = path.join(SRC_DIR, 'templates');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

const READER_MODULES = new Set(['manifest.ts', 'plugin-dir.ts', 'skills.ts']);

const OWN_FILES = new Set([
  'templates/manifest.ts',
  'templates/plugin-dir.ts',
  'templates/plugin-dir.test.ts',
  'templates/skills.ts',
  'templates/plugin-reader-inert.test.ts',
]);

/**
 * EXACT allowlist, not a broad exemption — a third caller must still fail
 * this test. T2 PR 3 landed the guard-site wiring T5 PR 4 reserved; T5 PR 4
 * is a no-op for this site. See the module comment above.
 */
const GUARD_SITE_FILES = new Set([
  'cli/resources/groups.ts',
  'cli/resources/groups.test.ts',
  // The self-mod approval apply path writes the same map and shares the
  // centralised refusal (assertMcpServerNotPluginOwned) — Codex on #486.
  'modules/self-mod/apply.ts',
  'modules/self-mod/apply-plugin-owned.test.ts',
]);

/**
 * Relative-path importers of the three reader modules, resolved rather than
 * pattern-matched: within `src/templates/` the specifier is `./manifest.js`,
 * from anywhere else it is `../templates/manifest.js`, and a scan that only
 * knew one shape would silently pass on the other.
 */
function readerImporters(): string[] {
  const specifier = /from '(\.{1,2}\/[^']*)'/g;
  const importers: string[] = [];
  for (const file of listTsFiles(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    if (OWN_FILES.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(specifier)) {
      const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
      if (path.dirname(target) === TEMPLATES_DIR && READER_MODULES.has(path.basename(target))) {
        importers.push(rel);
        break;
      }
    }
  }
  return importers.sort();
}

describe('Agent Plugins reader leaves stay inside the templates module', () => {
  it('manifest.js, plugin-dir.js and skills.js are imported only from src/templates/', () => {
    expect(
      readerImporters().filter((rel) => !rel.startsWith('templates/')),
      'plugin content is handled inside src/templates/ only — that module owns the hardened copier ' +
        'and the per-component failure boundaries',
    ).toEqual([]);
  });

  it('the stamp path really is wired to them (a silent un-wiring fails here)', () => {
    expect(readerImporters()).toEqual(
      expect.arrayContaining(['templates/create-agent.ts', 'templates/mcp.ts', 'templates/parse.ts']),
    );
  });

  it('mcpServerPluginOwner is called only inside container-config.ts, its own test, and exactly the T2 PR 3 guard site', () => {
    const callSitePattern = /\bmcpServerPluginOwner\(/;
    const callers: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (
        rel === 'container-config.ts' ||
        rel === 'container-config.test.ts' ||
        OWN_FILES.has(rel) ||
        GUARD_SITE_FILES.has(rel)
      )
        continue;
      const source = fs.readFileSync(file, 'utf8');
      if (callSitePattern.test(source)) {
        callers.push(rel);
      }
    }
    expect(callers).toEqual([]);
  });
});
