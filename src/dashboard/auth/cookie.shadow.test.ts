import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ shadow: false, dataDir: '', slug: 'abcdef12' }));
vi.mock('../../shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return state.dataDir;
  },
  get INSTALL_SLUG() {
    return state.slug;
  },
}));

const { _resetServerKeyForTest, buildSetCookie, parseAndVerifyCookie, resolveServerKey, sessionCookieName } =
  await import('./cookie.js');

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

  it('uses NANOCLAW_DASHBOARD_COOKIE_SECRET when shadow mode is off', () => {
    vi.stubEnv('NANOCLAW_DASHBOARD_COOKIE_SECRET', 'cd'.repeat(32));
    expect(resolveServerKey().toString('hex')).toBe('cd'.repeat(32));
    expect(fs.existsSync(path.join(state.dataDir, 'cookie-secret'))).toBe(false);
  });

  it("ignores NANOCLAW_DASHBOARD_COOKIE_SECRET on a shadow host: it is production's key", () => {
    state.shadow = true;
    vi.stubEnv('NANOCLAW_DASHBOARD_COOKIE_SECRET', 'cd'.repeat(32));
    const key = resolveServerKey();
    expect(key.toString('hex')).not.toBe('cd'.repeat(32));
    expect(fs.readFileSync(path.join(state.dataDir, 'cookie-secret'), 'utf8')).toBe(key.toString('hex'));
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

describe('session cookie name under shadow mode', () => {
  const key = Buffer.alloc(32, 7);
  const payload = { user_id: 'user-1', expires_at: new Date(Date.now() + 3_600_000).toISOString() };

  afterEach(() => {
    state.shadow = false;
  });

  it("keeps production's spawn_board name when shadow mode is off", () => {
    expect(sessionCookieName()).toBe('spawn_board');
    expect(buildSetCookie(payload, key)).toMatch(/^spawn_board=[^;]+; HttpOnly; /);
  });

  it('names the shadow cookie after its checkout, and neither dashboard reads the other one', () => {
    const production = buildSetCookie(payload, key).split(';')[0];
    state.shadow = true;
    const shadow = buildSetCookie(payload, key).split(';')[0];
    expect(shadow.startsWith('spawn_board_abcdef12=')).toBe(true);
    expect(parseAndVerifyCookie(shadow, key)).toEqual(payload);
    expect(parseAndVerifyCookie(production, key)).toBeNull();
    expect(parseAndVerifyCookie(`${production}; ${shadow}`, key)).toEqual(payload);

    state.shadow = false;
    expect(parseAndVerifyCookie(production, key)).toEqual(payload);
    expect(parseAndVerifyCookie(shadow, key)).toBeNull();
  });
});
