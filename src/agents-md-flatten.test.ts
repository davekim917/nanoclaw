/**
 * Tests for the CLAUDE.md → AGENTS.md flattener.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { flattenClaudeMd } from './agents-md-flatten.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe('flattenClaudeMd', () => {
  it('returns content unchanged when no @-includes', () => {
    const file = write('CLAUDE.md', '# Title\n\nBody text\n');
    expect(flattenClaudeMd(file)).toBe('# Title\n\nBody text\n');
  });

  it('inlines a relative @-include', () => {
    write('included.md', 'INCLUDED_CONTENT_LINE\n');
    const file = write('CLAUDE.md', '# Top\n@./included.md\nAfter\n');
    const out = flattenClaudeMd(file);
    expect(out).toContain('INCLUDED_CONTENT_LINE');
    expect(out).toContain('# Top');
    expect(out).toContain('After');
    expect(out).not.toContain('@./included.md');
  });

  it('inlines an absolute @-include', () => {
    const inc = write('inc-abs.md', 'ABS_INCLUDE\n');
    const file = write('CLAUDE.md', `# Top\n@${inc}\n`);
    const out = flattenClaudeMd(file);
    expect(out).toContain('ABS_INCLUDE');
  });

  it('inlines recursively (include-of-include)', () => {
    write('inner.md', 'INNER\n');
    write('middle.md', 'MIDDLE_START\n@./inner.md\nMIDDLE_END\n');
    const file = write('CLAUDE.md', 'TOP\n@./middle.md\n');
    const out = flattenClaudeMd(file);
    expect(out).toContain('TOP');
    expect(out).toContain('MIDDLE_START');
    expect(out).toContain('INNER');
    expect(out).toContain('MIDDLE_END');
  });

  it('detects cycles and emits a marker comment', () => {
    const a = path.join(tmpDir, 'a.md');
    const b = path.join(tmpDir, 'b.md');
    fs.writeFileSync(a, 'A\n@./b.md\n');
    fs.writeFileSync(b, 'B\n@./a.md\n');
    const out = flattenClaudeMd(a);
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toMatch(/cycle detected/);
  });

  it('emits marker comment for missing include (no silent drop)', () => {
    const file = write('CLAUDE.md', 'TOP\n@./does-not-exist.md\nEND\n');
    const out = flattenClaudeMd(file);
    expect(out).toMatch(/failed to read/);
    expect(out).toContain('TOP');
    expect(out).toContain('END');
  });

  it('ignores email-like patterns and bare @identifier', () => {
    const file = write('CLAUDE.md', 'Contact me at alice@example.com.\n@param foo\nNormal line.\n');
    const out = flattenClaudeMd(file);
    expect(out).toContain('alice@example.com');
    expect(out).toContain('@param foo');
  });

  it('does not treat prose lines starting with `@-word ...` as an include', () => {
    // Field-observed: the line "  @-mention itself is the signal." in
    // container/CLAUDE.md got parsed as `@-mention itself is the signal.`
    // because the ref contains a `.` (matches the path heuristic) and the
    // hyphen after `@` skipped the `@\w+` bare-identifier guard. The
    // compositor tried to read the file and spliced an ENOENT marker
    // mid-sentence into the AGENTS.md that codex agents read. The
    // whitespace-in-ref guard catches all prose-shaped lines.
    const file = write('CLAUDE.md', '  @-mention itself is the signal.\nNormal line.\n');
    const out = flattenClaudeMd(file);
    expect(out).toContain('@-mention itself is the signal.');
    expect(out).not.toContain('agents-md-flatten: failed');
  });

  it('translates container paths via the prefix map', () => {
    fs.mkdirSync(path.join(tmpDir, 'container'));
    fs.writeFileSync(path.join(tmpDir, 'container', 'global.md'), 'CONTAINER_GLOBAL\n');
    const file = write('CLAUDE.md', '@/app/global.md\n');
    const out = flattenClaudeMd(file, {
      containerToHost: { '/app': path.join(tmpDir, 'container') },
    });
    expect(out).toContain('CONTAINER_GLOBAL');
  });

  it('follows symlinks (after translation) to read target file', () => {
    const realFile = write('real.md', 'VIA_SYMLINK\n');
    const linkPath = path.join(tmpDir, 'link.md');
    fs.symlinkSync(realFile, linkPath);
    const file = write('CLAUDE.md', '@./link.md\n');
    expect(flattenClaudeMd(file)).toContain('VIA_SYMLINK');
  });

  it('preserves leading whitespace on non-@ lines', () => {
    const file = write('CLAUDE.md', '  - bullet\n    - nested\n');
    expect(flattenClaudeMd(file)).toBe('  - bullet\n    - nested\n');
  });

  // A caller reading from a container-writable directory (e.g. a fleet
  // metrics job) can't trust an @-import target blind — see FlattenOptions.
  // validateRead is the opt-in gate; compose's own calls never set it, so
  // every test above (unaffected) is the "default unchanged" half of this
  // contract, and this is the "gate actually skips the read" half.
  it('validateRead can skip a read, replacing it with a comment marker instead of the content', () => {
    const included = write('included.md', 'SHOULD_NOT_APPEAR\n');
    const file = write('CLAUDE.md', 'TOP\n@./included.md\nEND\n');
    const out = flattenClaudeMd(file, {
      validateRead: (realPath) => (realPath === included ? 'blocked by test gate' : undefined),
    });
    expect(out).not.toContain('SHOULD_NOT_APPEAR');
    expect(out).toMatch(/skipped.*blocked by test gate/);
    expect(out).toContain('TOP');
    expect(out).toContain('END');
  });

  it('validateRead also gates the top-level file, not just nested includes', () => {
    const file = write('CLAUDE.md', 'SHOULD_NOT_APPEAR\n');
    const out = flattenClaudeMd(file, { validateRead: () => 'blocked' });
    expect(out).not.toContain('SHOULD_NOT_APPEAR');
    expect(out).toMatch(/skipped/);
  });
});
