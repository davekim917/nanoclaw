import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isSafeInstructionsProfileName,
  listChannelInstructionsNames,
  readChannelInstructions,
  resolveChannelInstructionsPath,
} from './channel-instructions.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-instr-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('channel instructions resolution', () => {
  it('reads the profile the host named', () => {
    fs.writeFileSync(path.join(dir, 'lab.md'), 'You may only write to lab-* repos.');
    expect(readChannelInstructions('lab', dir)).toBe('You may only write to lab-* repos.');
  });

  it('returns null for a name with no file — a renamed profile must not fail the session', () => {
    expect(readChannelInstructions('lab', dir)).toBeNull();
    expect(resolveChannelInstructionsPath('lab', dir)).toBeNull();
  });

  it('returns null when the mount itself is absent', () => {
    // The normal case for every channel that never set a profile: the host
    // pushes no mount at all, so the directory does not exist.
    expect(readChannelInstructions('lab', path.join(dir, 'nope'))).toBeNull();
    expect(listChannelInstructionsNames(path.join(dir, 'nope'))).toEqual([]);
  });

  it('treats a whitespace-only profile as absent rather than injecting an empty heading', () => {
    fs.writeFileSync(path.join(dir, 'lab.md'), '   \n\n');
    expect(readChannelInstructions('lab', dir)).toBeNull();
  });

  it('trims trailing whitespace so the block joins cleanly', () => {
    fs.writeFileSync(path.join(dir, 'lab.md'), '\nlab rules\n\n\n');
    expect(readChannelInstructions('lab', dir)).toBe('lab rules');
  });

  it('lists the profiles present, sorted', () => {
    fs.writeFileSync(path.join(dir, 'support.md'), 'x');
    fs.writeFileSync(path.join(dir, 'lab.md'), 'y');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'z');
    expect(listChannelInstructionsNames(dir)).toEqual(['lab', 'support']);
  });
});

describe('profile name safety', () => {
  it.each(['ops', 'field-team', 'ops2', 'a'])('accepts %s', (name) => {
    expect(isSafeInstructionsProfileName(name)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['Lab', 'uppercase'],
    ['-lab', 'leading dash'],
    ['lab_x', 'underscore'],
    ['lab.md', 'dot'],
    ['lab profile', 'space'],
    ['../etc/passwd', 'path traversal'],
    ['..', 'parent'],
    ['/etc/passwd', 'absolute path'],
    ['lab/../../etc/passwd', 'embedded traversal'],
  ])('rejects %s (%s)', (name) => {
    expect(isSafeInstructionsProfileName(name)).toBe(false);
  });

  it('refuses to read through an unsafe name even when a matching file exists', () => {
    // The name arrives as an env string from the host. Without the gate the
    // join is a read of any .md on the container FS.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-instr-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.md'), 'other tenant');
      const traversal = path.join('..', path.basename(outside), 'secret');
      expect(fs.existsSync(path.join(dir, `${traversal}.md`))).toBe(true);
      expect(readChannelInstructions(traversal, dir)).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('injection wiring in index.ts', () => {
  // The block is assembled inside main(), which boots a provider and a poll
  // loop and cannot be called from a unit test. These pin the two properties
  // that would fail silently: the ordering against tone, and the fact that
  // the block rides systemContext.instructions, which is the only path every
  // provider reads.
  const source = fs.readFileSync(path.join(import.meta.dir, 'index.ts'), 'utf8');

  it('injects operating rules BEFORE the voice block', () => {
    // Rules the agent reads after being told how to sound are rules it has
    // already had a chance to break.
    expect(source).toContain(
      'const baseInstructions = [channelInstructionsBlock, toneBlock, capabilityNote, addendum]',
    );
  });

  it('labels the block with the profile name', () => {
    expect(source).toContain('# Channel instructions (${instructionsProfile})');
  });

  it('reads the profile name from the env the host forwards', () => {
    expect(source).toContain('process.env.NANOCLAW_INSTRUCTIONS_PROFILE');
  });

  it('validates the name before touching the filesystem', () => {
    expect(source).toContain('isSafeInstructionsProfileName(instructionsProfile)');
  });

  it('carries the block on systemContext.instructions, the path all three providers read', () => {
    expect(source).toContain('const instructions = baseInstructions;');
    expect(source).toContain('systemContext: { instructions }');
  });
});
