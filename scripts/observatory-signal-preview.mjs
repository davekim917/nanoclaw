/** GET-only real-data preview. Run with: pnpm exec tsx scripts/observatory-signal-preview.mjs
 * Uses SQLite's online backup, never copies an active WAL database file directly.
 * Only the isolated snapshot is migrated. Production cookie is held only in memory for localhost runtime GETs.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveRoot = process.env.SIGNAL_SOURCE_ROOT || '/home/ubuntu/nanoclaw-v2';
const evidence = process.env.SIGNAL_EVIDENCE_DIR || '/tmp/observatory-signal-evidence';
const port = Number(process.env.SIGNAL_PREVIEW_PORT || 4318);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const snapshot = path.join(evidence, `central-${Date.now()}.db`);
const live = new Database(path.join(liveRoot, 'data/v2.db'), { readonly: true, fileMustExist: true });
await live.backup(snapshot);
live.close();
fs.chmodSync(snapshot, 0o600);
// Configuration resolves source/session paths against cwd. These GET handlers
// read live session/source files; every central write goes to the snapshot.
process.chdir(liveRoot);
const { initDb } = await import('../src/db/connection.ts');
const { runMigrations } = await import('../src/db/migrations/index.ts');
const isolated = new Database(snapshot);
runMigrations(isolated);
const owner = isolated
  .prepare(
    "SELECT u.id, u.display_name FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role='owner' ORDER BY u.created_at LIMIT 1",
  )
  .get();
if (!owner) throw new Error('No real owner identity in snapshot');
// Deliberate source-backed initialization of this disposable preview only.
// Persist explicit repository mappings; source prose never supplies project IDs.
const mappingProvenance = [];
for (const { id: workgroup } of isolated.prepare('SELECT id FROM workgroups').all()) {
  const sourcePath = path.join(liveRoot, 'data/workgroups', workgroup, 'releases/release-state.json');
  if (!fs.existsSync(sourcePath)) continue;
  const board = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const repositories = new Map();
  for (const item of board.items || []) {
    let repository = null;
    if (typeof item.meta?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(item.meta.repo)) repository = item.meta.repo;
    if (!repository && typeof item.url === 'string') {
      try {
        const url = new URL(item.url);
        const match = /^\/([\w.-]+)\/([\w.-]+)(?:\/|$)/.exec(url.pathname);
        if (url.hostname === 'github.com' && url.protocol === 'https:' && match) repository = match[1] + '/' + match[2];
      } catch (error) {
        if (!(error instanceof TypeError)) throw error; // Invalid source URLs remain unmapped.
      }
    }
    if (repository) {
      const key = repository.toLowerCase();
      const record = repositories.get(key) || { name: repository, source_ids: [] };
      record.source_ids.push(item.id);
      repositories.set(key, record);
    }
  }
  for (const [repository, provenance] of repositories) {
    const id =
      'repository:' +
      crypto
        .createHash('sha256')
        .update(workgroup + ':' + repository)
        .digest('hex')
        .slice(0, 24);
    isolated
      .prepare(
        'INSERT OR IGNORE INTO observatory_projects (id,workgroup_id,name,description,repositories,channel_keys,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
      )
      .run(
        id,
        workgroup,
        provenance.name,
        'Repository mapping from declared release-source references. Project goal has not been supplied.',
        JSON.stringify([repository]),
        '[]',
        owner.id,
        new Date().toISOString(),
      );
    mappingProvenance.push({
      id,
      workgroup_id: workgroup,
      repository,
      source_path: sourcePath,
      source_as_of: board.asOf,
      source_ids: provenance.source_ids,
      scope: 'disposable preview central snapshot only',
    });
  }
}
fs.writeFileSync(path.join(evidence, 'mapping-provenance.json'), JSON.stringify(mappingProvenance, null, 2));
isolated.close();
await initDb(snapshot, { role: 'tool', readonly: true });
const router = await import('../src/dashboard/router.ts');
const { buildSetCookie, parseAndVerifyCookie } = await import('../src/dashboard/auth/cookie.ts');
const key = crypto.randomBytes(32);
const cookie = buildSetCookie({ user_id: owner.id, expires_at: new Date(Date.now() + 86400000).toISOString() }, key, {
  secure: false,
}).split(';')[0];
fs.writeFileSync(path.join(evidence, 'preview-cookie'), cookie, { mode: 0o600 });
router.registerCookieVerifier((header) => parseAndVerifyCookie(header, key));
await import('../src/dashboard/api/auth-me.ts');
async function route(pattern, module, name) {
  const exports = await import(module);
  if (!exports[name]) throw new Error(`Missing GET handler ${name}`);
  router.register('GET', `/dashboard/api/${pattern}`, router.requireAuth(exports[name]));
}
await route('workgroups', '../src/dashboard/api/workgroups.ts', 'workgroupsListHandler');
await route('groups', '../src/dashboard/api/groups.ts', 'groupsListHandler');
await route('threads', '../src/dashboard/api/threads.ts', 'threadsHandler');
await route('threads/:id', '../src/dashboard/api/threads.ts', 'threadsDetailHandler');
await route('scheduled', '../src/dashboard/api/scheduled-read.ts', 'scheduledListHandler');
await route('scheduled/search', '../src/dashboard/api/scheduled-read.ts', 'scheduledSearchHandler');
await route('scheduled/:key', '../src/dashboard/api/scheduled-read.ts', 'scheduledDetailHandler');
const signalModule = process.env.SIGNAL_HANDLER_MODULE || '../src/dashboard/observatory-v2/api.ts';
// Runtime liveness belongs to the running host's container registry. Obtain it
// via its existing authenticated GET, retaining the snapshot for central data.
// Production credentials remain in memory and never enter browser/evidence files.
const liveOrigin = process.env.SIGNAL_LIVE_ORIGIN || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(liveOrigin).hostname))
  throw new Error('Live runtime source must be localhost');
const liveKey = Buffer.from(fs.readFileSync(path.join(os.homedir(), '.nanoclaw/cookie-secret'), 'utf8').trim(), 'hex');
const liveCookie = buildSetCookie(
  { user_id: owner.id, expires_at: new Date(Date.now() + 86400000).toISOString() },
  liveKey,
  { secure: false },
).split(';')[0];
const { buildObservatoryScene } = await import('../src/dashboard/api/observatory.ts');
const { buildSignalData, readSignalRelease } = await import('../src/dashboard/observatory-v2/sources.ts');
const { decisionDetail } = await import(signalModule);
const runtimeObservations = new Map();
const deps = {
  release: readSignalRelease,
  runtimeScene: async (workgroup) => {
    const scene = await buildObservatoryScene(workgroup);
    const response = await fetch(liveOrigin + '/dashboard/api/observatory?workgroup=' + encodeURIComponent(workgroup), {
      headers: { cookie: liveCookie },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Live runtime source unavailable: ' + response.status);
    const runtime = await response.json();
    if (!Array.isArray(runtime.agents)) throw new Error('Invalid live runtime scene');
    const byId = new Map(runtime.agents.map((agent) => [agent.id, agent]));
    scene.agents = scene.agents.map((agent) => {
      const observed = byId.get(agent.id);
      if (!observed) throw new Error('Snapshot agent missing from live runtime scene');
      return { ...agent, awake: observed.awake, active: observed.active };
    });
    runtimeObservations.set(workgroup, {
      at: new Date().toISOString(),
      host_as_of: runtime.asOf,
      agents: scene.agents.map((agent) => ({ id: agent.id, awake: agent.awake, active: agent.active })),
    });
    fs.writeFileSync(
      path.join(evidence, 'live-runtime-observations.json'),
      JSON.stringify(Object.fromEntries(runtimeObservations), null, 2),
    );
    return scene;
  },
};
router.register(
  'GET',
  '/dashboard/api/observatory/v2',
  router.requireAuth(async (req, _params, ctx) => {
    const query = new URL(req.url).searchParams;
    const threadOffset = Number(query.get('thread_offset') ?? '0');
    const threadLimit = Number(query.get('thread_limit') ?? '200');
    if (
      !Number.isSafeInteger(threadOffset) ||
      threadOffset < 0 ||
      !Number.isSafeInteger(threadLimit) ||
      threadLimit < 1 ||
      threadLimit > 1000
    )
      return Response.json({ error: 'invalid_thread_page' }, { status: 400 });
    const { rawDecisions, ...body } = await buildSignalData(ctx, query.get('workgroup') || 'all', {
      ...deps,
      threadOffset,
      threadLimit,
    });
    return Response.json(body);
  }),
);
router.register(
  'GET',
  '/dashboard/api/observatory/v2/decisions/:id',
  router.requireAuth(async (_req, params, ctx) =>
    Response.json(await decisionDetail(decodeURIComponent(params.id), ctx, deps)),
  ),
);
const staticRoot = path.join(buildRoot, 'dist/dashboard-spa');
const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Preview is read-only');
      return;
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/dashboard/api/events') {
      if (!parseAndVerifyCookie(req.headers.cookie || null, key)) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': isolated preview connected; source freshness uses client polling\n\n');
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (url.pathname.startsWith('/dashboard/api/')) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response = await router.dispatch(new Request(url, { headers }), req, res);
      if (response) {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      }
      return;
    }
    const tail = url.pathname.startsWith('/dashboard/static/')
      ? decodeURIComponent(url.pathname.slice('/dashboard/static/'.length))
      : 'index.html';
    const file = path.resolve(staticRoot, tail);
    if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
    // HTTP boundary returns a failed response and keeps the preview available.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Preview error');
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'preview_handler_failure' }));
  }
});
server.listen(port, '127.0.0.1', () => {
  const manifest = {
    url: `http://127.0.0.1:${port}/observatory/`,
    snapshot,
    source_root: liveRoot,
    build_root: buildRoot,
    snapshot_at: new Date().toISOString(),
    user_id: owner.id,
    mode: 'GET-only; isolated central snapshot; live source/session reads and authenticated localhost runtime observations; no fleet runtime started',
  };
  fs.writeFileSync(path.join(evidence, 'preview.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
});
