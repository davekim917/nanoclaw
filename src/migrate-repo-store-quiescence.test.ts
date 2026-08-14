import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { extendProtectedInodeInventory, pidsWithOpenFilesBelow } from './repository-migration-quiescence.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(...fields: string[]): Buffer {
  return Buffer.from(`${fields.join('\0\n')}\0`, 'utf8');
}

describe('migration writer-quiescence snapshot', () => {
  it('finds only foreign PIDs with open paths contained by a protected root', () => {
    const root = '/srv/nanoclaw/workgroup';
    expect(
      pidsWithOpenFilesBelow(
        [root],
        snapshot(
          'p100',
          `n${root}/repo/file.txt`,
          'p200',
          `n${root}/repo/index.lock`,
          'p300',
          `n${root}-lookalike/repo/file.txt`,
          'p400',
          'npipe',
        ),
        100,
      ),
    ).toEqual(['200']);
  });

  it('keeps deleted open files in scope and returns deterministic unique PIDs', () => {
    const root = '/srv/nanoclaw/workgroup';
    expect(
      pidsWithOpenFilesBelow(
        [root],
        snapshot(
          'p42',
          `n${root}/repo/index.lock (deleted)`,
          `n${root}/repo/objects/pack.tmp`,
          'p7',
          `n${root}/repo/config`,
        ),
        999,
      ),
    ).toEqual(['7', '42']);
  });

  it('matches an open path through the real target of a protected symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-quiescence-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    expect(pidsWithOpenFilesBelow([alias], snapshot('p88', `n${target}/index.lock`), 999)).toEqual(['88']);
  });

  it('matches a protected inode opened through a hard link outside the protected root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-quiescence-'));
    temporaryRoots.push(root);
    const protectedRoot = path.join(root, 'protected');
    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(outsideRoot);
    const protectedFile = path.join(protectedRoot, 'index.lock');
    const outsideLink = path.join(outsideRoot, 'external-index.lock');
    fs.writeFileSync(protectedFile, 'lock');
    fs.linkSync(protectedFile, outsideLink);
    const stat = fs.lstatSync(protectedFile, { bigint: true });
    const inventory = extendProtectedInodeInventory([protectedRoot]);
    expect(
      pidsWithOpenFilesBelow(
        [protectedRoot],
        snapshot('p91', `D0x${stat.dev.toString(16)}`, `i${stat.ino}`, `n${outsideLink}`),
        999,
        inventory.inodes,
      ),
    ).toEqual(['91']);
  });

  it('extends subset coverage when a later boundary adds a new protected root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-quiescence-'));
    temporaryRoots.push(root);
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(first, 'one'), 'one');
    const secondFile = path.join(second, 'two');
    const secondAlias = path.join(outside, 'two-link');
    fs.writeFileSync(secondFile, 'two');
    fs.linkSync(secondFile, secondAlias);
    const secondStat = fs.lstatSync(secondFile, { bigint: true });
    const inventory = extendProtectedInodeInventory([first]);
    expect(
      pidsWithOpenFilesBelow(
        [first, second],
        snapshot('p92', `D0x${secondStat.dev.toString(16)}`, `i${secondStat.ino}`, `n${secondAlias}`),
        999,
        inventory.inodes,
      ),
    ).toEqual([]);
    extendProtectedInodeInventory([first, second], inventory);
    expect(
      pidsWithOpenFilesBelow(
        [first, second],
        snapshot('p92', `D0x${secondStat.dev.toString(16)}`, `i${secondStat.ino}`, `n${secondAlias}`),
        999,
        inventory.inodes,
      ),
    ).toEqual(['92']);
  });

  it('skips planned-absent roots and captures them when a later resume boundary creates them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-quiescence-'));
    temporaryRoots.push(root);
    const planned = path.join(root, 'not-created-yet', 'topic');
    const inventory = extendProtectedInodeInventory([planned]);
    expect(inventory.inodes.size).toBe(0);
    expect(inventory.coveredRoots.size).toBe(0);
    fs.mkdirSync(planned, { recursive: true });
    const created = path.join(planned, 'index');
    fs.writeFileSync(created, 'index');
    const stat = fs.lstatSync(created, { bigint: true });
    extendProtectedInodeInventory([planned], inventory);
    expect(
      pidsWithOpenFilesBelow(
        [planned],
        snapshot('p93', `D0x${stat.dev.toString(16)}`, `i${stat.ino}`, 'n/outside/index-link'),
        999,
        inventory.inodes,
      ),
    ).toEqual(['93']);
  });

  it('refreshes a covered mutable root after migration creates a new descendant inode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-quiescence-'));
    temporaryRoots.push(root);
    const protectedRoot = path.join(root, 'protected');
    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(protectedRoot);
    fs.mkdirSync(outsideRoot);
    const inventory = extendProtectedInodeInventory([protectedRoot]);
    const created = path.join(protectedRoot, 'new-canonical', 'index');
    const alias = path.join(outsideRoot, 'new-canonical-index');
    fs.mkdirSync(path.dirname(created));
    fs.writeFileSync(created, 'index');
    fs.linkSync(created, alias);
    const stat = fs.lstatSync(created, { bigint: true });
    const openAlias = snapshot('p94', `D0x${stat.dev.toString(16)}`, `i${stat.ino}`, `n${alias}`);
    expect(pidsWithOpenFilesBelow([protectedRoot], openAlias, 999, inventory.inodes)).toEqual([]);
    extendProtectedInodeInventory([protectedRoot], inventory, { refresh: true });
    expect(pidsWithOpenFilesBelow([protectedRoot], openAlias, 999, inventory.inodes)).toEqual(['94']);
  });
});
