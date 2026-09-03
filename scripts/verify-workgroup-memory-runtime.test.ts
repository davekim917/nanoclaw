import { createHash } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { memoryTreeSha256, WORKGROUP_MEMORY_CONTAINER_PATH } from '../src/modules/workgroup/shared-dirs.js';
import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

// This suite drives the real `verify-workgroup-memory-runtime.ts` CLI end to
// end (every other property it checks — fail-closed on a tampered symlink, a
// drifted checksum, an escaped marker — only exists at that level), always
// against a scratch root under os.tmpdir() (`mkRoot()` below), never the
// checkout. The one real seam left is the CLI subprocess itself: `TSX`
// resolves to the repo's pinned node_modules/.bin/tsx, falling back to
// `which tsx` when that is absent (issue #305). `npx` is deliberately NOT
// exempted here even though it is TSX's last-resort fallback below — unlike
// the other two, it can reach the npm registry and would run an unpinned
// tsx (AGENTS.md's exact-resolution rule for runtime tools), which is
// exactly the escape this guard exists to catch. If a worktree is ever
// missing both a local tsx and a `tsx` on PATH, this suite should fail
// loudly on the guard rather than silently phone home.
allowSubprocess(['tsx', 'which']);
enforceHermeticity();

const SCRIPT = path.resolve('scripts/verify-workgroup-memory-runtime.ts');
// A literal join, not Node's ancestor-walk resolution — silently missing
// in a worktree without its own install. Same fallback as run-migrations.ts's resolveTsx().
const localTsx = path.resolve('node_modules/.bin/tsx');
const TSX = fs.existsSync(localTsx)
  ? localTsx
  : (() => {
      try {
        return execSync('which tsx', { encoding: 'utf8' }).trim();
      } catch {
        return 'npx';
      }
    })();
const roots: string[] = [];

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: {
    status: 'clean' | 'degraded' | 'failed';
    activationBlocking: boolean;
    summary: { workgroups: number; members: number; sessions: number; failures: number; warnings: number };
    workgroups: Array<{
      id: string;
      status: 'clean' | 'degraded' | 'failed';
      canonical: { sha256: string | null };
      members: Array<{ id: string; compatibility: { status: string }; nativeViews: Array<{ status: string }> }>;
      sessions: Array<{ id: string; status: string; pairs: { applicableTriggers: number; complete: number } }>;
      migration: { status: string };
      issues: Array<{ code: string; severity: string; detail?: string }>;
    }>;
    issues: Array<{ code: string; severity: string; detail?: string }>;
  };
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-verify-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  return root;
}

function centralDb(root: string): Database.Database {
  const db = new Database(path.join(root, 'data', 'v2.db'));
  db.exec(`
    CREATE TABLE workgroups (id TEXT PRIMARY KEY);
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY,
      folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT,
      workgroup_id TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT,
      thread_id TEXT,
      status TEXT,
      container_status TEXT
    );
  `);
  return db;
}

