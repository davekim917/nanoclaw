/**
 * T5 PR 1 gate: the Agent Plugins reader leaves land with ZERO callers.
 *
 * This PR only adds `src/templates/manifest.ts`, `src/templates/plugin-dir.ts`
 * and `src/templates/skills.ts` (plus `mcpServerPluginOwner` in
 * `src/container-config.ts`) and their unit tests — it wires nothing into the
 * stamp path. T5 PR 3 (docs/specs/upstream-theme-ports/plan.md §4.4) is the
 * one that imports the reader into `src/templates/parse.ts` and
 * `src/templates/create-agent.ts`. This tripwire originally reserved the
 * `mcpServerPluginOwner` guard-site wiring for a planned "T5 PR 4": T2 PR 3
 * landed the guard-site wiring T5 PR 4 reserved; T5 PR 4 is a no-op for this
 * site. `ncl groups config add-mcp-server` and `config remove-mcp-server`
 * (`src/cli/resources/groups.ts`) refuse a direct edit of a plugin-owned MCP
 * server, the same refusal upstream's guard-site commit (6b08907a7) modeled,
 * reworded for the fork's lack of an in-place restamp verb. The T5 theme's
 * plan.md needs a one-line correction marking its former PR 4 as already
 * done. The allowlist below is EXACT, not a broad exemption, so the gate
 * keeps its tripwire value: a THIRD caller still fails this test. This
 * plain-text scan stays the tripwire for everything else: it fails the
 * moment any file outside this module's own sources/tests and the exact
 * guard site below imports one of the three reader modules, or calls
 * `mcpServerPluginOwner(`.
 *
 * Modeled on src/request-wake-inert.test.ts (T0 PR 1's equivalent gate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

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
const GUARD_SITE_FILES = new Set(['cli/resources/groups.ts', 'cli/resources/groups.test.ts']);

describe('Agent Plugins reader leaves have zero callers (T5 PR 1 — inert by design)', () => {
  it('nothing outside their own sources imports manifest.js, plugin-dir.js or skills.js', () => {
    const importPattern = /from ['"].*\/templates\/(manifest|plugin-dir|skills)\.js['"]/;
    const importers: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (OWN_FILES.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (importPattern.test(source)) {
        importers.push(rel);
      }
    }
    expect(importers).toEqual([]);
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
