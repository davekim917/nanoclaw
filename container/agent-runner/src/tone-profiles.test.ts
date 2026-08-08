import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isSafeProfileName,
  listToneProfileNames,
  readToneAuxFile,
  readToneProfile,
} from './tone-profiles.js';

let groupDir: string;
let sharedDir: string;
let dirs: string[];

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-'));
  groupDir = path.join(root, 'group');
  sharedDir = path.join(root, 'shared');
  fs.mkdirSync(groupDir);
  fs.mkdirSync(sharedDir);
  dirs = [groupDir, sharedDir];
});

afterEach(() => {
  fs.rmSync(path.dirname(groupDir), { recursive: true, force: true });
});

describe('tone profile resolution', () => {
  it('falls back to the shared set when the group has no profile of that name', () => {
    fs.writeFileSync(path.join(sharedDir, 'engineering.md'), 'shared voice');
    expect(readToneProfile('engineering', dirs)).toBe('shared voice');
  });

  it('resolves a group-only profile the shared set has never heard of', () => {
    // This is what makes a persona per-channel selectable without publishing
    // it: it lives in the private groups repo, chosen via default_tone.
    fs.writeFileSync(path.join(groupDir, 'jian-yang.md'), 'blunt, literal');
    expect(readToneProfile('jian-yang', dirs)).toBe('blunt, literal');
  });

  it('lets a group shadow a shared name for itself alone', () => {
    fs.writeFileSync(path.join(sharedDir, 'engineering.md'), 'shared voice');
    fs.writeFileSync(path.join(groupDir, 'engineering.md'), 'this group only');
    expect(readToneProfile('engineering', dirs)).toBe('this group only');
  });

  it('returns null for an unknown name rather than throwing', () => {
    expect(readToneProfile('nobody', dirs)).toBeNull();
  });

  it('lists both sets deduped, and hides the auxiliary files', () => {
    fs.writeFileSync(path.join(sharedDir, 'engineering.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, 'assistant.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, 'writing-rules.md'), 'x');
    fs.writeFileSync(path.join(sharedDir, 'selection-guide.md'), 'x');
    fs.writeFileSync(path.join(groupDir, 'engineering.md'), 'x');
    fs.writeFileSync(path.join(groupDir, 'gilfoyle.md'), 'x');
    expect(listToneProfileNames(dirs)).toEqual(['assistant', 'engineering', 'gilfoyle']);
  });

  it('reads an auxiliary file group-first', () => {
    fs.writeFileSync(path.join(sharedDir, 'writing-rules.md'), 'shared rules');
    expect(readToneAuxFile('writing-rules.md', dirs)).toBe('shared rules');
    fs.writeFileSync(path.join(groupDir, 'writing-rules.md'), 'group rules');
    expect(readToneAuxFile('writing-rules.md', dirs)).toBe('group rules');
  });
});

describe('profile names are a trust boundary', () => {
  // get_tone_profile takes its name from the agent, so an unconstrained name
  // reads any file in the container.
  it.each([
    '../../../etc/passwd',
    '..',
    'a/../../b',
    '/etc/passwd',
    'foo/bar',
    '',
    '.hidden',
  ])('rejects %p', (bad) => {
    expect(isSafeProfileName(bad)).toBe(false);
    expect(readToneProfile(bad, dirs)).toBeNull();
  });

  it('does not read a traversal target that actually exists', () => {
    const outside = path.join(path.dirname(groupDir), 'secret.md');
    fs.writeFileSync(outside, 'do not leak');
    expect(readToneProfile('../secret', dirs)).toBeNull();
  });

  it('accepts ordinary profile names', () => {
    for (const good of ['engineering', 'jian-yang', 'assistant', 'tone.v2']) {
      expect(isSafeProfileName(good)).toBe(true);
    }
  });
});
