import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery seam for notify-owner.ts: every case here controls whether Slack
 * "answers" without ever reaching the network. `posts` records every call
 * `notifyOwner` made through the mocked seam, so a test can assert both the
 * outcome (exit code) and exactly what would have been sent (channel,
 * token, text) without a real HTTP request.
 */
const posts: { token: string; channel: string; text: string }[] = [];
let slackBehavior: 'ok' | 'ok-false' | 'network-error' = 'ok';

vi.mock('../src/channels/slack-lib.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/channels/slack-lib.js')>();
  return {
    ...actual,
    slackPostMessage: vi.fn(async (token: string, channel: string, text: string) => {
      posts.push({ token, channel, text });
      if (slackBehavior === 'ok-false') {
        throw new actual.SlackApiError('post-message', 'slack chat.postMessage failed: channel_not_found');
      }
      if (slackBehavior === 'network-error') {
        throw new actual.SlackApiError('post-message', 'slack chat.postMessage failed: fetch failed');
      }
    }),
  };
});

import { notifyOwner } from './notify-owner.js';
import { formatLocalStamp } from '../src/timezone.js';

// A slug that cannot collide with a real bot token in any environment this
// suite runs in — botTokenKeyForChannelType derives SLACK_BOT_TOKEN_<SUFFIX>
// from it, and no real install configures this suffix.
const CHANNEL_TYPE = 'slack-notifyownertest';
const TOKEN_KEY = 'SLACK_BOT_TOKEN_NOTIFYOWNERTEST';
const FAKE_TOKEN = 'xoxb-test-fake-token-do-not-use';

describe('scripts/notify-owner.ts', () => {
  let rootDir: string;
  let dataDir: string;
  let dbPath: string;

  beforeEach(() => {
    posts.length = 0;
    slackBehavior = 'ok';
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-root-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-db-'));
    dbPath = path.join(dataDir, 'v2.db');
    // Defensive: guarantee the ambient environment can never supply this
    // key, so a positive test's fixture .env is the only source of truth.
    vi.stubEnv(TOKEN_KEY, '');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Minimal schema slice notify-owner.ts reads: messaging_groups/user_roles/user_dms. */
  function createDb(rows: { channelType: string; platformId: string }[]): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, platform_id TEXT NOT NULL);
      CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE user_dms (
        user_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO user_roles (user_id, role) VALUES ('U1', 'owner')`).run();
    rows.forEach((r, i) => {
      const mgId = `mg${i}`;
      db.prepare(`INSERT INTO messaging_groups (id, platform_id) VALUES (?, ?)`).run(mgId, r.platformId);
      db.prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES ('U1', ?, ?, ?)`,
      ).run(r.channelType, mgId, new Date(2026, 0, 1, 0, 0, i).toISOString());
    });
    db.close();
  }

  it('(a) no owner DM row -> exit 2, nothing posted', async () => {
    createDb([]);
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/no owner dm/i);
    expect(posts).toHaveLength(0);
  });

  it('(b) no bot token configured -> exit 2, token key named but no token value anywhere', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    // rootDir has no .env, and the ambient env is stubbed empty (beforeEach).
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(2);
    expect(result.message).toContain(TOKEN_KEY);
    expect(posts).toHaveLength(0);
  });

  it('(c) Slack API returns ok:false -> exit 1, reason on message, token never appears', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    slackBehavior = 'ok-false';
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(1);
    expect(result.message).toContain('channel_not_found');
    expect(result.message).not.toContain(FAKE_TOKEN);
    expect(posts).toHaveLength(1);
  });

  it('(d) Slack API returns ok:true -> exit 0, safe channel id only, token never appears', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    const result = await notifyOwner({ title: 'Title', body: 'Body', dbPath, rootDir, timezone: 'UTC' });
    expect(result.code).toBe(0);
    expect(result.message).toBe(`delivered to ${CHANNEL_TYPE}:DTEST00001`);
    expect(result.message).not.toContain(FAKE_TOKEN);
    expect(posts).toEqual([{ token: FAKE_TOKEN, channel: 'DTEST00001', text: expect.any(String) }]);
  });

  it('(e) the DM text renders the timestamp in the install timezone, not UTC', async () => {
    createDb([{ channelType: CHANNEL_TYPE, platformId: 'slack:DTEST00001' }]);
    fs.writeFileSync(path.join(rootDir, '.env'), `${TOKEN_KEY}=${FAKE_TOKEN}\n`);
    const now = new Date('2026-01-15T20:30:00Z');
    const nyStamp = formatLocalStamp(now, 'America/New_York');
    const utcStamp = formatLocalStamp(now, 'UTC');
    expect(nyStamp).not.toBe(utcStamp); // sanity: the two zones must actually differ for this instant

    const result = await notifyOwner({
      title: 'Title',
      body: 'Body',
      dbPath,
      rootDir,
      timezone: 'America/New_York',
      now,
    });
    expect(result.code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(nyStamp);
    expect(posts[0]!.text).not.toContain(utcStamp);
  });

  it('(f) resolves the install from this file, not the caller cwd', async () => {
    // src/config.ts derives its paths from process.cwd(), so a caller that has
    // not cd'd would otherwise read a different install's DB and .env and exit
    // 2 ("no owner DM") exactly when an alert matters. The defaults must come
    // from the module's own location instead.
    const installRoot = path.resolve(__dirname, '..');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-owner-cwd-'));
    const cwd = process.cwd();
    try {
      process.chdir(elsewhere);
      const { notifyOwner: fresh } = await import('./notify-owner.js');
      // No dbPath/rootDir. The defaults must name THIS checkout's central DB,
      // never the directory we happen to be standing in. Asserting against
      // `elsewhere` rather than os.tmpdir() matters because the checkout
      // itself can live under /tmp (gate worktrees do), which made the
      // cruder assertion fail for the wrong reason.
      const result = await fresh({ title: 'T', body: 'B' });
      expect(result.code).toBe(2); // no owner row / no DB under test
      expect(result.message).toContain(path.join(installRoot, 'data', 'v2.db'));
      expect(result.message).not.toContain(elsewhere);
    } finally {
      process.chdir(cwd);
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
