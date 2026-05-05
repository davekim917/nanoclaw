import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CC_PROJECTS_DIR, GROUPS_DIR } from '../config.js';
import { discoverMemoryGroups } from './index.js';
import * as containerConfig from '../container-config.js';

/**
 * Tests for discoverMemoryGroups — the dual-source group discovery introduced
 * in step 2 (commit 6c72037). Walks GROUPS_DIR (legacy agent groups) AND
 * CC_PROJECTS_DIR (host CC sessions), returning a unified list. The CC walk
 * was untested by the refactor's mechanical test updates; these tests cover
 * the new path explicitly.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create fs spies that route directory reads, stat, and existsSync to a
 * fixture map. Any path not in the map falls through to default behavior
 * (typically rejecting via thrown ENOENT for readdir/stat).
 */
function mockFs(opts: {
  groupsDirEntries?: string[];
  ccDirEntries?: string[];
  // Map of "path → exists" for fs.existsSync. Used to express marker presence.
  existing?: Record<string, boolean>;
  // Set of paths whose stat should report isDirectory=true. All others throw.
  directories?: Set<string>;
}): void {
  const dirs = opts.directories ?? new Set<string>();

  vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s === GROUPS_DIR) return (opts.groupsDirEntries ?? []) as unknown as fs.Dirent[];
    if (s === CC_PROJECTS_DIR) {
      if (opts.ccDirEntries === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return opts.ccDirEntries as unknown as fs.Dirent[];
    }
    return [] as unknown as fs.Dirent[];
  }) as unknown as typeof fs.readdirSync);

  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (dirs.has(s)) return { isDirectory: () => true } as fs.Stats;
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }) as unknown as typeof fs.statSync);

  vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
    return Boolean(opts.existing?.[String(p)]);
  }) as unknown as typeof fs.existsSync);
}

describe('discoverMemoryGroups', () => {
  it('returns CC project as cc-<slug> group when .memory-enabled marker is present', () => {
    const slug = '-home-ubuntu-test-project';
    const projectPath = path.join(CC_PROJECTS_DIR, slug);
    mockFs({
      groupsDirEntries: [],
      ccDirEntries: [slug],
      directories: new Set([projectPath]),
      existing: { [path.join(projectPath, '.memory-enabled')]: true },
    });

    const groups = discoverMemoryGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      agentGroupId: `cc-${slug}`,
      folder: slug,
      sourcesBasePath: projectPath,
      enabled: true,
    });
  });

  it('skips CC projects without the .memory-enabled marker', () => {
    const slug = '-home-ubuntu-unmarked';
    const projectPath = path.join(CC_PROJECTS_DIR, slug);
    mockFs({
      groupsDirEntries: [],
      ccDirEntries: [slug],
      directories: new Set([projectPath]),
      existing: {}, // no marker file
    });

    expect(discoverMemoryGroups()).toEqual([]);
  });

  it('skips non-directory CC entries even with marker (defensive against stray files)', () => {
    const slug = 'not-a-dir';
    mockFs({
      groupsDirEntries: [],
      ccDirEntries: [slug],
      directories: new Set(), // entry not in directories set → statSync throws
      existing: { [path.join(CC_PROJECTS_DIR, slug, '.memory-enabled')]: true },
    });

    expect(discoverMemoryGroups()).toEqual([]);
  });

  it('returns empty when CC_PROJECTS_DIR does not exist (best-effort behavior)', () => {
    mockFs({
      groupsDirEntries: [],
      ccDirEntries: undefined, // makes readdirSync throw ENOENT for CC_PROJECTS_DIR
    });

    expect(discoverMemoryGroups()).toEqual([]);
  });

  it('discovers CC and GROUPS_DIR groups together', () => {
    const ccSlug = '-home-ubuntu-cc-side';
    const ccPath = path.join(CC_PROJECTS_DIR, ccSlug);
    const groupFolder = 'illysium';
    const groupPath = path.join(GROUPS_DIR, groupFolder);

    mockFs({
      groupsDirEntries: [groupFolder],
      ccDirEntries: [ccSlug],
      directories: new Set([ccPath, groupPath]),
      existing: { [path.join(ccPath, '.memory-enabled')]: true },
    });
    vi.spyOn(containerConfig, 'readContainerConfig').mockReturnValue({
      agentGroupId: 'ag-1234-illysium',
      memory: { enabled: true },
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });

    const groups = discoverMemoryGroups();

    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual({
      agentGroupId: 'ag-1234-illysium',
      folder: groupFolder,
      sourcesBasePath: groupPath,
      enabled: true,
    });
    expect(groups).toContainEqual({
      agentGroupId: `cc-${ccSlug}`,
      folder: ccSlug,
      sourcesBasePath: ccPath,
      enabled: true,
    });
  });

  it('CC group sourcesBasePath stays under CC_PROJECTS_DIR (path containment)', () => {
    const slug = '-home-ubuntu-path-check';
    const projectPath = path.join(CC_PROJECTS_DIR, slug);
    mockFs({
      groupsDirEntries: [],
      ccDirEntries: [slug],
      directories: new Set([projectPath]),
      existing: { [path.join(projectPath, '.memory-enabled')]: true },
    });

    const [group] = discoverMemoryGroups();

    expect(group.sourcesBasePath.startsWith(CC_PROJECTS_DIR + path.sep)).toBe(true);
  });
});
