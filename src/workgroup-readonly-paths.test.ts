import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(readWorkgroupReadonlyPaths(root)).toEqual([]);
  });

  it('resolves existing subpaths and skips missing ones', () => {
    fs.mkdirSync(path.join(root, 'workgroups', 'wg', 'releases', 'ops'), { recursive: true });
    writePolicy({ version: 1, workgroups: { wg: ['releases/ops', 'releases/absent'], other: ['x'] } });
    expect(readWorkgroupReadonlyPaths(root)).toEqual([path.join(root, 'workgroups', 'wg', 'releases', 'ops')]);
  });

  it('refuses a subpath that reaches its target through a symlink', () => {
    fs.mkdirSync(path.join(root, 'workgroups', 'wg', 'real'), { recursive: true });
    fs.symlinkSync('real', path.join(root, 'workgroups', 'wg', 'link'));
    writePolicy({ version: 1, workgroups: { wg: ['link'] } });
    expect(readWorkgroupReadonlyPaths(root)).toEqual([]);
  });

  it('throws on a malformed policy file', () => {
    fs.writeFileSync(path.join(root, 'workgroup-readonly-paths.json'), '{');
    expect(() => readWorkgroupReadonlyPaths(root)).toThrow(/JSON parse failed/);
  });
});

describe('protectReadonlyHostPaths', () => {
  it('returns the list untouched when nothing is protected', () => {
    const mounts = [{ hostPath: root, containerPath: '/w', readonly: false }];
    expect(protectReadonlyHostPaths(mounts, [])).toBe(mounts);
  });

  it('pins every intermediate directory and binds the target read-only', () => {
    const target = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(target, { recursive: true });
    const result = protectReadonlyHostPaths([{ hostPath: root, containerPath: '/w', readonly: false }], [target]);
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
      [target],
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
    expect(protectReadonlyHostPaths(mounts, [target])).toEqual(mounts);
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
      [path.join(memory, 'scripts'), lock],
    );
    const destinations = result.map((m) => m.containerPath);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(result.find((m) => m.containerPath === '/w/memory')?.readonly).toBe(false);
    expect(result.find((m) => m.containerPath === '/w/memory/scripts')?.readonly).toBe(true);
    expect(result.find((m) => m.containerPath === '/w/.write.lock')?.readonly).toBe(true);
  });

  it('never leaves a pin writable when the pinned directory is itself protected', () => {
    const outer = path.join(root, 'rel');
    const inner = path.join(outer, 'ops', 'deep');
    fs.mkdirSync(inner, { recursive: true });
    const result = protectReadonlyHostPaths([{ hostPath: root, containerPath: '/w', readonly: false }], [inner, outer]);
    const byPath = new Map(result.map((m) => [m.containerPath, m.readonly]));
    expect(byPath.get('/w/rel')).toBe(true);
    expect(byPath.get('/w/rel/ops')).toBe(true);
    expect(byPath.get('/w/rel/ops/deep')).toBe(true);
  });
});
