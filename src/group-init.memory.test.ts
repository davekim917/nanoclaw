import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareGroupCanonicalMemory } from './group-init.js';

describe('prepareGroupCanonicalMemory', () => {
  let tmp: string;
  let groupsDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-memory-init-'));
    groupsDir = path.join(tmp, 'groups');
    dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.join(groupsDir, 'alpha-codex'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a canonical workgroup memory target before installing the compatibility link', () => {
    const canonical = prepareGroupCanonicalMemory(
      {
        id: 'ag-alpha-codex',
        name: 'Alpha Codex',
        folder: 'alpha-codex',
        workgroup_id: 'alpha',
        agent_provider: 'codex',
        created_at: new Date().toISOString(),
      },
      { groupsDir, dataDir },
    );

    expect(canonical).toBe(path.join(dataDir, 'workgroups', 'alpha', 'memory'));
    expect(fs.lstatSync(canonical).isDirectory()).toBe(true);
    const local = path.join(groupsDir, 'alpha-codex', 'memory');
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(local)).toBe('/workspace/workgroup/memory');
  });

  it('blocks a substantive provider-local tree without changing its type or bytes', () => {
    const local = path.join(groupsDir, 'alpha-codex', 'memory');
    fs.mkdirSync(path.join(local, 'memories'), { recursive: true });
    fs.writeFileSync(path.join(local, 'memories', 'provider.md'), 'keep me\n');
    const before = fs.readFileSync(path.join(local, 'memories', 'provider.md'));

    expect(() =>
      prepareGroupCanonicalMemory(
        {
          id: 'ag-alpha-codex',
          name: 'Alpha Codex',
          folder: 'alpha-codex',
          workgroup_id: 'alpha',
          agent_provider: 'codex',
          created_at: new Date().toISOString(),
        },
        { groupsDir, dataDir },
      ),
    ).toThrow(/migration-required/);
    expect(fs.lstatSync(local).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(local, 'memories', 'provider.md'))).toEqual(before);
    expect(fs.existsSync(path.join(dataDir, 'workgroups', 'alpha', 'memory'))).toBe(false);
  });
});
