import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  CODEX_ACCOUNT_RETRY_MS,
  codexAccountRing,
  codexStartHome,
  isCodexAccountExhausted,
  markCodexAccountExhausted,
  pickCodexStartHome,
  resolveCodexAuthFallbacks,
} from './codex-accounts.js';

const T0 = 1_000_000;

function ring(tag: string) {
  return [
    { hostHome: `/host/${tag}/primary`, containerPath: '/home/node/.codex' },
    { hostHome: `/host/${tag}/second`, containerPath: '/home/node/.codex-fallback-1' },
    { hostHome: `/host/${tag}/third`, containerPath: '/home/node/.codex-fallback-2' },
  ];
}

describe('codex account health', () => {
  it('keeps the primary while nothing is marked', () => {
    expect(pickCodexStartHome(ring('clean'), T0)).toBeNull();
  });

  it('starts on the first fallback while the primary is marked', () => {
    const accounts = ring('primary-spent');
    markCodexAccountExhausted(accounts[0].hostHome, T0);
    expect(pickCodexStartHome(accounts, T0 + 1)).toBe('/home/node/.codex-fallback-1');
  });

  it('skips every marked account in ring order', () => {
    const accounts = ring('two-spent');
    markCodexAccountExhausted(accounts[0].hostHome, T0);
    markCodexAccountExhausted(accounts[1].hostHome, T0);
    expect(pickCodexStartHome(accounts, T0 + 1)).toBe('/home/node/.codex-fallback-2');
  });

  it('keeps the primary when every account is marked', () => {
    const accounts = ring('all-spent');
    for (const account of accounts) markCodexAccountExhausted(account.hostHome, T0);
    expect(pickCodexStartHome(accounts, T0 + 1)).toBeNull();
  });

  it('tries the primary again once the mark is an hour old', () => {
    const accounts = ring('expiry');
    markCodexAccountExhausted(accounts[0].hostHome, T0);
    expect(isCodexAccountExhausted(accounts[0].hostHome, T0 + CODEX_ACCOUNT_RETRY_MS - 1)).toBe(true);
    expect(pickCodexStartHome(accounts, T0 + CODEX_ACCOUNT_RETRY_MS)).toBeNull();
    expect(isCodexAccountExhausted(accounts[0].hostHome, T0 + 1)).toBe(false);
  });

  it('shares a mark between groups that mount the same host account', () => {
    markCodexAccountExhausted('/host/shared/primary', T0);
    const otherGroup = [
      { hostHome: '/host/shared/primary', containerPath: '/home/node/.codex' },
      { hostHome: '/host/shared/second', containerPath: '/home/node/.codex-fallback-1' },
    ];
    expect(pickCodexStartHome(otherGroup, T0 + 1)).toBe('/home/node/.codex-fallback-1');
  });
});

describe('CODEX_START_HOME at spawn', () => {
  // buildContainerArgs makes live OneCLI calls and cannot run here, so the wiring is read from source.
  it('is the start pick for the spawning group, passed as container env', () => {
    const src = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /const codexStart = codexStartHome\(provider, agentGroup\.folder, containerConfig\.codexAuthFallbacks\);\s+if \(codexStart\) args\.push\('-e', `CODEX_START_HOME=\$\{codexStart\}`\);/,
    );
  });
});

describe('codexStartHome', () => {
  function makeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-start-'));
    for (const dir of ['.codex', '.codex-secondary']) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
      fs.writeFileSync(path.join(home, dir, 'auth.json'), '{}');
    }
    return home;
  }

  it('lists the primary first, then each declared fallback at its mount path', () => {
    const home = makeHome();
    expect(codexAccountRing('retail-codex', ['~/.codex-secondary'], home)).toEqual([
      { hostHome: path.join(home, '.codex'), containerPath: '/home/node/.codex' },
      { hostHome: path.join(home, '.codex-secondary'), containerPath: '/home/node/.codex-fallback-1' },
    ]);
  });

  it('names the fallback only for a Codex container whose primary account is marked at quota', () => {
    const home = makeHome();
    expect(codexStartHome('codex', 'retail-codex', ['~/.codex-secondary'], home)).toBeNull();
    markCodexAccountExhausted(path.join(home, '.codex'));
    expect(codexStartHome('codex', 'retail-codex', ['~/.codex-secondary'], home)).toBe('/home/node/.codex-fallback-1');
    expect(codexStartHome('codex', 'other-codex', ['~/.codex-secondary'], home)).toBe('/home/node/.codex-fallback-1');
    expect(codexStartHome('claude', 'retail', ['~/.codex-secondary'], home)).toBeNull();
    expect(codexStartHome('codex', 'solo-codex', undefined, home)).toBeNull();
  });
});

describe('resolveCodexAuthFallbacks', () => {
  function makeHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-fb-'));
  }

  function writeAuth(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  }

  it('returns [] when declarations is undefined or empty', () => {
    const home = makeHome();
    expect(resolveCodexAuthFallbacks(undefined, path.join(home, '.codex'), home)).toEqual([]);
    expect(resolveCodexAuthFallbacks([], path.join(home, '.codex'), home)).toEqual([]);
  });

  it('expands ~/ relative to provided homedir', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary is some scoped dir; fallback is the global ~/.codex
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex-retail'), home);
    expect(out).toEqual([{ hostPath: path.join(home, '.codex'), containerPath: '/home/node/.codex-fallback-1' }]);
  });

  it('skips entries without an auth.json (no false-positive mounts)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // ~/.codex-missing has no auth.json — must be silently dropped
    const out = resolveCodexAuthFallbacks(['~/.codex-missing', '~/.codex'], path.join(home, '.codex-retail'), home);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      hostPath: path.join(home, '.codex'),
      containerPath: '/home/node/.codex-fallback-1',
    });
  });

  it('dedupes against the primary host path', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    // Primary IS ~/.codex, so the same path in fallbacks must be dropped
    const out = resolveCodexAuthFallbacks(['~/.codex'], path.join(home, '.codex'), home);
    expect(out).toEqual([]);
  });

  it('dedupes within the declaration list (same path declared twice)', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const out = resolveCodexAuthFallbacks(['~/.codex', '~/.codex'], path.join(home, '.codex-retail'), home);
    expect(out).toHaveLength(1);
    expect(out[0].containerPath).toBe('/home/node/.codex-fallback-1');
  });

  it('preserves declared order and numbers container paths starting at 1', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex-a'));
    writeAuth(path.join(home, '.codex-b'));
    writeAuth(path.join(home, '.codex-c'));
    const out = resolveCodexAuthFallbacks(
      ['~/.codex-b', '~/.codex-a', '~/.codex-c'],
      path.join(home, '.codex-retail'),
      home,
    );
    expect(out.map((e) => e.hostPath)).toEqual([
      path.join(home, '.codex-b'),
      path.join(home, '.codex-a'),
      path.join(home, '.codex-c'),
    ]);
    expect(out.map((e) => e.containerPath)).toEqual([
      '/home/node/.codex-fallback-1',
      '/home/node/.codex-fallback-2',
      '/home/node/.codex-fallback-3',
    ]);
  });

  it('ignores non-string and blank entries', () => {
    const home = makeHome();
    writeAuth(path.join(home, '.codex'));
    const messy = [null, '', '   ', '~/.codex'] as unknown as string[];
    const out = resolveCodexAuthFallbacks(messy, path.join(home, '.codex-retail'), home);
    expect(out).toHaveLength(1);
    expect(out[0].hostPath).toBe(path.join(home, '.codex'));
  });
});
