import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { PERSONA_PREPEND_FILE, readGroupPersona, stageGroupPersona } from './group-persona.js';
import { log } from './log.js';

const TMP = '/tmp/nanoclaw-group-persona-test';

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('readGroupPersona', () => {
  it('returns null when the prepend file is absent', () => {
    expect(readGroupPersona(TMP)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only file', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, PERSONA_PREPEND_FILE), '\nYou are an SDR agent.\n\n');
    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.');
  });

  // Sibling agents that build together share ONE instruction set by symlink,
  // so drift is impossible rather than merely detectable. Following is scoped
  // to the groups tree: the group dir is mounted read-write into the container,
  // so an unrestricted symlink would let an agent point its own always-on
  // prompt at content outside its trust boundary.
  it('follows a symlink that resolves inside the groups tree', () => {
    const root = path.join(TMP, 'groups');
    const source = path.join(root, 'source-group');
    const sibling = path.join(root, 'sibling-group');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(source, PERSONA_PREPEND_FILE), 'Shared standing instructions.\n');
    fs.symlinkSync(path.join(source, PERSONA_PREPEND_FILE), path.join(sibling, PERSONA_PREPEND_FILE));

    expect(readGroupPersona(sibling)).toBe('Shared standing instructions.');
    expect(readGroupPersona(source)).toBe(readGroupPersona(sibling));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('refuses a symlink that escapes the groups tree', () => {
    const root = path.join(TMP, 'groups');
    const group = path.join(root, 'source-group');
    fs.mkdirSync(group, { recursive: true });
    const outside = path.join(TMP, 'outside.md');
    fs.writeFileSync(outside, 'host-only content\n');
    fs.symlinkSync(outside, path.join(group, PERSONA_PREPEND_FILE));

    expect(readGroupPersona(group)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Group standing instructions symlink escapes the groups tree; omitting persona',
      expect.objectContaining({ target: outside }),
    );
  });
});

describe('stageGroupPersona', () => {
  it('creates standing instructions once', () => {
    expect(stageGroupPersona(TMP, 'You are concise.\n\n')).toBe(true);
    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(path.join(TMP, PERSONA_PREPEND_FILE), 'utf-8')).toBe('You are concise.\n');
  });

  it('does not replace an existing symlink', () => {
    const target = path.join(TMP, 'target.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.symlinkSync(target, path.join(TMP, PERSONA_PREPEND_FILE));

    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });
});
