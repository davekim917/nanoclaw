import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DATA_DIR, warn } = vi.hoisted(() => ({
  DATA_DIR: `${uniqueTmpRoot('workgroup-wiki-test')}/data`,
  warn: vi.fn(),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR,
}));

// NOT spread: log.ts installs process-wide handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  WORKGROUP_WIKI_CONTAINER_PATH,
  resolveWorkgroupWiki,
  workgroupWikiHostPath,
  workgroupWikiInstructions,
} from './workgroup-wiki.js';

function wikiDir(id: string): string {
  return path.join(DATA_DIR, 'wikis', id);
}

function makeWiki(id: string, withIndex: boolean): void {
  fs.mkdirSync(wikiDir(id));
  if (withIndex) fs.writeFileSync(path.join(wikiDir(id), 'index.md'), '# Index\n');
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'wikis'), { recursive: true });
  warn.mockClear();
});

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('resolveWorkgroupWiki', () => {
  it('mounts an existing wiki read-only at /workspace/wiki', () => {
    makeWiki('example-labs', true);
    expect(resolveWorkgroupWiki('example-labs')).toEqual({
      mount: { hostPath: wikiDir('example-labs'), containerPath: WORKGROUP_WIKI_CONTAINER_PATH, readonly: true },
      hasIndex: true,
    });
    expect(WORKGROUP_WIKI_CONTAINER_PATH).toBe('/workspace/wiki');
  });

  it('offers nothing, quietly, when the workgroup keeps no wiki', () => {
    expect(resolveWorkgroupWiki('example-labs')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an id that would climb out of data/wikis', () => {
    fs.mkdirSync(path.join(DATA_DIR, 'outside'));
    expect(workgroupWikiHostPath('../outside')).toBe(path.join(DATA_DIR, 'outside'));
    expect(resolveWorkgroupWiki('../outside')).toBeNull();
  });

  it.each([undefined, null, '', 'Example-Labs', 'a/b', '1abc'])('refuses the non-slug id %j', (id) => {
    expect(resolveWorkgroupWiki(id)).toBeNull();
  });

  it('refuses a symlink instead of following it', () => {
    const target = path.join(DATA_DIR, 'elsewhere');
    fs.mkdirSync(target);
    fs.symlinkSync(target, wikiDir('example-labs'));
    expect(resolveWorkgroupWiki('example-labs')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses a regular file at the wiki path', () => {
    fs.writeFileSync(wikiDir('example-labs'), 'not a directory');
    expect(resolveWorkgroupWiki('example-labs')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it.skipIf(process.getuid?.() === 0)('logs and skips an unreadable wiki path rather than failing the spawn', () => {
    makeWiki('example-labs', true);
    fs.chmodSync(path.join(DATA_DIR, 'wikis'), 0o000);
    try {
      expect(resolveWorkgroupWiki('example-labs')).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      fs.chmodSync(path.join(DATA_DIR, 'wikis'), 0o755);
    }
  });

  it('reports a wiki with no index.md', () => {
    makeWiki('example-labs', false);
    expect(resolveWorkgroupWiki('example-labs')?.hasIndex).toBe(false);
  });
});

describe('workgroupWikiInstructions', () => {
  it('is null when no wiki is mounted', () => {
    expect(workgroupWikiInstructions(null)).toBeNull();
  });

  it('starts the lookup at index.md when the wiki has one', () => {
    makeWiki('example-labs', true);
    const text = workgroupWikiInstructions(resolveWorkgroupWiki('example-labs'));
    expect(text).toContain('## Workgroup wiki');
    expect(text).toContain('Before asking a human a domain or product question, read `/workspace/wiki/index.md`');
    expect(text).toContain('name the page');
  });

  it('falls back to grep when the wiki has no index.md', () => {
    makeWiki('example-labs', false);
    const text = workgroupWikiInstructions(resolveWorkgroupWiki('example-labs'));
    expect(text).not.toContain('index.md');
    expect(text).toContain('grep `/workspace/wiki`');
  });
});
