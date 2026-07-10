/**
 * Fixture acceptance harness (Group A2 / SC3): the slop fixtures must fail the
 * linter and the good fixtures must pass it. Proves the fixtures are valid test
 * inputs AND exercises the linter on realistic artifacts.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { lintArtifact, maxSeverity } from './linter.js';

const FIX = [
  path.resolve(import.meta.dir, '../skills/design-artifact-loop/fixtures'), // plugin-repo layout
  path.resolve(import.meta.dir, '../../../../skills/design-artifact-loop/fixtures'), // vendored NanoClaw layout
].find((p) => fs.existsSync(p))!;
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf-8');

const SURFACES = ['kanban', 'settings', 'pricing'];

describe('fixture acceptance harness', () => {
  for (const s of SURFACES) {
    it(`test_${s}_good_passes_linter`, () => {
      const findings = lintArtifact(read(`${s}-good.html`));
      expect(findings.filter((f) => f.severity === 'high')).toHaveLength(0);
    });

    it(`test_${s}_slop_flags_linter`, () => {
      const findings = lintArtifact(read(`${s}-slop.html`));
      expect(maxSeverity(findings)).toBe('high'); // hardcoded hex outside :root
      // and an AI-tell font (Inter/Roboto)
      expect(findings.some((f) => f.id.startsWith('font-denylist:'))).toBe(true);
    });
  }

  it('test_vision_sentinel_detail_is_render_only', () => {
    const src = read('vision-sentinel.html');
    // the pass-detail (upper wedge renders "green") must NOT be inferable from source text
    expect(src.toLowerCase()).not.toContain('green');
    expect(src.toLowerCase()).not.toContain('cyan');
    // it IS a clean artifact otherwise (tokens in :root, no script)
    expect(lintArtifact(src).filter((f) => f.severity === 'high')).toHaveLength(0);
  });
});