function writeInbound(
  root: string,
  agentGroupId: string,
  sessionId: string,
  messagingGroupId: string,
  options: { omitRecall?: boolean; malformedRecall?: boolean; omitTrustedCapabilities?: boolean } = {},
): void {
  const dir = path.join(root, 'data', 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'inbound.db'));
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      process_after TEXT,
      recurrence TEXT,
      series_id TEXT,
      tries INTEGER DEFAULT 0,
      trigger INTEGER NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      source_session_id TEXT,
      on_wake INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE session_routing (
      id INTEGER PRIMARY KEY,
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT,
      spawn_task_id TEXT,
      session_id TEXT
    );
  `);
  const timestamp = '2026-07-26T02:00:00.000Z';
  const triggerId = 'turn-1';
  if (!options.omitRecall) {
    const recall = options.malformedRecall
      ? { subtype: 'recall_context', trustedCapabilities: { agentGroupId: 'foreign', services: [] } }
      : {
          subtype: 'recall_context',
          ...(options.omitTrustedCapabilities
            ? {}
            : { trustedCapabilities: { agentGroupId, services: [{ name: `safe-for:${messagingGroupId}` }] } }),
          memoryEvidence: { core: [], excerpts: [] },
          conversationEvidence: { excerpts: [] },
          notices: [],
        };
    db.prepare(
      `INSERT INTO messages_in
         (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `recall-${triggerId}`,
      2,
      'system',
      timestamp,
      'pending',
      0,
      'discord:1:2',
      'discord',
      'discord:1:2:3',
      JSON.stringify(recall),
      0,
    );
  }
  db.prepare(
    `INSERT INTO messages_in
       (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    triggerId,
    options.omitRecall ? 2 : 4,
    'chat-sdk',
    timestamp,
    'pending',
    1,
    'discord:1:2',
    'discord',
    'discord:1:2:3',
    JSON.stringify({ text: 'Where is SipTrue DNS hosted?' }),
    0,
  );
  db.prepare(
    `INSERT INTO session_routing
       (id,channel_type,platform_id,thread_id,spawn_task_id,session_id)
     VALUES (1,'discord','discord:1:2','discord:1:2:3',NULL,?)`,
  ).run(sessionId);
  db.close();
}

function inventoryEntry(relativePath: string, content: string) {
  return {
    relativePath,
    type: 'file',
    size: Buffer.byteLength(content),
    sha256: hash(content),
  };
}

function seedAppliedWorkgroup(
  root: string,
  db: Database.Database,
  workgroupId = 'house',
  options: { omitRecall?: boolean; malformedRecall?: boolean; omitTrustedCapabilities?: boolean } = {},
): void {
  const dataDir = path.join(root, 'data');
  const groupsDir = path.join(root, 'groups');
  const dbPath = path.join(dataDir, 'v2.db');
  const members = [
    { id: 'house-claude', folder: 'house', provider: 'claude' },
    { id: 'house-codex', folder: 'house-codex', provider: 'codex' },
    { id: 'house-opencode', folder: 'house-opencode', provider: 'opencode' },
  ];
  db.prepare('INSERT INTO workgroups (id) VALUES (?)').run(workgroupId);
  const insertMember = db.prepare('INSERT INTO agent_groups (id,folder,agent_provider,workgroup_id) VALUES (?,?,?,?)');
  for (const member of members) insertMember.run(member.id, member.folder, member.provider, workgroupId);

  const canon = path.join(dataDir, 'workgroups', workgroupId, 'memory');
  const memoryText = '# Canon\nSipTrue DNS is managed in Wix. GSC data is queried in Snowflake.\n';
  fs.mkdirSync(canon, { recursive: true });
  fs.writeFileSync(path.join(canon, 'index.md'), memoryText);
  for (const member of members) {
    const groupDir = path.join(groupsDir, member.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(groupDir, 'memory'));
  }

  for (const member of members) {
    const nativeMemory = path.join(
      dataDir,
      'v2-sessions',
      member.id,
      '.claude-shared',
      'projects',
      '-workspace-agent',
      'memory',
    );
    fs.mkdirSync(path.dirname(nativeMemory), { recursive: true });
    fs.symlinkSync(canon, nativeMemory);
  }

  const sessionId = 'session-1';
  db.prepare(
    `INSERT INTO sessions
       (id,agent_group_id,messaging_group_id,thread_id,status,container_status)
     VALUES (?,?,?,?,?,?)`,
  ).run(sessionId, 'house-claude', 'mg-discord', 'discord:1:2:3', 'active', 'stopped');
  writeInbound(root, 'house-claude', sessionId, 'mg-discord', options);

  const snapshotDir = path.join(dataDir, 'workgroup-memory-snapshots', workgroupId, '2026-07-26T01-00-00-000Z-fixture');
  const snapshotRoot = path.join(snapshotDir, 'sources', '001-group-house', 'root');
  fs.mkdirSync(snapshotRoot, { recursive: true });
  fs.writeFileSync(path.join(snapshotRoot, 'index.md'), memoryText);

  const reportDir = path.join(dataDir, 'workgroup-memory-migration-reports');
  const reportPath = path.join(reportDir, 'fixture.json');
  fs.mkdirSync(reportDir, { recursive: true });
  const fileEntry = inventoryEntry('index.md', memoryText);
  const report = {
    version: 1,
    createdAt: '2026-07-26T01:00:00.000Z',
    updatedAt: '2026-07-26T01:05:00.000Z',
    dbPath,
    groupsDir,
    dataDir,
    workgroups: [
      {
        workgroupId,
        status: 'applied',
        canonicalPath: canon,
        sources: [
          {
            kind: 'canonical',
            rootPath: canon,
            rootType: 'missing',
            rootSize: 0,
            rootSha256: hash(''),
            entries: [],
            ignoredScaffold: false,
          },
          {
            kind: 'group',
            groupId: 'house-claude',
            folder: 'house',
            rootPath: path.join(groupsDir, 'house', 'memory'),
            rootType: 'directory',
            rootSize: 0,
            rootSha256: hash(`${fileEntry.relativePath}\0${fileEntry.type}\0${fileEntry.size}\0${fileEntry.sha256}\0`),
            entries: [fileEntry],
            ignoredScaffold: false,
          },
        ],
        snapshotDir,
        snapshotEntries: [
          {
            sourcePath: canon,
            sourceType: 'missing',
          },
          {
            sourcePath: path.join(groupsDir, 'house', 'memory'),
            sourceType: 'directory',
            snapshotPath: snapshotRoot,
          },
        ],
        outcomes: [
          {
            sourcePath: path.join(groupsDir, 'house', 'memory'),
            sourceGroup: 'house',
            relativePath: 'index.md',
            sha256: fileEntry.sha256,
            canonicalRelativePath: 'index.md',
            exactDuplicate: false,
          },
        ],
      },
    ],
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dataDir, 'workgroups', workgroupId, '.memory-migration.json'),
    `${JSON.stringify(
      {
        version: 1,
        workgroupId,
        status: 'applied',
        reportPath,
        snapshotDir,
        canonicalSha256: memoryTreeSha256(canon),
        updatedAt: '2026-07-26T01:05:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
}

// npx (last-resort TSX fallback) needs the package name as its first arg; a
// direct tsx binary does not.
const tsxArgs = (args: string[]) => (TSX.endsWith('npx') ? ['tsx', ...args] : args);

function run(root: string, args: string[]): CliResult {
  const result = spawnSync(TSX, tsxArgs([SCRIPT, ...args]), {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  let json: CliResult['json'];
  try {
    json = JSON.parse(result.stdout) as CliResult['json'];
  } catch (error) {
    throw new Error(`Verifier did not emit JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, {
      cause: error,
    });
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function filesystemFingerprint(root: string): string {
  const records: string[] = [];
  const visit = (absolute: string, relative: string): void => {
    const st = fs.lstatSync(absolute);
    if (st.isSymbolicLink()) {
      records.push(`l:${relative}:${fs.readlinkSync(absolute)}`);
      return;
    }
    if (st.isFile()) {
      records.push(`f:${relative}:${st.size}:${st.mtimeMs}:${hash(fs.readFileSync(absolute))}`);
      return;
    }
    records.push(`d:${relative}:${st.mtimeMs}`);
    for (const child of fs.readdirSync(absolute).sort()) {
      visit(path.join(absolute, child), relative ? path.join(relative, child) : child);
    }
  };
  visit(root, '');
  return hash(records.join('\n'));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('verify-workgroup-memory-runtime', () => {
  it('verifies one canon, every sibling/native view, rollback bytes, outcomes, and complete session pairs read-only', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();
    const before = filesystemFingerprint(root);

    const result = run(root, ['--all', '--json', '--require-applied-migration']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.json.status).toBe('clean');
    expect(result.json.activationBlocking).toBe(false);
    expect(result.json.summary).toMatchObject({ workgroups: 1, members: 3, sessions: 1, failures: 0 });
    expect(result.json.workgroups[0]).toMatchObject({
      id: 'house',
      status: 'clean',
      migration: { status: 'verified-applied' },
      sessions: [{ id: 'session-1', status: 'clean', pairs: { applicableTriggers: 1, complete: 1 } }],
    });
    expect(result.json.workgroups[0]!.members.every((member) => member.compatibility.status === 'verified')).toBe(true);
    expect(
      result.json.workgroups[0]!.members.map((member) => ({
        id: member.id,
        nativeViews: member.nativeViews.map((view) => view.status),
      })),
    ).toEqual([
      { id: 'house-claude', nativeViews: ['verified'] },
      { id: 'house-codex', nativeViews: ['verified'] },
      { id: 'house-opencode', nativeViews: ['verified'] },
    ]);
    expect(result.stdout).not.toContain('SipTrue DNS is managed in Wix');
    expect(result.stdout).not.toContain('GSC data is queried in Snowflake');
    expect(filesystemFingerprint(root)).toBe(before);
  }, 15_000);

  it('accepts a complete warm-turn recall payload without repeated capabilities', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { omitTrustedCapabilities: true });
    db.close();

    const result = run(root, ['--all', '--json', '--require-applied-migration']);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('clean');
    expect(result.json.workgroups[0]!.sessions).toContainEqual(
      expect.objectContaining({
        id: 'session-1',
        status: 'clean',
        pairs: expect.objectContaining({ applicableTriggers: 1, complete: 1 }),
      }),
    );
  }, 15_000);

  it('allows authorized post-cutover memory writes without weakening the explicit cutover gate', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();

    const canon = path.join(root, 'data', 'workgroups', 'house', 'memory');
    fs.appendFileSync(path.join(canon, 'index.md'), '\nAuthorized foreground memory.\n');
    const generated = path.join(canon, 'generated');
    fs.mkdirSync(generated);
    fs.writeFileSync(
      path.join(generated, 'memory.md'),
      [
        '# Generated workgroup memory',
        '',
        '- Authorized background memory. <!-- nanoclaw-memory:id=mem_0123456789abcdef;evidence=platform:message-1;captured=2026-07-26T02:00:00.000Z -->',
        '',
      ].join('\n'),
    );

    const runtime = run(root, ['--workgroup', 'house', '--json']);
    expect(runtime.status, runtime.stdout).toBe(0);
    expect(runtime.json.workgroups[0]).toMatchObject({
      status: 'clean',
      migration: { status: 'verified-applied' },
    });
    expect(runtime.json.workgroups[0]!.issues).not.toContainEqual(
      expect.objectContaining({ code: 'canonical-checksum-mismatch' }),
    );
    expect(runtime.json.workgroups[0]!.issues).not.toContainEqual(
      expect.objectContaining({ code: 'canonical-outcome-mismatch' }),
    );

    const cutover = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);
    expect(cutover.status).toBe(1);
    expect(cutover.json.workgroups[0]!.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'canonical-checksum-mismatch', severity: 'failure' }),
        expect.objectContaining({ code: 'canonical-outcome-mismatch', severity: 'failure' }),
      ]),
    );
  }, 15_000);

  it('fails closed when distinct intended paths collapse to one outcome destination', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();

    const content = 'same customer bytes\n';
    const canon = path.join(root, 'data', 'workgroups', 'house', 'memory');
    const snapshotRoot = path.join(
      root,
      'data',
      'workgroup-memory-snapshots',
      'house',
      '2026-07-26T01-00-00-000Z-fixture',
      'sources',
      '001-group-house',
      'root',
    );
    fs.mkdirSync(path.join(canon, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(canon, 'notes', 'customer.md'), content);
    fs.mkdirSync(path.join(snapshotRoot, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(snapshotRoot, 'contacts'), { recursive: true });
    fs.writeFileSync(path.join(snapshotRoot, 'notes', 'customer.md'), content);
    fs.writeFileSync(path.join(snapshotRoot, 'contacts', 'customer.md'), content);

    const reportPath = path.join(root, 'data', 'workgroup-memory-migration-reports', 'fixture.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      workgroups: Array<{
        sources: Array<{ rootSha256: string; entries: ReturnType<typeof inventoryEntry>[] }>;
        outcomes: Array<Record<string, unknown>>;
      }>;
    };
    const source = report.workgroups[0]!.sources[1]!;
    const directoryEntry = (relativePath: string) => {
      const absolute = path.join(snapshotRoot, relativePath);
      return {
        relativePath,
        type: 'directory',
        size: fs.lstatSync(absolute).size,
        sha256: hash(`directory\0${relativePath}`),
      };
    };
    source.entries = [
      ...source.entries,
      directoryEntry('contacts'),
      inventoryEntry(path.join('contacts', 'customer.md'), content),
      directoryEntry('notes'),
      inventoryEntry(path.join('notes', 'customer.md'), content),
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    source.rootSha256 = hash(
      source.entries
        .map((entry) => `${entry.relativePath}\0${entry.type}\0${entry.size}\0${entry.sha256}\0`)
        .join('\n'),
    );
    report.workgroups[0]!.outcomes.push(
      {
        sourcePath: path.join(root, 'groups', 'house', 'memory'),
        sourceGroup: 'house',
        relativePath: path.join('contacts', 'customer.md'),
        sha256: hash(content),
        canonicalRelativePath: path.join('notes', 'customer.md'),
        exactDuplicate: true,
      },
      {
        sourcePath: path.join(root, 'groups', 'house', 'memory'),
        sourceGroup: 'house',
        relativePath: path.join('notes', 'customer.md'),
        sha256: hash(content),
        canonicalRelativePath: path.join('notes', 'customer.md'),
        exactDuplicate: false,
      },
    );
    fs.writeFileSync(reportPath, JSON.stringify(report));

    const markerPath = path.join(root, 'data', 'workgroups', 'house', '.memory-migration.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.canonicalSha256 = memoryTreeSha256(canon);
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const result = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);
    const codes = result.json.workgroups[0]!.issues.map((issue) => issue.code);

    expect(result.status).toBe(1);
    expect(codes).toContain('migration-outcome-path-identity-mismatch');
  }, 15_000);

  it('fails closed when migration changes a relative Markdown link target', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();

    const canon = path.join(root, 'data', 'workgroups', 'house', 'memory');
    const snapshotRoot = path.join(
      root,
      'data',
      'workgroup-memory-snapshots',
      'house',
      '2026-07-26T01-00-00-000Z-fixture',
      'sources',
      '001-group-house',
      'root',
    );
    const indexContent = '[Target](target.md)\n';
    const targetContent = 'source target\n';
    fs.writeFileSync(path.join(snapshotRoot, 'index.md'), indexContent);
    fs.writeFileSync(path.join(snapshotRoot, 'target.md'), targetContent);
    fs.mkdirSync(path.join(canon, 'imports', 'house'), { recursive: true });
    fs.writeFileSync(path.join(canon, 'imports', 'house', 'index.md'), indexContent);
    fs.writeFileSync(path.join(canon, 'target.md'), targetContent);

    const reportPath = path.join(root, 'data', 'workgroup-memory-migration-reports', 'fixture.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      workgroups: Array<{
        sources: Array<{ rootSha256: string; entries: ReturnType<typeof inventoryEntry>[] }>;
        outcomes: Array<Record<string, unknown>>;
      }>;
    };
    const source = report.workgroups[0]!.sources[1]!;
    source.entries = [inventoryEntry('index.md', indexContent), inventoryEntry('target.md', targetContent)];
    source.rootSha256 = hash(
      source.entries
        .map((entry) => `${entry.relativePath}\0${entry.type}\0${entry.size}\0${entry.sha256}\0`)
        .join('\n'),
    );
    report.workgroups[0]!.outcomes = [
      {
        sourcePath: path.join(root, 'groups', 'house', 'memory'),
        sourceGroup: 'house',
        relativePath: 'index.md',
        sha256: hash(indexContent),
        canonicalRelativePath: path.join('imports', 'house', 'index.md'),
        exactDuplicate: false,
      },
      {
        sourcePath: path.join(root, 'groups', 'house', 'memory'),
        sourceGroup: 'house',
        relativePath: 'target.md',
        sha256: hash(targetContent),
        canonicalRelativePath: 'target.md',
        exactDuplicate: false,
      },
    ];
    fs.writeFileSync(reportPath, JSON.stringify(report));

    const markerPath = path.join(root, 'data', 'workgroups', 'house', '.memory-migration.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.canonicalSha256 = memoryTreeSha256(canon);
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const result = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);
    const codes = result.json.workgroups[0]!.issues.map((issue) => issue.code);

    expect(result.status).toBe(1);
    expect(codes).toContain('migration-relative-link-identity-mismatch');
  }, 15_000);

  it('uses the migration inventory ordering for locale-sensitive snapshot filenames', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();

    const names = ['project_xzo216_hotfix.md', 'project_xzo_195_shipment.md'];
    const canon = path.join(root, 'data', 'workgroups', 'house', 'memory');
    const snapshotRoot = path.join(
      root,
      'data',
      'workgroup-memory-snapshots',
      'house',
      '2026-07-26T01-00-00-000Z-fixture',
      'sources',
      '001-group-house',
      'root',
    );
    for (const name of names) {
      fs.writeFileSync(path.join(canon, name), name);
      fs.writeFileSync(path.join(snapshotRoot, name), name);
    }

    const reportPath = path.join(root, 'data', 'workgroup-memory-migration-reports', 'fixture.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      workgroups: Array<{
        sources: Array<{ rootSha256: string; entries: ReturnType<typeof inventoryEntry>[] }>;
        outcomes: Array<Record<string, unknown>>;
      }>;
    };
    const source = report.workgroups[0]!.sources[1]!;
    source.entries = [...source.entries, ...names.map((name) => inventoryEntry(name, name))].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    source.rootSha256 = hash(
      source.entries
        .map((entry) => `${entry.relativePath}\0${entry.type}\0${entry.size}\0${entry.sha256}\0`)
        .join('\n'),
    );
    report.workgroups[0]!.outcomes.push(
      ...names.map((name) => ({
        sourcePath: path.join(root, 'groups', 'house', 'memory'),
        sourceGroup: 'house',
        relativePath: name,
        sha256: hash(name),
        canonicalRelativePath: name,
        exactDuplicate: false,
      })),
    );
    fs.writeFileSync(reportPath, JSON.stringify(report));

    const markerPath = path.join(root, 'data', 'workgroups', 'house', '.memory-migration.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.canonicalSha256 = memoryTreeSha256(canon);
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const result = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('clean');
    expect(result.json.workgroups[0]!.migration.status).toBe('verified-applied');
  }, 15_000);

  it('verifies a snapshotted symlink as link metadata without following its target', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();
    const snapshotDir = path.join(
      root,
      'data',
      'workgroup-memory-snapshots',
      'house',
      '2026-07-26T01-00-00-000Z-fixture',
    );
    const snapshotPath = path.join(snapshotDir, 'sources', '002-group-house-codex', 'root');
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, snapshotPath);
    const reportPath = path.join(root, 'data', 'workgroup-memory-migration-reports', 'fixture.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      workgroups: Array<{
        sources: Array<Record<string, unknown>>;
        snapshotEntries: Array<Record<string, unknown>>;
      }>;
    };
    const linkEntry = {
      relativePath: '',
      type: 'symlink',
      size: Buffer.byteLength(WORKGROUP_MEMORY_CONTAINER_PATH),
      sha256: hash(WORKGROUP_MEMORY_CONTAINER_PATH),
      linkTarget: WORKGROUP_MEMORY_CONTAINER_PATH,
    };
    report.workgroups[0]!.sources.push({
      kind: 'group',
      groupId: 'house-codex',
      folder: 'house-codex',
      rootPath: path.join(root, 'groups', 'house-codex', 'memory'),
      rootType: 'symlink',
      rootSize: fs.lstatSync(path.join(root, 'groups', 'house-codex', 'memory')).size,
      rootSha256: hash(
        `${linkEntry.relativePath}\0${linkEntry.type}\0${linkEntry.size}\0${linkEntry.sha256}\0${linkEntry.linkTarget}`,
      ),
      ignoredScaffold: false,
      entries: [linkEntry],
    });
    report.workgroups[0]!.snapshotEntries.push({
      sourcePath: path.join(root, 'groups', 'house-codex', 'memory'),
      sourceType: 'symlink',
      snapshotPath,
    });
    fs.writeFileSync(reportPath, JSON.stringify(report));

    const result = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('clean');
  }, 15_000);

  it('fails closed on a foreign sibling link, canonical checksum drift, malformed pair, and rollback drift', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { malformedRecall: true });
    db.close();

    fs.unlinkSync(path.join(root, 'groups', 'house-codex', 'memory'));
    fs.symlinkSync('/workspace/workgroup/foreign-memory', path.join(root, 'groups', 'house-codex', 'memory'));
    const nativeMemory = path.join(
      root,
      'data',
      'v2-sessions',
      'house-claude',
      '.claude-shared',
      'projects',
      '-workspace-agent',
      'memory',
    );
    fs.unlinkSync(nativeMemory);
    fs.symlinkSync(path.join(root, 'data', 'workgroups', 'foreign-house', 'memory'), nativeMemory);
    fs.appendFileSync(path.join(root, 'data', 'workgroups', 'house', 'memory', 'index.md'), 'tampered\n');
    fs.appendFileSync(
      path.join(
        root,
        'data',
        'workgroup-memory-snapshots',
        'house',
        '2026-07-26T01-00-00-000Z-fixture',
        'sources',
        '001-group-house',
        'root',
        'index.md',
      ),
      'tampered\n',
    );

    const result = run(root, ['--workgroup', 'house', '--json', '--require-applied-migration']);
    const codes = result.json.workgroups[0]!.issues.map((issue) => issue.code);

    expect(result.status).toBe(1);
    expect(result.json.status).toBe('failed');
    expect(result.json.activationBlocking).toBe(true);
    expect(codes).toEqual(
      expect.arrayContaining([
        'member-link-target-mismatch',
        'native-memory-link-target-mismatch',
        'canonical-checksum-mismatch',
        'rollback-entry-mismatch',
        'recall-payload-incomplete',
      ]),
    );
  }, 15_000);

  it.each(['house-codex', 'house-opencode'])(
    'fails activation when a non-Claude sibling retains a stale Claude-native view: %s',
    (agentGroupId) => {
      const root = mkRoot();
      const db = centralDb(root);
      seedAppliedWorkgroup(root, db);
      db.close();
      const nativeMemory = path.join(
        root,
        'data',
        'v2-sessions',
        agentGroupId,
        '.claude-shared',
        'projects',
        '-workspace-agent',
        'memory',
      );
      fs.unlinkSync(nativeMemory);
      fs.symlinkSync(path.join(root, 'data', 'workgroups', 'foreign-house', 'memory'), nativeMemory);

      const result = run(root, ['--workgroup', 'house', '--json']);

      expect(result.status).toBe(1);
      expect(result.json.activationBlocking).toBe(true);
      expect(result.json.workgroups[0]!.issues).toContainEqual(
        expect.objectContaining({
          code: 'native-memory-link-target-mismatch',
          severity: 'failure',
          subject: agentGroupId,
        }),
      );
    },
    15_000,
  );

  it.each([
    {
      name: 'marker file',
      escape(root: string, sentinel: string) {
        const marker = path.join(root, 'data', 'workgroups', 'house', '.memory-migration.json');
        const outside = path.join(root, 'outside-marker.json');
        const contents = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(outside, JSON.stringify({ ...contents, outsideSentinel: sentinel }));
        fs.unlinkSync(marker);
        fs.symlinkSync(outside, marker);
      },
    },
    {
      name: 'marker ancestor',
      escape(root: string, sentinel: string) {
        const workgroupDir = path.join(root, 'data', 'workgroups', 'house');
        const outside = path.join(root, 'outside-workgroup');
        fs.renameSync(workgroupDir, outside);
        const marker = path.join(outside, '.memory-migration.json');
        const contents = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(marker, JSON.stringify({ ...contents, outsideSentinel: sentinel }));
        fs.symlinkSync(outside, workgroupDir, 'dir');
      },
    },
    {
      name: 'report file',
      escape(root: string, sentinel: string) {
        const report = path.join(root, 'data', 'workgroup-memory-migration-reports', 'fixture.json');
        const outside = path.join(root, 'outside-report.json');
        const contents = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(outside, JSON.stringify({ ...contents, outsideSentinel: sentinel }));
        fs.unlinkSync(report);
        fs.symlinkSync(outside, report);
      },
    },
    {
      name: 'report ancestor',
      escape(root: string, sentinel: string) {
        const reportRoot = path.join(root, 'data', 'workgroup-memory-migration-reports');
        const outside = path.join(root, 'outside-reports');
        fs.renameSync(reportRoot, outside);
        const report = path.join(outside, 'fixture.json');
        const contents = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(report, JSON.stringify({ ...contents, outsideSentinel: sentinel }));
        fs.symlinkSync(outside, reportRoot, 'dir');
      },
    },
    {
      name: 'snapshot ancestor',
      escape(root: string) {
        const snapshotDir = path.join(
          root,
          'data',
          'workgroup-memory-snapshots',
          'house',
          '2026-07-26T01-00-00-000Z-fixture',
        );
        const outside = path.join(root, 'outside-snapshot');
        fs.renameSync(snapshotDir, outside);
        fs.symlinkSync(outside, snapshotDir, 'dir');
      },
    },
    {
      name: 'snapshot entry ancestor',
      escape(root: string) {
        const sources = path.join(
          root,
          'data',
          'workgroup-memory-snapshots',
          'house',
          '2026-07-26T01-00-00-000Z-fixture',
          'sources',
        );
        const outside = path.join(root, 'outside-snapshot-sources');
        fs.renameSync(sources, outside);
        fs.symlinkSync(outside, sources, 'dir');
      },
    },
    {
      name: 'snapshot root ancestor',
      escape(root: string) {
        const snapshotRoot = path.join(root, 'data', 'workgroup-memory-snapshots');
        const outside = path.join(root, 'outside-snapshot-root');
        fs.renameSync(snapshotRoot, outside);
        fs.symlinkSync(outside, snapshotRoot, 'dir');
      },
    },
  ])(
    'rejects a migration $name escape without emitting outside bytes',
    ({ escape }) => {
      const root = mkRoot();
      const db = centralDb(root);
      seedAppliedWorkgroup(root, db);
      db.close();
      const sentinel = 'OUTSIDE_SENTINEL_MUST_NOT_LEAK';
      escape(root, sentinel);

      const result = run(root, ['--workgroup', 'house', '--json']);

      expect(result.status).toBe(1);
      expect(result.json.activationBlocking).toBe(true);
      expect(result.stdout).not.toContain(sentinel);
      expect(result.stdout).not.toContain(hash(sentinel));
    },
    15_000,
  );

  it('treats a post-activation trigger without its adjacent recall row as activation-blocking', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { omitRecall: true });
    db.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(1);
    expect(result.json.activationBlocking).toBe(true);
    expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
      status: 'failed',
      pairs: { applicableTriggers: 1, complete: 0 },
    });
    expect(result.json.workgroups[0]!.issues).toContainEqual(
      expect.objectContaining({ code: 'recall-pair-missing', severity: 'failure' }),
    );
  }, 15_000);

  it.each(['pending', 'processing'])(
    'treats a pre-activation %s trigger without recall as activation-blocking',
    (status) => {
      const root = mkRoot();
      const db = centralDb(root);
      seedAppliedWorkgroup(root, db, 'house', { omitRecall: true });
      db.close();
      const inbound = new Database(path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db'));
      inbound
        .prepare("UPDATE messages_in SET timestamp = '2026-07-26T00:00:00.000Z', status = ? WHERE id = 'turn-1'")
        .run(status);
      inbound.close();

      const result = run(root, ['--workgroup', 'house', '--json']);

      expect(result.status).toBe(1);
      expect(result.json.activationBlocking).toBe(true);
      expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
        status: 'failed',
        pairs: { applicableTriggers: 1, complete: 0 },
      });
      expect(result.json.workgroups[0]!.issues).toContainEqual(
        expect.objectContaining({ code: 'recall-pair-missing', severity: 'failure' }),
      );
    },
    15_000,
  );

  it('keeps terminal pre-activation history outside the bounded pairing audit', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { omitRecall: true });
    db.close();
    const inbound = new Database(path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db'));
    inbound
      .prepare(
        "UPDATE messages_in SET timestamp = '2026-07-26T00:00:00.000Z', status = 'completed' WHERE id = 'turn-1'",
      )
      .run();
    inbound.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
      status: 'clean',
      pairs: { applicableTriggers: 0, complete: 0 },
    });
  }, 15_000);

  it('does not let legacy recall rows widen the structured post-activation audit', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { omitRecall: true });
    db.close();
    const inbound = new Database(path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db'));
    inbound
      .prepare(
        `UPDATE messages_in
            SET seq = 6, timestamp = '2026-07-26T00:00:00.000Z', status = 'completed'
          WHERE id = 'turn-1'`,
      )
      .run();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'recall-legacy-turn',
        2,
        'system',
        '2026-07-26T00:00:00.000Z',
        'completed',
        0,
        'discord:1:2',
        'discord',
        'discord:1:2:3',
        JSON.stringify({ text: '[Recalled context]\nlegacy provider recap' }),
        0,
      );
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content,on_wake)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'legacy-turn',
        4,
        'chat-sdk',
        '2026-07-26T00:00:00.000Z',
        'completed',
        1,
        'discord:1:2',
        'discord',
        'discord:1:2:3',
        JSON.stringify({ text: 'legacy completed turn' }),
        0,
      );
    inbound.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.activationBlocking).toBe(false);
    expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
      status: 'clean',
      pairs: { applicableTriggers: 0, complete: 0 },
    });
  }, 15_000);

  it('leaves pre-activation scheduled rows to the due-task admission seam', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db, 'house', { omitRecall: true });
    db.close();
    const inbound = new Database(path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db'));
    inbound
      .prepare(
        `UPDATE messages_in
            SET kind = 'task',
                timestamp = '2026-07-26T00:00:00.000Z',
                status = 'pending',
                process_after = '2026-07-27T00:00:00.000Z',
                recurrence = '0 0 * * *'
          WHERE id = 'turn-1'`,
      )
      .run();
    inbound.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.activationBlocking).toBe(false);
    expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
      status: 'clean',
      pairs: { applicableTriggers: 0, complete: 0 },
    });
  }, 15_000);

  it('accepts a complete pair when task-script processing advances only the trigger status', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();
    const inbound = new Database(path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db'));
    inbound.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'turn-1'").run();
    inbound.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.activationBlocking).toBe(false);
    expect(result.json.workgroups[0]!.sessions[0]).toMatchObject({
      status: 'clean',
      pairs: { applicableTriggers: 1, complete: 1 },
    });
  }, 15_000);

  it('reports a valid unmanifested canon as degraded without inventing migration success', () => {
    const root = mkRoot();
    const db = centralDb(root);
    db.prepare('INSERT INTO workgroups (id) VALUES (?)').run('new-house');
    db.prepare('INSERT INTO agent_groups (id,folder,agent_provider,workgroup_id) VALUES (?,?,?,?)').run(
      'new-agent',
      'new-agent',
      'codex',
      'new-house',
    );
    db.close();
    fs.mkdirSync(path.join(root, 'data', 'workgroups', 'new-house', 'memory'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups', 'new-agent'), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(root, 'groups', 'new-agent', 'memory'));

    const result = run(root, ['--all', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('degraded');
    expect(result.json.activationBlocking).toBe(false);
    expect(result.json.workgroups[0]!.migration.status).toBe('not-recorded');
    expect(result.json.workgroups[0]!.issues).toContainEqual(
      expect.objectContaining({ code: 'migration-marker-missing', severity: 'warning' }),
    );
  }, 15_000);

  it('requires verified applied provenance only when activation mode is requested', () => {
    const root = mkRoot();
    const db = centralDb(root);
    db.prepare('INSERT INTO workgroups (id) VALUES (?)').run('new-house');
    db.prepare('INSERT INTO agent_groups (id,folder,agent_provider,workgroup_id) VALUES (?,?,?,?)').run(
      'new-agent',
      'new-agent',
      'codex',
      'new-house',
    );
    db.close();
    fs.mkdirSync(path.join(root, 'data', 'workgroups', 'new-house', 'memory'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups', 'new-agent'), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(root, 'groups', 'new-agent', 'memory'));

    const diagnostic = run(root, ['--all', '--json']);
    const activation = run(root, ['--all', '--json', '--require-applied-migration']);

    expect(diagnostic.status).toBe(0);
    expect(diagnostic.json.status).toBe('degraded');
    expect(activation.status).toBe(1);
    expect(activation.json.activationBlocking).toBe(true);
    expect(activation.json.workgroups[0]!.issues).toContainEqual(
      expect.objectContaining({ code: 'applied-migration-required', severity: 'failure' }),
    );
  }, 15_000);

  it('rejects unknown or path-shaped workgroup selectors before deriving any filesystem target', () => {
    const root = mkRoot();
    const db = centralDb(root);
    db.prepare('INSERT INTO workgroups (id) VALUES (?)').run('safe');
    db.close();
    fs.writeFileSync(path.join(root, 'outside-sentinel'), 'must-not-be-read');

    const result = run(root, ['--workgroup', '../outside-sentinel', '--json']);

    expect(result.status).toBe(1);
    expect(result.json.status).toBe('failed');
    expect(result.json.workgroups).toEqual([]);
    expect(result.json.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown-workgroup', severity: 'failure' }),
    );
    expect(result.stdout).not.toContain('must-not-be-read');
  }, 15_000);

  it('preserves the central schema failure cause in activation-blocking output', () => {
    const root = mkRoot();
    const db = new Database(path.join(root, 'data', 'v2.db'));
    db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)');
    db.close();

    const result = run(root, ['--all', '--json']);

    expect(result.status).toBe(1);
    expect(result.json.issues).toContainEqual(
      expect.objectContaining({
        code: 'central-db-schema-invalid',
        severity: 'failure',
        detail: expect.stringMatching(/no such table: workgroups/),
      }),
    );
  }, 15_000);

  it('preserves the session audit failure cause in activation-blocking output', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.close();
    const inboundPath = path.join(root, 'data', 'v2-sessions', 'house-claude', 'session-1', 'inbound.db');
    const inbound = new Database(inboundPath);
    inbound.exec('DROP TABLE messages_in; CREATE TABLE messages_in (id TEXT PRIMARY KEY)');
    inbound.close();

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(1);
    expect(result.json.workgroups[0]!.issues).toContainEqual(
      expect.objectContaining({
        code: 'session-verification-failed',
        severity: 'failure',
        detail: expect.stringMatching(/no such column: seq/),
      }),
    );
  }, 15_000);

  it('emits no foreign workgroup identifier or checksum for a trusted single-workgroup selection', () => {
    const root = mkRoot();
    const db = centralDb(root);
    seedAppliedWorkgroup(root, db);
    db.prepare('INSERT INTO workgroups (id) VALUES (?)').run('foreign-house');
    db.prepare('INSERT INTO agent_groups (id,folder,agent_provider,workgroup_id) VALUES (?,?,?,?)').run(
      'foreign-agent',
      'foreign-agent',
      'opencode',
      'foreign-house',
    );
    const foreignCanon = path.join(root, 'data', 'workgroups', 'foreign-house', 'memory');
    fs.mkdirSync(foreignCanon, { recursive: true });
    fs.writeFileSync(path.join(foreignCanon, 'index.md'), '# Foreign\nExact foreign evidence must stay isolated.\n');
    fs.mkdirSync(path.join(root, 'groups', 'foreign-agent'), { recursive: true });
    fs.symlinkSync(WORKGROUP_MEMORY_CONTAINER_PATH, path.join(root, 'groups', 'foreign-agent', 'memory'));
    db.close();
    const foreignChecksum = memoryTreeSha256(foreignCanon);

    const result = run(root, ['--workgroup', 'house', '--json']);

    expect(result.status).toBe(0);
    expect(result.json.summary.workgroups).toBe(1);
    expect(result.stdout).not.toContain('foreign-house');
    expect(result.stdout).not.toContain('foreign-agent');
    expect(result.stdout).not.toContain(foreignChecksum);
    expect(result.stdout).not.toContain('Exact foreign evidence must stay isolated');
  }, 15_000);
});
