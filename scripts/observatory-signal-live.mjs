/** Postactivation, GET-only proof using unchanged existing user identities.
 * Production signed cookies remain in memory and are never logged/persisted.
 * SIGNAL_LIVE_ORIGIN=https://observatory.example.com node scripts/observatory-signal-live.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
const origin = process.env.SIGNAL_LIVE_ORIGIN || 'http://127.0.0.1:3000';
const evidence = process.env.SIGNAL_EVIDENCE_DIR || '/tmp/observatory-signal-evidence/live';
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const key = Buffer.from(fs.readFileSync(path.join(os.homedir(), '.nanoclaw/cookie-secret'), 'utf8').trim(), 'hex');
const db = new Database(process.env.SIGNAL_LIVE_DB || path.resolve('data/v2.db'), { readonly: true, fileMustExist: true });
const users = JSON.parse(process.env.SIGNAL_LIVE_USERS || 'null');
if (!Array.isArray(users) || users.length < 2 || users.some(id => typeof id !== 'string' || !id.trim()) || new Set(users).size !== users.length) {
  throw new Error('SIGNAL_LIVE_USERS must be a JSON array of distinct existing user IDs, owner first followed by restricted reviewers');
}
const privateWorkgroup = process.env.SIGNAL_PRIVATE_WORKGROUP;
const sharedWorkgroup = process.env.SIGNAL_SHARED_WORKGROUP;
if (process.env.SIGNAL_INITIALIZE_PROJECTS !== '1' && (!privateWorkgroup || !sharedWorkgroup || privateWorkgroup === sharedWorkgroup)) {
  throw new Error('SIGNAL_PRIVATE_WORKGROUP and SIGNAL_SHARED_WORKGROUP must name distinct existing workgroups for scope proof');
}
const cookie = (id) => {
  const p = Buffer.from(
    JSON.stringify({ user_id: id, expires_at: new Date(Date.now() + 3600000).toISOString() }),
  ).toString('base64');
  return 'spawn_board=' + p + '.' + crypto.createHmac('sha256', key).update(p).digest('base64');
};
async function read(route, id) {
  const response = await fetch(origin + route, { headers: id ? { cookie: cookie(id) } : {} });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    body = { non_json: true };
  }
  return { status: response.status, body };
}
if (process.env.SIGNAL_INITIALIZE_PROJECTS === '1') {
  const owner = users[0];
  const existing = await read('/dashboard/api/observatory/v2?workgroup=all', owner);
  if (existing.status !== 200) throw new Error('Signal not active');
  const provenance = JSON.parse(fs.readFileSync('/tmp/observatory-signal-evidence/mapping-provenance.json', 'utf8'));
  const results = [];
  for (const mapping of provenance) {
    const matched = existing.body.projects.find(
      (p) => !p.unmapped && p.workgroup_id === mapping.workgroup_id && p.repositories.includes(mapping.repository),
    );
    if (matched) {
      results.push({ id: matched.id, status: 'preserved' });
      continue;
    }
    const response = await fetch(origin + '/dashboard/api/observatory/v2/projects/' + encodeURIComponent(mapping.id.replace(':', '_')), {
      method: 'PUT',
      headers: { cookie: cookie(owner), 'content-type': 'application/json', origin },
      body: JSON.stringify({
        workgroup_id: mapping.workgroup_id,
        name: mapping.repository,
        description: 'Repository mapping from declared release-source references. Project goal has not been supplied.',
        repositories: [mapping.repository],
        channel_keys: [],
        expected_version: 0,
      }),
    });
    if (!response.ok) throw new Error('Project initialization failed ' + response.status + ' for ' + mapping.id);
    results.push({ id: mapping.id.replace(':', '_'), status: 'created' });
  }
  fs.writeFileSync(
    path.join(evidence, 'project-initialization.json'),
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  console.log(JSON.stringify({ project_count: results.length, results }));
  db.close();
  process.exit(0);
}
const report = {
  origin,
  observed_at: new Date().toISOString(),
  unauthenticated: (await read('/dashboard/api/observatory/v2')).status,
  users: [],
};
let privateDecision;
let privateThread;
for (const id of users) {
  const identity = db.prepare('SELECT id,display_name FROM users WHERE id=?').get(id);
  if (!identity) throw new Error('Missing existing identity ' + id);
  const auth = await read('/dashboard/api/auth/me', id);
  const aggregate = await read('/dashboard/api/observatory/v2?workgroup=all', id);
  if (aggregate.status !== 200) throw new Error('Signal not active: ' + aggregate.status);
  const d = aggregate.body;
  if (id === users[0]) {
    privateDecision = d.decisions.find((x) => x.workgroup_id === privateWorkgroup)?.id;
    privateThread = d.agents.filter((x) => x.workgroup_id === privateWorkgroup).flatMap((x) => x.thread_ids)[0];
  }
  const direct = await read('/dashboard/api/observatory/v2?workgroup=' + encodeURIComponent(privateWorkgroup), id);
  const decision = privateDecision
    ? await read('/dashboard/api/observatory/v2/decisions/' + encodeURIComponent(privateDecision), id)
    : null;
  const thread = privateThread ? await read('/dashboard/api/threads/' + encodeURIComponent(privateThread), id) : null;
  report.users.push({
    identity,
    scopes: auth.body.scopes,
    workgroups: d.workgroups.map((x) => x.id),
    counts: { agents: d.agents.length, decisions: d.decisions.length, projects: d.projects.length },
    source_ids: d.decisions.map((x) => ({
      id: x.id,
      workgroup_id: x.workgroup_id,
      source_kind: x.source_kind,
      source_id: x.source_id,
    })),
    direct_private: {
      status: direct.status,
      agents: direct.body.agents?.length,
      decisions: direct.body.decisions?.length,
      projects: direct.body.projects?.length,
    },
    private_decision: { id: privateDecision, status: decision?.status },
    private_thread: { id: privateThread, status: thread?.status },
  });
}
db.close();
const restricted = report.users.slice(1);
report.passed =
  report.unauthenticated === 401 &&
  restricted.every(
    (u) =>
      !u.scopes.no_filter &&
      u.workgroups.length === 1 &&
      u.workgroups[0] === sharedWorkgroup &&
      u.source_ids.every((x) => x.workgroup_id === sharedWorkgroup) &&
      u.direct_private.agents === 0 &&
      u.direct_private.decisions === 0 &&
      u.direct_private.projects === 0 &&
      u.private_decision.status === 404 &&
      u.private_thread.status === 404,
  );
fs.writeFileSync(path.join(evidence, 'scope-verification.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      origin,
      report: path.join(evidence, 'scope-verification.json'),
      users: report.users.map(({ source_ids, ...rest }) => rest),
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
