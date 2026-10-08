import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { brokenDependencyLinks, describeBrokenDependencyLink } from './dependency-links.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-links-')));
  roots.push(root);
  return root;
}

/** A pnpm-shaped install: real packages under `.pnpm`, relative links at the top level and in one scope. */
function pnpmTree(root: string): string {
  const modules = path.join(root, 'node_modules');
  for (const pkg of ['left@1.0.0/node_modules/left', '@scope+right@1.0.0/node_modules/@scope/right']) {
    fs.mkdirSync(path.join(modules, '.pnpm', pkg), { recursive: true });
  }
  fs.mkdirSync(path.join(modules, '.bin'));
  fs.writeFileSync(path.join(modules, '.bin', 'left'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(modules, '.modules.yaml'), 'virtualStoreDir: .pnpm\n');
  fs.symlinkSync('.pnpm/left@1.0.0/node_modules/left', path.join(modules, 'left'));
  fs.mkdirSync(path.join(modules, '@scope'));
  fs.symlinkSync('../.pnpm/@scope+right@1.0.0/node_modules/@scope/right', path.join(modules, '@scope', 'right'));
  return modules;
}

describe('brokenDependencyLinks', () => {
  it('reports nothing for a missing node_modules or a self-contained install', () => {
    const root = tempRoot();
    expect(brokenDependencyLinks(root)).toEqual([]);
    pnpmTree(root);
    expect(brokenDependencyLinks(root)).toEqual([]);
  });

  it('flags top-level and scoped links whose target leaves node_modules, even when the target exists', () => {
    const root = tempRoot();
    const modules = pnpmTree(root);
    const other = tempRoot();
    fs.mkdirSync(path.join(other, 'node_modules', '.pnpm', 'esc@1.0.0', 'node_modules', 'esc'), { recursive: true });
    const escaped = path.relative(
      modules,
      path.join(other, 'node_modules', '.pnpm', 'esc@1.0.0', 'node_modules', 'esc'),
    );
    fs.symlinkSync(escaped, path.join(modules, 'esc'));
    fs.symlinkSync(path.join(other, 'node_modules'), path.join(modules, '@scope', 'abs'));

    const broken = brokenDependencyLinks(root);
    expect(broken.map((b) => [path.relative(root, b.link), b.reason])).toEqual([
      ['node_modules/@scope/abs', 'escapes'],
      ['node_modules/esc', 'escapes'],
    ]);
    expect(describeBrokenDependencyLink(root, broken[1]!)).toBe(`node_modules/esc -> ${escaped} (escapes)`);
  });

  it('flags a lexically in-tree link whose .pnpm entry is itself a link out of the tree', () => {
    const root = tempRoot();
    const modules = pnpmTree(root);
    const other = tempRoot();
    fs.mkdirSync(path.join(other, 'mid@1.0.0', 'node_modules', 'mid'), { recursive: true });
    fs.symlinkSync(path.join(other, 'mid@1.0.0'), path.join(modules, '.pnpm', 'mid@1.0.0'));
    fs.symlinkSync('.pnpm/mid@1.0.0/node_modules/mid', path.join(modules, 'mid'));
    expect(brokenDependencyLinks(root)).toEqual([
      { link: path.join(modules, 'mid'), target: '.pnpm/mid@1.0.0/node_modules/mid', reason: 'escapes' },
    ]);
  });

  it('flags a link inside node_modules whose target is gone', () => {
    const root = tempRoot();
    const modules = pnpmTree(root);
    fs.symlinkSync('.pnpm/gone@1.0.0/node_modules/gone', path.join(modules, 'gone'));
    expect(brokenDependencyLinks(root)).toEqual([
      { link: path.join(modules, 'gone'), target: '.pnpm/gone@1.0.0/node_modules/gone', reason: 'dangling' },
    ]);
  });

  it('flags node_modules that is itself a link, live or dangling', () => {
    const root = tempRoot();
    const other = tempRoot();
    fs.symlinkSync(path.join(other, 'node_modules'), path.join(root, 'node_modules'));
    expect(brokenDependencyLinks(root).map((b) => b.reason)).toEqual(['dangling']);
    fs.mkdirSync(path.join(other, 'node_modules'));
    expect(brokenDependencyLinks(root).map((b) => b.reason)).toEqual(['escapes']);
  });

  it('does not descend into .pnpm, where the store links between packages', () => {
    const root = tempRoot();
    const modules = pnpmTree(root);
    fs.symlinkSync('/nowhere', path.join(modules, '.pnpm', 'left@1.0.0', 'node_modules', 'peer'));
    expect(brokenDependencyLinks(root)).toEqual([]);
  });
});
