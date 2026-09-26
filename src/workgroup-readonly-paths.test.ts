import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';

import {
  parseWorkgroupReadonlyPaths,
  protectReadonlyHostPaths,
  readWorkgroupReadonlyPaths,
} from './workgroup-readonly-paths.js';

let root: string;

beforeEach(() => {
  root = uniqueTmpRoot('workgroup-readonly-paths');
  fs.mkdirSync(root, { recursive: true });
  root = fs.realpathSync(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function only(protectedPaths: string[]) {
  return { protectedPaths, lockedRoots: [] };
}

function quietly<T>(run: () => T): T {
  const error = vi.spyOn(log, 'error').mockImplementation(() => {});
  try {
    return run();
  } finally {
    error.mockRestore();
  }
}

function writePolicy(value: unknown): void {
  fs.writeFileSync(path.join(root, 'workgroup-readonly-paths.json'), JSON.stringify(value));
}

describe('parseWorkgroupReadonlyPaths', () => {
  it('accepts relative subpaths keyed by workgroup slug', () => {
    const parsed = parseWorkgroupReadonlyPaths(JSON.stringify({ version: 1, workgroups: { wg: ['a/b', 'c'] } }));
    expect(parsed.get('wg')).toEqual(['a/b', 'c']);
  });

  it.each([
    ['not json', '{'],
    ['wrong version', JSON.stringify({ version: 2, workgroups: {} })],
    ['extra key', JSON.stringify({ version: 1, workgroups: {}, extra: 1 })],
    ['bad slug', JSON.stringify({ version: 1, workgroups: { 'Bad/Id': ['a'] } })],
    ['absolute', JSON.stringify({ version: 1, workgroups: { wg: ['/etc'] } })],
    ['parent segment', JSON.stringify({ version: 1, workgroups: { wg: ['a/../../b'] } })],
    ['dot segment', JSON.stringify({ version: 1, workgroups: { wg: ['.'] } })],
    ['trailing slash', JSON.stringify({ version: 1, workgroups: { wg: ['a/'] } })],
    ['empty', JSON.stringify({ version: 1, workgroups: { wg: [''] } })],
    ['non-array', JSON.stringify({ version: 1, workgroups: { wg: 'a' } })],
  ])('rejects %s', (_label, contents) => {
    expect(() => parseWorkgroupReadonlyPaths(contents)).toThrow(/Invalid workgroup read-only path policy/);
  });
});

describe('readWorkgroupReadonlyPaths', () => {
  it('returns nothing without a policy file', () => {
    expect(readWorkgroupReadonlyPaths(root)).toEqual({ protectedPaths: [], lockedRoots: [] });
  });

  it('resolves existing subpaths and skips missing ones', () => {
    fs.mkdirSync(path.join(root, 'workgroups', 'wg', 'releases', 'ops'), { recursive: true });
    writePolicy({ version: 1, workgroups: { wg: ['releases/ops', 'releases/absent'], other: ['x'] } });
    expect(readWorkgroupReadonlyPaths(root)).toEqual({
      protectedPaths: [path.join(root, 'workgroups', 'wg', 'releases', 'ops')],
      lockedRoots: [],
    });
  });

  it('locks the workgroup when a subpath reaches its target through a symlink', () => {
    fs.mkdirSync(path.join(root, 'workgroups', 'wg', 'real'), { recursive: true });
    fs.symlinkSync('real', path.join(root, 'workgroups', 'wg', 'link'));
    writePolicy({ version: 1, workgroups: { wg: ['link'] } });
    expect(quietly(() => readWorkgroupReadonlyPaths(root))).toEqual({
      protectedPaths: [],
      lockedRoots: [path.join(root, 'workgroups', 'wg')],
    });
  });

  it('locks only the affected workgroup when a subpath is unreadable or loops', () => {
    const blocked = path.join(root, 'workgroups', 'wg', 'releases');
    fs.mkdirSync(path.join(blocked, 'ops'), { recursive: true });
    fs.mkdirSync(path.join(root, 'workgroups', 'looped'), { recursive: true });
    fs.symlinkSync('loop', path.join(root, 'workgroups', 'looped', 'loop'));
    fs.mkdirSync(path.join(root, 'workgroups', 'fine', 'ops'), { recursive: true });
    writePolicy({ version: 1, workgroups: { wg: ['releases/ops'], looped: ['loop'], fine: ['ops'] } });
    fs.chmodSync(blocked, 0o000);
    try {
      const result = quietly(() => readWorkgroupReadonlyPaths(root));
      expect(result.protectedPaths).toEqual([path.join(root, 'workgroups', 'fine', 'ops')]);
      expect(new Set(result.lockedRoots)).toEqual(
        new Set([path.join(root, 'workgroups', 'wg'), path.join(root, 'workgroups', 'looped')]),
      );
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });

  it('reports hard links and symlinks that give a protected file a writable name', () => {
    const ops = path.join(root, 'workgroups', 'wg', 'ops');
    fs.mkdirSync(path.join(ops, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(ops, 'nested', 'run.sh'), 'echo hi\n');
    fs.writeFileSync(path.join(ops, 'solo.sh'), 'echo solo\n');
    fs.linkSync(path.join(ops, 'nested', 'run.sh'), path.join(root, 'workgroups', 'wg', 'alias.sh'));
    fs.writeFileSync(path.join(root, 'workgroups', 'wg', 'notes.sh'), 'echo notes\n');
    fs.symlinkSync('../notes.sh', path.join(ops, 'out.sh'));
    fs.symlinkSync('solo.sh', path.join(ops, 'in.sh'));
    writePolicy({ version: 1, workgroups: { wg: ['ops'] } });
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      expect(readWorkgroupReadonlyPaths(root).protectedPaths).toEqual([ops]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][1]).toMatchObject({
        hardLinked: [path.join(ops, 'nested', 'run.sh')],
        escapingSymlinks: [path.join(ops, 'out.sh')],
      });
    } finally {
      error.mockRestore();
    }
  });

  it('throws on a malformed policy file', () => {
    fs.writeFileSync(path.join(root, 'workgroup-readonly-paths.json'), '{');
    expect(() => readWorkgroupReadonlyPaths(root)).toThrow(/JSON parse failed/);
  });
});

describe('protectReadonlyHostPaths', () => {
  it('returns the list untouched when nothing is protected', () => {
    const mounts = [{ hostPath: root, containerPath: '/w', readonly: false }];
    expect(protectReadonlyHostPaths(mounts, { protectedPaths: [], lockedRoots: [] })).toBe(mounts);
  });

  it('pins every intermediate directory and binds the target read-only', () => {
    const target = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(target, { recursive: true });
    const result = protectReadonlyHostPaths([{ hostPath: root, containerPath: '/w', readonly: false }], only([target]));
    expect(result).toEqual([
      { hostPath: root, containerPath: '/w', readonly: false },
      { hostPath: path.join(root, 'a'), containerPath: '/w/a', readonly: false, overlayAllowedRoots: [root] },
      { hostPath: path.join(root, 'a', 'b'), containerPath: '/w/a/b', readonly: false, overlayAllowedRoots: [root] },
      { hostPath: target, containerPath: '/w/a/b/c', readonly: true, overlayAllowedRoots: [root] },
    ]);
  });

  it('turns a writable mount at or inside a protected path read-only', () => {
    const target = path.join(root, 'ops');
    fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
    const result = protectReadonlyHostPaths(
      [
        { hostPath: target, containerPath: '/x', readonly: false },
        { hostPath: path.join(target, 'sub'), containerPath: '/y', readonly: false },
      ],
      only([target]),
    );
    expect(result.map((m) => m.readonly)).toEqual([true, true]);
  });

  it('ignores read-only mounts and mounts that do not contain the target', () => {
    const target = path.join(root, 'ops');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    const mounts = [
      { hostPath: root, containerPath: '/r', readonly: true },
      { hostPath: elsewhere, containerPath: '/e', readonly: false },
    ];
    expect(protectReadonlyHostPaths(mounts, only([target]))).toEqual(mounts);
  });

  it('does not duplicate the destination of a mount that already exists below the parent', () => {
    const memory = path.join(root, 'memory');
    const lock = path.join(root, '.write.lock');
    fs.mkdirSync(path.join(memory, 'scripts'), { recursive: true });
    fs.writeFileSync(lock, '');
    const result = protectReadonlyHostPaths(
      [
        { hostPath: root, containerPath: '/w', readonly: false },
        { hostPath: memory, containerPath: '/w/memory', readonly: false },
        { hostPath: lock, containerPath: '/w/.write.lock', readonly: false },
      ],
      only([path.join(memory, 'scripts'), lock]),
    );
    const destinations = result.map((m) => m.containerPath);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(result.find((m) => m.containerPath === '/w/memory')?.readonly).toBe(false);
    expect(result.find((m) => m.containerPath === '/w/memory/scripts')?.readonly).toBe(true);
    expect(result.find((m) => m.containerPath === '/w/.write.lock')?.readonly).toBe(true);
  });

  it('turns every writable mount reaching into a locked workgroup read-only, and nothing else', () => {
    const wg = path.join(root, 'wg');
    const other = path.join(root, 'other');
    fs.mkdirSync(path.join(wg, 'sub'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const result = protectReadonlyHostPaths(
      [
        { hostPath: wg, containerPath: '/w', readonly: false },
        { hostPath: path.join(wg, 'sub'), containerPath: '/s', readonly: false },
        { hostPath: root, containerPath: '/all', readonly: false },
        { hostPath: other, containerPath: '/o', readonly: false },
      ],
      { protectedPaths: [], lockedRoots: [wg] },
    );
    expect(result.map((m) => m.readonly)).toEqual([true, true, true, false]);
  });

  it('never leaves a pin writable when the pinned directory is itself protected', () => {
    const outer = path.join(root, 'rel');
    const inner = path.join(outer, 'ops', 'deep');
    fs.mkdirSync(inner, { recursive: true });
    const result = protectReadonlyHostPaths(
      [{ hostPath: root, containerPath: '/w', readonly: false }],
      only([inner, outer]),
    );
    const byPath = new Map(result.map((m) => [m.containerPath, m.readonly]));
    expect(byPath.get('/w/rel')).toBe(true);
    expect(byPath.get('/w/rel/ops')).toBe(true);
    expect(byPath.get('/w/rel/ops/deep')).toBe(true);
  });
});
