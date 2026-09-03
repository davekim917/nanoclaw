import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { STANDING_INSTRUCTIONS_FILE, readGroupPersona, stageGroupPersona } from './group-persona.js';
import { log } from './log.js';

const TMP = uniqueTmpRoot('group-persona-test');

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
    fs.writeFileSync(path.join(TMP, STANDING_INSTRUCTIONS_FILE), '  \n\n');
    expect(readGroupPersona(TMP)).toBeNull();
  });

  it('returns the trimmed content when present', () => {
    fs.writeFileSync(path.join(TMP, STANDING_INSTRUCTIONS_FILE), '\nYou are an SDR agent.\n\n');
    expect(readGroupPersona(TMP)).toBe('You are an SDR agent.');
  });

  // Sibling agents that build together share ONE instruction set by symlink,
  // so drift is impossible rather than merely detectable. Following is scoped
  // to the caller's allowed set: the group dir is mounted read-write into the
  // container, so an unrestricted symlink would let an agent point its own
  // always-on prompt at content outside its trust boundary.
  it('follows a symlink into a workgroup sibling the caller allows', () => {
    const root = path.join(TMP, 'groups');
    const source = path.join(root, 'source-group');
    const sibling = path.join(root, 'sibling-group');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(source, STANDING_INSTRUCTIONS_FILE), 'Shared standing instructions.\n');
    fs.symlinkSync(path.join(source, STANDING_INSTRUCTIONS_FILE), path.join(sibling, STANDING_INSTRUCTIONS_FILE));

    const roots = [sibling, source];
    expect(readGroupPersona(sibling, roots)).toBe('Shared standing instructions.');
    expect(readGroupPersona(source, roots)).toBe(readGroupPersona(sibling, roots));
    expect(log.warn).not.toHaveBeenCalled();
  });

  // The whole groups tree is NOT the boundary — a workgroup is. A container
  // mounts only its own group directory, so another workgroup's group holds
  // another tenant's CLAUDE.local.md and memory. Following a link there would
  // inject that tenant's content into this prompt.
  it('refuses a symlink into a group outside the caller-allowed workgroup', () => {
    const root = path.join(TMP, 'groups');
    const group = path.join(root, 'tenant-a-group');
    const otherTenant = path.join(root, 'tenant-b-group');
    fs.mkdirSync(group, { recursive: true });
    fs.mkdirSync(otherTenant, { recursive: true });
    const theirs = path.join(otherTenant, 'CLAUDE.local.md');
    fs.writeFileSync(theirs, 'other tenant scope rules\n');
    fs.symlinkSync(theirs, path.join(group, STANDING_INSTRUCTIONS_FILE));

    expect(readGroupPersona(group, [group])).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Group standing instructions symlink escapes its workgroup; omitting persona',
      expect.objectContaining({ target: theirs }),
    );
  });

  // A caller that forgets the sibling set must not silently widen the
  // boundary back to the whole tree.
  it('defaults to own-directory-only when no allowed set is given', () => {
    const root = path.join(TMP, 'groups');
    const group = path.join(root, 'source-group');
    const sibling = path.join(root, 'sibling-group');
    fs.mkdirSync(group, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, STANDING_INSTRUCTIONS_FILE), 'sibling content\n');
    fs.symlinkSync(path.join(sibling, STANDING_INSTRUCTIONS_FILE), path.join(group, STANDING_INSTRUCTIONS_FILE));

    expect(readGroupPersona(group)).toBeNull();
  });

  it('refuses a symlink that escapes the groups tree entirely', () => {
    const root = path.join(TMP, 'groups');
    const group = path.join(root, 'source-group');
    fs.mkdirSync(group, { recursive: true });
    const outside = path.join(TMP, 'outside.md');
    fs.writeFileSync(outside, 'host-only content\n');
    fs.symlinkSync(outside, path.join(group, STANDING_INSTRUCTIONS_FILE));

    expect(readGroupPersona(group, [group])).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'Group standing instructions symlink escapes its workgroup; omitting persona',
      expect.objectContaining({ target: outside }),
    );
  });
});

describe('stageGroupPersona', () => {
  it('creates standing instructions once, under the canonical filename', () => {
    expect(stageGroupPersona(TMP, 'You are concise.\n\n')).toBe(true);
    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(path.join(TMP, STANDING_INSTRUCTIONS_FILE), 'utf-8')).toBe('You are concise.\n');
  });

  it('does not replace an existing symlink', () => {
    const target = path.join(TMP, 'target.md');
    fs.writeFileSync(target, 'keep me\n');
    fs.symlinkSync(target, path.join(TMP, STANDING_INSTRUCTIONS_FILE));

    expect(stageGroupPersona(TMP, 'replacement')).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep me\n');
  });
});
