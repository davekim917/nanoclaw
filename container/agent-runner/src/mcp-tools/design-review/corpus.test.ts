/**
 * Corpus integrity (Group D): the vendored design-system index and dirs stay in sync,
 * each system has its DESIGN.md + tokens.css with a :root token block, and the
 * Apache-2.0 LICENSE + attribution are present (C5).
 *
 * Lives in the server test tree (not the skill dir) so it runs in `bun test`.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Resolve the corpus wherever this file lives (plugin repo or vendored tree).
const CORPUS = [
  path.resolve(import.meta.dir, '../skills/design-artifact-loop/design-systems'), // plugin-repo layout
  path.resolve(import.meta.dir, '../../../../skills/design-artifact-loop/design-systems'), // vendored consumer-tree layout
].find((p) => fs.existsSync(p))!;

function systemDirs(): string[] {
  return fs.readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
function indexEntries(): string[] {
  const md = fs.readFileSync(path.join(CORPUS, 'index.md'), 'utf-8');
  return Array.from(md.matchAll(/^\| `([a-z0-9-]+)` \|/gm), (m) => m[1]);
}

describe('design-system corpus integrity', () => {
  it('test_index_entries_map_to_dirs', () => {
    const dirs = new Set(systemDirs());
    for (const name of indexEntries()) {
      expect(dirs.has(name)).toBe(true);
      expect(fs.existsSync(path.join(CORPUS, name, 'DESIGN.md'))).toBe(true);
    }
  });

  it('test_no_orphan_dirs', () => {
    const entries = new Set(indexEntries());
    for (const name of systemDirs()) {
      expect(entries.has(name)).toBe(true);
    }
  });

  it('test_each_system_has_design_and_tokens_with_root', () => {
    for (const name of systemDirs()) {
      const tokens = path.join(CORPUS, name, 'tokens.css');
      expect(fs.existsSync(path.join(CORPUS, name, 'DESIGN.md'))).toBe(true);
      expect(fs.existsSync(tokens)).toBe(true);
      expect(fs.readFileSync(tokens, 'utf-8')).toContain(':root');
    }
  });

  it('test_license_and_attribution_present', () => {
    expect(fs.existsSync(path.join(CORPUS, 'LICENSE'))).toBe(true);
    expect(fs.readFileSync(path.join(CORPUS, 'LICENSE'), 'utf-8')).toContain('Apache License');
    const attr = fs.readFileSync(path.join(CORPUS, 'ATTRIBUTION.md'), 'utf-8');
    expect(attr).toContain('nexu-io/open-design');
  });

  it('test_curated_count_is_reasonable', () => {
    expect(systemDirs().length).toBeGreaterThanOrEqual(15);
    expect(systemDirs().length).toBeLessThanOrEqual(25);
  });
});
