import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readCodexConfigToml, writeCodexConfigToml, writeCodexConfigTomlAsserting } from './codex-config-file.js';

let dir = '';
let configPath = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-file-'));
  configPath = path.join(dir, 'config.toml');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The two tables that are load-bearing and have no default behind them. */
const LOAD_BEARING = [
  '[marketplaces.mkt]',
  'source_type = "local"',
  '',
  '[hooks.state."/h/hooks.json:pre_tool_use:0:0"]',
  'trusted_hash = "sha256:deadbeef"',
  '',
].join('\n');

describe('readCodexConfigToml', () => {
  it('answers empty for an absent file, and for an absent parent', () => {
    expect(readCodexConfigToml(configPath)).toBe('');
    expect(readCodexConfigToml(path.join(dir, 'nodir', 'config.toml'))).toBe('');
  });

  it('THROWS for a file that exists but cannot be read', () => {
    // Mode 0200 is the live shape: a mount that kept write and lost read. The
    // two-answer read this replaced turned it into an empty base, and the
    // rewrite then deleted every table the writer did not author.
    fs.writeFileSync(configPath, LOAD_BEARING);
    fs.chmodSync(configPath, 0o200);
    try {
      expect(() => readCodexConfigToml(configPath)).toThrow(/could not read Codex config/i);
    } finally {
      fs.chmodSync(configPath, 0o600);
    }
  });
});

describe('writeCodexConfigToml', () => {
  it('hands the renderer the CURRENT contents and commits what it returns', () => {
    fs.writeFileSync(configPath, LOAD_BEARING);
    let seen = '';
    writeCodexConfigToml(configPath, (base) => {
      seen = base;
      return `${base}\n[added]\nx = 1\n`;
    });
    expect(seen).toBe(LOAD_BEARING);
    const committed = fs.readFileSync(configPath, 'utf-8');
    expect(committed).toContain('[marketplaces.mkt]');
    expect(committed).toContain('[hooks.state.');
    expect(committed).toContain('[added]');
  });

  it('creates the file, and its parent directory, when absent', () => {
    const nested = path.join(dir, 'fresh-home', 'config.toml');
    writeCodexConfigToml(nested, (base) => {
      expect(base).toBe('');
      return '[features]\n';
    });
    expect(fs.readFileSync(nested, 'utf-8')).toBe('[features]\n');
  });

  it('leaves NO temp file behind on the success path', () => {
    writeCodexConfigToml(configPath, () => '[features]\n');
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('leaves the previous file standing when the RENDERER throws', () => {
    fs.writeFileSync(configPath, LOAD_BEARING);
    expect(() =>
      writeCodexConfigToml(configPath, () => {
        throw new Error('renderer refuses');
      }),
    ).toThrow(/renderer refuses/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(LOAD_BEARING);
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('leaves the previous file standing, and cleans up, when the COMMIT fails', () => {
    // A leftover read-only `config.toml.tmp` is the shape a crashed write can
    // leave: `open(…, 'w')` on it fails with EACCES. That this blocks the
    // commit is also the proof that the temp file is the SIBLING
    // `<configPath>.tmp` — a temp file in /tmp would silently degrade to a copy
    // across a mount boundary, which is not atomic.
    fs.writeFileSync(configPath, LOAD_BEARING);
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, 'leftover');
    fs.chmodSync(tmpPath, 0o400);
    expect(() => writeCodexConfigToml(configPath, () => '[replacement]\n')).toThrow(/could not write Codex config/i);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(LOAD_BEARING);
    // `unlink(2)` needs write on the DIRECTORY, so even a read-only temp file
    // goes — the next spawn is not blocked by the wreckage of this one.
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('THROWS rather than rewriting from an empty base when the current file is unreadable', () => {
    // The whole point: the rewrite would have succeeded and silently dropped
    // the marketplace and trust tables.
    fs.writeFileSync(configPath, LOAD_BEARING);
    fs.chmodSync(configPath, 0o200);
    try {
      expect(() => writeCodexConfigToml(configPath, (base) => `${base}\n[mcp_servers.x]\n`)).toThrow(
        /could not read Codex config/i,
      );
    } finally {
      fs.chmodSync(configPath, 0o600);
    }
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(LOAD_BEARING);
  });

  it('readBase:false skips the read entirely, so an unreadable current file is no obstacle', () => {
    // A FULL regeneration carries nothing forward, so refusing on an unreadable
    // previous file would disable peer-mode Codex for no benefit.
    fs.writeFileSync(configPath, LOAD_BEARING);
    fs.chmodSync(configPath, 0o200);
    let seen = 'not-called';
    try {
      writeCodexConfigToml(
        configPath,
        (base) => {
          seen = base;
          return '[regenerated]\n';
        },
        { readBase: false },
      );
    } finally {
      fs.chmodSync(configPath, 0o600);
    }
    expect(seen).toBe('');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[regenerated]\n');
  });

  it('REPLACES a read-only file, because the commit is a rename the directory governs', () => {
    fs.writeFileSync(configPath, LOAD_BEARING);
    fs.chmodSync(configPath, 0o400);
    writeCodexConfigToml(configPath, () => '[replacement]\n');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[replacement]\n');
  });
});

describe('writeCodexConfigTomlAsserting', () => {
  it('passes when every required entry is in the committed bytes', () => {
    writeCodexConfigTomlAsserting(configPath, () => LOAD_BEARING, ['trusted_hash = "sha256:deadbeef"']);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(LOAD_BEARING);
  });

  it('THROWS when a renderer silently drops a required entry', () => {
    // Closes the CLASS rather than the instances: it does not matter whether
    // the table went missing because a renderer dropped it, a read answered
    // empty, or the commit landed short — the check reads the file back.
    expect(() =>
      writeCodexConfigTomlAsserting(configPath, () => '[features]\n', ['trusted_hash = "sha256:deadbeef"']),
    ).toThrow(/committed without 1 required entry/i);
  });

  it('names the missing entries, capped, so the log is readable', () => {
    const required = Array.from({ length: 7 }, (_, i) => `trusted_hash = "sha256:${i}"`);
    expect(() => writeCodexConfigTomlAsserting(configPath, () => '', required)).toThrow(/…\(2 more\)/);
  });

  it('catches a dropped TABLE even when an identical handler elsewhere shares its hash', () => {
    // Asserting on the hash alone would miss this: two identical handlers under
    // different keys have one hash, so a file that lost one of their tables
    // still carries the hash. The required strings are whole tables.
    const tables = [
      '[hooks.state."/a/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:same"',
      '[hooks.state."/b/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:same"',
    ];
    expect(() => writeCodexConfigTomlAsserting(configPath, () => `${tables[0]}\n`, tables)).toThrow(
      /committed without 1 required entry/i,
    );
  });

  it('skips the read-back entirely when nothing is required', () => {
    writeCodexConfigTomlAsserting(configPath, () => '[features]\n', []);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[features]\n');
  });
});
