/**
 * T5 PR 1 gate: the Agent Plugins reader leaves land with ZERO callers.
 *
 * This PR only adds `src/templates/manifest.ts`, `src/templates/plugin-dir.ts`
 * and `src/templates/skills.ts` (plus `mcpServerPluginOwner` in
 * `src/container-config.ts`) and their unit tests — it wires nothing into the
 * stamp path. T5 PR 3 (docs/specs/upstream-theme-ports/plan.md §4.4) is the
 * one that imports the reader into `src/templates/parse.ts` and
 * `src/templates/create-agent.ts`, and T5 PR 4 (§4.5) is the one that calls
 * `mcpServerPluginOwner` from the guard sites. Until then, this plain-text
 * scan is the tripwire: it fails the moment any file outside this module's
 * own sources and tests imports one of the three new modules, or calls
 * `mcpServerPluginOwner(`, which would mean a call site landed here by
 * accident ahead of its own PR.
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

  it('mcpServerPluginOwner is called only inside container-config.ts and its own test', () => {
    const callSitePattern = /\bmcpServerPluginOwner\(/;
    const callers: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (rel === 'container-config.ts' || rel === 'container-config.test.ts' || OWN_FILES.has(rel)) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (callSitePattern.test(source)) {
        callers.push(rel);
      }
    }
    expect(callers).toEqual([]);
  });
});
