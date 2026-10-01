import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: TEST_DIR,
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('workgroup-reports-test') }));

import { closeDb, getDb, initMigratedTestDb } from '../db/index.js';
import { clearCookieVerifier, registerCookieVerifier } from './router.js';
import { REPORT_CSP, reportGate, workgroupReportHandler } from './workgroup-reports.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const reportsDir = (wg: string) => path.join(TEST_DIR, 'workgroups', wg, 'artifacts', 'reports');
const gated = reportGate(workgroupReportHandler);

function now(): string {
  return new Date().toISOString();
}

async function seed(): Promise<void> {
  const db = getDb();
  for (const wg of ['wg-a', 'wg-b']) {
    await db.run('INSERT INTO workgroups (id, display_name, created_at) VALUES (?, NULL, ?)', wg, now());
    await db.run(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, 'claude', ?, ?)",
      `ag-${wg}`,
      wg,
      wg,
      wg,
      now(),
    );
  }
  for (const user of ['u-owner', 'u-a', 'u-b']) {
    await db.run("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'slack', NULL, ?)", user, now());
  }
  const role =
    'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)';
  await db.run(role, 'u-owner', 'owner', null, now());
  await db.run(role, 'u-a', 'admin', 'ag-wg-a', now());
  await db.run(role, 'u-b', 'admin', 'ag-wg-b', now());
}

function write(file: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

async function get(user: string | null, wg: string, tail: string): Promise<Response> {
  if (user) registerCookieVerifier(() => ({ user_id: user, expires_at: '2099-01-01T00:00:00Z' }));
  else clearCookieVerifier();
  const req = new Request(`http://localhost:3000/dashboard/reports/${wg}/${tail}`);
  const res = await gated(req, { id: wg, tail }, { rawNodeReq: {} as http.IncomingMessage });
  return res!;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  await initMigratedTestDb();
  await seed();
  write(path.join(reportsDir('wg-a'), 'rel-1', 'index.html'), '<h1>release</h1>');
  write(path.join(reportsDir('wg-a'), 'rel-1', 'summary.png'), PNG);
  write(path.join(reportsDir('wg-a'), 'rel-1', '.draft.html'), '<h1>unfinished</h1>');
  write(path.join(TEST_DIR, 'workgroups', 'wg-a', 'releases', 'private.html'), '<h1>not published</h1>');
  write(path.join(reportsDir('wg-b'), 'other', 'index.html'), '<h1>wg-b only</h1>');
});

afterEach(async () => {
  clearCookieVerifier();
  await closeDb();
});

describe('workgroup reports', () => {
  it('serves a member its workgroup report inside a network-less sandbox', async () => {
    const res = await get('u-a', 'wg-a', 'rel-1/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>release</h1>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBe(REPORT_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/sandbox allow-scripts(?!.*allow-same-origin)/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('maps a directory URL to its index.html and serves PNG bytes unchanged', async () => {
    expect(await (await get('u-a', 'wg-a', 'rel-1/')).text()).toBe('<h1>release</h1>');
    const png = await get('u-owner', 'wg-a', 'rel-1/summary.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG);
  });

  it('hides another workgroup and unknown workgroups behind the same 404', async () => {
    expect((await get('u-b', 'wg-a', 'rel-1/index.html')).status).toBe(404);
    expect((await get('u-owner', 'wg-missing', 'rel-1/index.html')).status).toBe(404);
    expect((await get('u-b', 'wg-b', 'other/index.html')).status).toBe(200);
  });

  it('refuses paths outside the reports tree and unlisted file types', async () => {
    for (const tail of [
      '..%2F..%2Freleases%2Fprivate.html',
      '../../releases/private.html',
      'rel-1/.draft.html',
      'rel-1/data.json',
      'rel-1',
      'rel-1/index.html%00.png',
    ]) {
      expect((await get('u-owner', 'wg-a', tail)).status, tail).toBe(404);
    }
  });

  it('refuses a planted symlink that leaves the reports tree', async () => {
    fs.symlinkSync(
      path.join(TEST_DIR, 'workgroups', 'wg-a', 'releases', 'private.html'),
      path.join(reportsDir('wg-a'), 'rel-1', 'leak.html'),
    );
    expect((await get('u-owner', 'wg-a', 'rel-1/leak.html')).status).toBe(404);

    fs.rmSync(reportsDir('wg-a'), { recursive: true });
    fs.symlinkSync(reportsDir('wg-b'), reportsDir('wg-a'));
    expect((await get('u-a', 'wg-a', 'other/index.html')).status).toBe(404);
  });

  it('answers a request without a session cookie with a same-site retry page, never the report', async () => {
    const res = await get(null, 'wg-a', 'rel-1/index.html');
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('release</h1>');
    expect(body).toContain('location.replace');
    expect(body).toContain("searchParams.has('signin')");
    expect(body).toContain('/dashboard-token');
  });
});
