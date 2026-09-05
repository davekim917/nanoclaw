/**
 * Integration test for the add-dashboard skill's integration point —
 * `startDashboard()`, the single call wired into src/main.ts.
 *
 * Archetype: in-process seam. It drives the *real* entry point against a
 * *real* (in-memory) central DB and a *fake* dashboard HTTP endpoint. The
 * only things stubbed are the external dashboard package (not needed to prove
 * the wiring) and env-file reads (so the test doesn't depend on the real
 * .env). This proves the skill works once applied: with a secret set it
 * collects a DB snapshot and posts it; with no secret it does nothing.
 *
 * Ships with the add-dashboard skill; apply copies it to src/ alongside the
 * pusher so it runs against the composed project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { fileURLToPath, pathToFileURL } from 'url';

// The dashboard server package isn't needed to prove the integration point.
vi.mock('@nanoco/nanoclaw-dashboard', () => ({ startDashboard: vi.fn() }));

interface DbTestApi {
  initTestDb(): Promise<unknown>;
  closeDb(): Promise<void>;
  getRawDb(): never;
  runMigrations(database: never): void;
  createAgentGroup(group: {
    id: string;
    name: string;
    folder: string;
    agent_provider: null;
    created_at: string;
  }): Promise<void>;
}

interface DashboardApi {
  startDashboard(): Promise<void>;
  stopDashboardPusher(): void;
}

let db: DbTestApi;
let dashboard: DashboardApi;
let testDir = '';
let installRoot: string | undefined;

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repository root not found');
}

function sourceInstall(root: string): { pusher: string; db: string } {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-skill-'));
  const src = path.join(fixture, 'src');
  fs.mkdirSync(src);
  fs.copyFileSync(path.join(root, '.claude/skills/add-dashboard/resources/dashboard-pusher.ts'), path.join(src, 'dashboard-pusher.ts'));
  for (const entry of ['db', 'modules', 'channels', 'config.ts', 'log.ts', 'env.ts']) {
    fs.symlinkSync(path.join(root, 'src', entry), path.join(src, entry));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'));
  return { pusher: path.join(src, 'dashboard-pusher.ts'), db: path.join(src, 'db/index.ts') };
}

async function loadDashboard(): Promise<void> {
  const root = repoRoot();
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-data-'));
  const installedPusher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard-pusher.ts');
  const target = fs.existsSync(installedPusher)
    ? { pusher: installedPusher, db: path.join(root, 'src/db/index.ts') }
    : (() => {
        const source = sourceInstall(root);
        installRoot = path.dirname(path.dirname(source.pusher));
        return source;
      })();

  try {
    vi.doMock(path.join(root, 'src/config.ts'), async () => {
      const actual = await vi.importActual<Record<string, unknown>>(path.join(root, 'src/config.ts'));
      return { ...actual, DATA_DIR: testDir, ASSISTANT_NAME: 'Test Assistant' };
    });
    vi.doMock(path.join(root, 'src/env.ts'), () => ({ readEnvFile: () => ({}) }));
    vi.doMock(path.join(root, 'src/log.ts'), () => ({ log: { info() {}, debug() {}, error() {} } }));
    db = (await import(pathToFileURL(target.db).href)) as DbTestApi;
    dashboard = (await import(pathToFileURL(target.pusher).href)) as DashboardApi;
  } catch (error) {
    fs.rmSync(testDir, { recursive: true, force: true });
    if (installRoot) fs.rmSync(installRoot, { recursive: true, force: true });
    installRoot = undefined;
    throw error;
  }
}


function now(): string {
  return new Date().toISOString();
}

interface CapturedPost {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

/** A fake dashboard server that captures the bodies the pusher POSTs. */
function startFakeDashboard(): Promise<{ port: number; posts: CapturedPost[]; close: () => Promise<void> }> {
  const posts: CapturedPost[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch { /* leave empty */ }
      posts.push({ path: req.url || '', auth: req.headers.authorization, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('add-dashboard integration point (startDashboard)', () => {
  beforeEach(async () => {
    await loadDashboard();
    await db.initTestDb();
    db.runMigrations(db.getRawDb());
  });

  afterEach(async () => {
    dashboard.stopDashboardPusher();
    await db.closeDb();
    delete process.env.DASHBOARD_SECRET;
    delete process.env.DASHBOARD_PORT;
    fs.rmSync(testDir, { recursive: true, force: true });
    if (installRoot) fs.rmSync(installRoot, { recursive: true, force: true });
    installRoot = undefined;
    vi.resetModules();
  });

  it('posts a snapshot of the seeded state when DASHBOARD_SECRET is set', async () => {
    await db.createAgentGroup({ id: 'test-agent-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);

    try {
      await dashboard.startDashboard();

      await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

      const ingest = dash.posts.find((p) => p.path === '/api/ingest')!;
      expect(ingest.auth).toBe('Bearer test-secret');
      expect(ingest.body.assistant_name).toBe('Test Assistant');

      const groups = ingest.body.agent_groups as Array<{ id: string }>;
      expect(groups.map((g) => g.id)).toContain('test-agent-1');

      for (const key of ['timestamp', 'sessions', 'channels', 'users', 'tokens', 'context_windows', 'activity', 'messages']) {
        expect(ingest.body).toHaveProperty(key);
      }
    } finally {
      await dash.close();
    }
  });

  it('does nothing when DASHBOARD_SECRET is not set', async () => {
    const dash = await startFakeDashboard();
    // no DASHBOARD_SECRET in env, and readEnvFile is stubbed to {}

    try {
      await dashboard.startDashboard();
      await new Promise((r) => setTimeout(r, 100));

      expect(dash.posts).toHaveLength(0);
    } finally {
      await dash.close();
    }
  });
});
