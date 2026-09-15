/**
 * The container's read of `excludePlugins` out of the read-only
 * `/workspace/agent/container.json` mount.
 *
 * The property under test is the direction of failure. Every walker treats
 * "not excluded" as "deliver it", so a read that cannot answer must NOT answer
 * "nothing is excluded" — that is the fail-open shape `docs/review-notes.md`
 * registers, and it would hand the agent the plugin the operator withheld.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _resetExcludedPlugins, loadExcludedPlugins, parseExcludedPlugins } from './excluded-plugins.js';

let dir: string;
let configPath: string;

beforeEach(() => {
  _resetExcludedPlugins();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-plugins-'));
  configPath = path.join(dir, 'container.json');
});

afterEach(() => {
  _resetExcludedPlugins();
  fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadExcludedPlugins', () => {
  it('splits the declared list into top-level entries and sub-paths', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ provider: 'claude', excludePlugins: ['legacy', 'bootstrap/plugins/orchestrate'] }),
    );
    const split = loadExcludedPlugins(configPath);
    expect([...split.topLevel]).toEqual(['legacy']);
    expect([...split.subPaths]).toEqual(['bootstrap/plugins/orchestrate']);
  });

  it('reads a config with no excludePlugins field as nothing excluded', () => {
    fs.writeFileSync(configPath, JSON.stringify({ provider: 'claude' }));
    const split = loadExcludedPlugins(configPath);
    expect(split.topLevel.size).toBe(0);
    expect(split.subPaths.size).toBe(0);
  });

  it('reads an ABSENT config as nothing excluded — a file that is not there declared nothing', () => {
    const split = loadExcludedPlugins(path.join(dir, 'no-such-file.json'));
    expect(split.topLevel.size).toBe(0);
    expect(split.subPaths.size).toBe(0);
  });

  it('THROWS on an unreadable config rather than reading it as nothing excluded', () => {
    // The live shape: the file is there (so ENOENT does not apply) and the read
    // fails anyway — a mount that lost read access, a mode change. Answering
    // "nothing excluded" here would register every excluded plugin.
    fs.writeFileSync(configPath, JSON.stringify({ excludePlugins: ['bootstrap/plugins/orchestrate'] }));
    fs.chmodSync(configPath, 0o000);
    if (process.getuid?.() === 0) return; // root reads through the mode; nothing to assert.
    expect(() => loadExcludedPlugins(configPath)).toThrow(/refusing to treat that as "nothing excluded"/);
  });

  it('THROWS on malformed JSON rather than reading it as nothing excluded', () => {
    fs.writeFileSync(configPath, '{ not json');
    expect(() => loadExcludedPlugins(configPath)).toThrow();
  });

  it('THROWS on an entry the host validator would have refused', () => {
    // Same validator the host ran before the spawn (`validateExcludePlugins`),
    // so an entry cannot mean one thing on each side of the mount.
    fs.writeFileSync(configPath, JSON.stringify({ excludePlugins: ['bootstrap/../../etc'] }));
    expect(() => loadExcludedPlugins(configPath)).toThrow(/excludePlugins entry/);
  });

  it('memoizes only the real container path, so tests and callers can pass their own', () => {
    fs.writeFileSync(configPath, JSON.stringify({ excludePlugins: ['a'] }));
    expect([...loadExcludedPlugins(configPath).topLevel]).toEqual(['a']);
    fs.writeFileSync(configPath, JSON.stringify({ excludePlugins: ['b'] }));
    expect([...loadExcludedPlugins(configPath).topLevel]).toEqual(['b']);
  });
});

describe('parseExcludedPlugins', () => {
  it('applies the covering relation, so a redundant nested pair collapses', () => {
    const split = parseExcludedPlugins(
      JSON.stringify({ excludePlugins: ['bootstrap/plugins', 'bootstrap/plugins/orchestrate'] }),
    );
    expect([...split.subPaths]).toEqual(['bootstrap/plugins']);
  });

  it('THROWS on a root that parses but is not an object — parsing is not the same as being a config', () => {
    // Each of these is valid JSON, so JSON.parse never fails; reading
    // `.excludePlugins` off them yields undefined, which means "nothing
    // declared". That is the fail-open this module exists to prevent, reached
    // through a shape nobody checked rather than through a failed read.
    for (const raw of ['[]', '42', '"oops"', 'null', 'true']) {
      expect(() => parseExcludedPlugins(raw)).toThrow(/did not parse to a JSON object/);
    }
  });

  it('THROWS on an ARRAY root wrapping a real config — the reachable shape, with the entries right there', () => {
    // `[{"excludePlugins": [...]}]` is the shape that actually loses an
    // exclusion: the operator's entries are in the file, and reading the field
    // off the array would answer "nothing excluded".
    const raw = JSON.stringify([{ excludePlugins: ['bootstrap/plugins/orchestrate'] }]);
    expect(() => parseExcludedPlugins(raw)).toThrow(/did not parse to a JSON object \(got array\)/);
  });

  it('still accepts an ordinary object root, with and without the field', () => {
    expect(parseExcludedPlugins(JSON.stringify({ model: 'x' })).subPaths.size).toBe(0);
    expect([...parseExcludedPlugins(JSON.stringify({ excludePlugins: ['bootstrap'] })).topLevel]).toEqual([
      'bootstrap',
    ]);
  });
});
