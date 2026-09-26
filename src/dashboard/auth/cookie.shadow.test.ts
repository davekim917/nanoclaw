import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ shadow: false, dataDir: '' }));
vi.mock('../../shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
}));

const { _resetServerKeyForTest, resolveServerKey } = await import('./cookie.js');

describe('resolveServerKey under shadow mode', () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cookie-shadow-'));
    state.dataDir = path.join(tmp, 'data');
    origHome = process.env.HOME;
    process.env.HOME = path.join(tmp, 'home');
    vi.stubEnv('NANOCLAW_DASHBOARD_COOKIE_SECRET', undefined);
    _resetServerKeyForTest();
  });

  afterEach(() => {
    _resetServerKeyForTest();
    vi.unstubAllEnvs();
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    state.shadow = false;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses the home-dir secret when shadow mode is off', () => {
    const key = resolveServerKey();
    expect(fs.readFileSync(path.join(tmp, 'home', '.nanoclaw', 'cookie-secret'), 'utf8')).toBe(key.toString('hex'));
    expect(fs.existsSync(path.join(state.dataDir, 'cookie-secret'))).toBe(false);
  });

  it('never reads or writes the home-dir secret on a shadow host', () => {
    state.shadow = true;
    const homeSecret = path.join(tmp, 'home', '.nanoclaw', 'cookie-secret');
    fs.mkdirSync(path.dirname(homeSecret), { recursive: true });
    fs.writeFileSync(homeSecret, 'ab'.repeat(32));

    const key = resolveServerKey();
    expect(key.toString('hex')).not.toBe('ab'.repeat(32));
    expect(fs.readFileSync(path.join(state.dataDir, 'cookie-secret'), 'utf8')).toBe(key.toString('hex'));
    expect(fs.readFileSync(homeSecret, 'utf8')).toBe('ab'.repeat(32));
  });
});
