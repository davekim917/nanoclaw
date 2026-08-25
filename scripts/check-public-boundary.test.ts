import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadLocalIdentifiers,
  loadRegistryIdentifiers,
  main,
  resolveOptions,
  run,
  runReport,
  scanInputs,
} from './check-public-boundary.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-boundary-'));
  roots.push(root);
  return root;
}

function initRepo(): string {
  const root = tempRoot();
  execFileSync('git', ['init', '-q'], { cwd: root });
  // Repo-local identity so `git commit` below does not depend on ambient
  // global config. A dev machine has one and CI does not, which is why this
  // passed locally and failed on the runner with "empty ident name".
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Boundary Test'], { cwd: root });
  fs.writeFileSync(path.join(root, '.public-boundary-allowlist.json'), '{"entries":[]}\n');
  execFileSync('git', ['add', '.public-boundary-allowlist.json'], { cwd: root });
  return root;
}

function input(file: string, text: string): { file: string; content: Buffer } {
  return { file, content: Buffer.from(text) };
}

// A "main checkout": a committed repo carrying the gitignored install state
// (data/v2.db + .nanoclaw/public-boundary-identifiers) that a linked worktree
// never gets a copy of, since both are gitignored.
function initInstallRepo(registryIdentifier: string, localIdentifier: string): string {
  const root = initRepo();
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'v2.db'));
  db.exec(`
    CREATE TABLE workgroups (id TEXT, display_name TEXT);
    CREATE TABLE agent_groups (id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
    CREATE TABLE messaging_groups (id TEXT, platform_id TEXT, instance TEXT, name TEXT);
    CREATE TABLE users (id TEXT, display_name TEXT);
  `);
  db.prepare('INSERT INTO workgroups (id, display_name) VALUES (?, ?)').run('main-house', registryIdentifier);
  db.close();
  fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), `${localIdentifier}\n`);
  return root;
}

function addLinkedWorktree(mainRoot: string): string {
  const worktreeRoot = tempRoot();
  execFileSync('git', ['worktree', 'add', '--detach', '-q', worktreeRoot], { cwd: mainRoot });
  return worktreeRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('scanInputs', () => {
  it('detects normalized private spellings without disclosing values', () => {
    const privateIdentifiers = new Set(['Acme Private']);
    const findings = scanInputs(
      [
        input('a.ts', 'const one = "acme-private";'),
        input('b.ts', 'const two = /acme.?private/i;'),
        input('c.ts', 'const three = "AcmePrivate";'),
      ],
      privateIdentifiers,
      [],
    );
    expect(findings).toEqual([
      { file: 'a.ts', line: 1, category: 'private-identifier' },
      { file: 'b.ts', line: 1, category: 'private-identifier' },
      { file: 'c.ts', line: 1, category: 'private-identifier' },
    ]);
    expect(JSON.stringify(findings)).not.toContain('Acme');
  });

  it('detects short private identifiers only in installation-specific context', () => {
    const findings = scanInputs(
      [input('private.ts', 'const adapter = "slack-mr";'), input('unrelated.md', 'Historical recommendation [MR-R9].')],
      new Set(['mr']),
      [],
    );
    expect(findings).toEqual([{ file: 'private.ts', line: 1, category: 'private-identifier' }]);
  });

  it('accepts reserved and unmistakably synthetic examples', () => {
    const findings = scanInputs(
      [
        input(
          'examples.md',
          [
            'person@example.com',
            'person@fixture12.example.com',
            '14155551234@s.whatsapp.net',
            'agent@nanoclaw.local',
            'git@github.com',
            'workspace-noreply@google.com',
            'calendar-notification@google.com',
            'http://x:secret@host.docker.internal:10255',
            'https://example.atlassian.net',
            'https://linear.app/example/issue/EX-1',
            'CEXAMPLE12',
            '123456789000000001',
            'ag-example-agent',
            'org_examplefixture',
          ].join('\n'),
        ),
      ],
      new Set(),
      [],
    );
    expect(findings).toEqual([]);
  });

  it('does not mistake scoped package versions for email addresses', () => {
    expect(
      scanInputs(
        [input('package.json', '"@chat-adapter/discord@4.29.0": "patches/@chat-adapter__discord@4.29.0.patch"')],
        new Set(),
        [],
      ),
    ).toEqual([]);
  });

  it('detects realistic structural values and skips binary files', () => {
    const at = String.fromCharCode(64);
    const realistic = [
      `person${at}company.dev`,
      ['https://tenant', 'atlassian.net'].join('.'),
      ['https://linear.app', 'workspace', 'issue', 'ABC-1'].join('/'),
      ['org', 'A1b2C3d4E5f6G7'].join('_'),
      ['C', '01ABCDEF2'].join(''),
      ['149', '6304577081770106'].join(''),
      ['ag', '1785000000000-abc123'].join('-'),
    ].join('\n');
    const findings = scanInputs(
      [input('live.test.ts', realistic), { file: 'asset.bin', content: Buffer.from([1, 0, 2]) }],
      new Set(),
      [],
    );
    expect(new Set(findings.map((finding) => finding.category))).toEqual(
      new Set([
        'email-address',
        'atlassian-tenant-url',
        'linear-workspace-url',
        'vendor-organization-id',
        'slack-identifier',
        'discord-identifier',
        'generated-install-identifier',
      ]),
    );
    expect(findings.some((finding) => finding.file === 'asset.bin')).toBe(false);
  });

  it('requires exact file and value allowlist matches', () => {
    const email = ['public', 'project.dev'].join(String.fromCharCode(64));
    const allowlist = [{ path: 'NOTICE.md', value: email, reason: 'published project contact' }];
    expect(scanInputs([input('NOTICE.md', email)], new Set(), allowlist)).toEqual([]);
    expect(scanInputs([input('OTHER.md', email)], new Set(), allowlist)).toHaveLength(1);
  });

  it('permits reviewed public values inside the allowlist itself without hiding private entries', () => {
    const publicId = ['1470', '188214710046894'].join('');
    const privateName = 'Private Customer';
    const allowlist = [
      { path: 'README.md', value: publicId, reason: 'published community identifier' },
      { path: 'NOTICE.md', value: privateName, reason: 'invalid private entry for regression coverage' },
    ];
    const serialized = JSON.stringify({ entries: allowlist }, null, 2);

    expect(scanInputs([input('.public-boundary-allowlist.json', serialized)], new Set(), allowlist)).toEqual([]);
    expect(
      scanInputs([input('.public-boundary-allowlist.json', serialized)], new Set([privateName]), allowlist),
    ).toEqual([{ file: '.public-boundary-allowlist.json', line: 10, category: 'private-identifier' }]);
  });

  it('rejects forbidden artifact paths', () => {
    const findings = scanInputs(
      [input('.context/specs/old.md', 'clean'), input('docs/specs/feature/qa-evidence/run.jsonl', 'clean')],
      new Set(),
      [],
    );
    expect(findings.every((finding) => finding.category === 'forbidden-artifact-path')).toBe(true);
  });
});

describe('install-aware inputs', () => {
  it('fails for missing or empty local inventory', () => {
    const root = tempRoot();
    expect(() => loadLocalIdentifiers(path.join(root, 'missing'))).toThrow('missing or unreadable');
    const empty = path.join(root, 'empty');
    fs.writeFileSync(empty, '# comments only\n');
    expect(() => loadLocalIdentifiers(empty)).toThrow('empty');
  });

  it('loads registry values and fails for a missing database', () => {
    const root = tempRoot();
    const dbPath = path.join(root, 'v2.db');
    const platformId = ['C', '01PRIVATE2'].join('');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workgroups (id TEXT, display_name TEXT);
      CREATE TABLE agent_groups (id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
      CREATE TABLE messaging_groups (id TEXT, platform_id TEXT, instance TEXT, name TEXT);
      CREATE TABLE users (id TEXT, display_name TEXT);
      INSERT INTO workgroups VALUES ('mr', 'Private House');
      INSERT INTO agent_groups VALUES ('ag-private123', 'Private Agent', 'private-agent', 'private-house');
      INSERT INTO users VALUES ('u-real-1', 'Private Person');
      INSERT INTO users VALUES ('system:health-sentinel', NULL);
    `);
    db.prepare('INSERT INTO messaging_groups VALUES (?, ?, ?, ?)').run(
      'mg-private123',
      `slack:${platformId}`,
      'slack-private',
      'Private Room',
    );
    db.close();
    const values = loadRegistryIdentifiers(dbPath);
    expect(values.has('Private House')).toBe(true);
    expect(values.has(platformId)).toBe(true);
    expect(values.has('mr')).toBe(true);
    expect(values.has('u-real-1')).toBe(true);
    // system:* senders are script-authored constants living in tracked code —
    // never install-private identifiers (see loadRegistryIdentifiers comment).
    expect(values.has('system:health-sentinel')).toBe(false);
    expect(() => loadRegistryIdentifiers(path.join(root, 'missing.db'))).toThrow('missing');
  });
});

describe('Git surfaces and modes', () => {
  it('scans the staged index rather than divergent worktree content', () => {
    const root = initRepo();
    const file = path.join(root, 'sample.md');
    const privateValue = 'Private Customer';
    fs.writeFileSync(file, `${privateValue}\n`);
    execFileSync('git', ['add', 'sample.md'], { cwd: root });
    fs.writeFileSync(file, 'public replacement\n');
    fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), `${privateValue}\n`);

    const dbPath = path.join(root, 'registry.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workgroups (id TEXT, display_name TEXT);
      CREATE TABLE agent_groups (id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
      CREATE TABLE messaging_groups (id TEXT, platform_id TEXT, instance TEXT, name TEXT);
      INSERT INTO workgroups VALUES ('example-house', 'Example House');
    `);
    db.close();

    const options = resolveOptions(
      ['--root', root, '--index', '--db', 'registry.db', '--identifiers', '.nanoclaw/public-boundary-identifiers'],
      root,
    );
    expect(run(options)).toEqual([{ file: 'sample.md', line: 1, category: 'private-identifier' }]);
    expect(run({ ...options, index: false })).toEqual([]);
  });

  it('treats an unusable install DB as absent and degrades to structural-only instead of hard-failing', () => {
    // A 0-byte data/v2.db stub (e.g. a partially-initialized worktree) used to
    // flip the install-marker check true, then throw out of
    // loadRegistryIdentifiers — exit 2, meaning the pre-commit hook could not
    // run the gate at all. It must now fall through to whatever fallback is
    // available (here: none, since this repo is not a linked worktree) and
    // still complete the scan.
    const root = initRepo();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'v2.db'), '');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = main(['--root', root]);
    expect(code).toBe(0);
    expect(stderr.mock.calls.flat().join('')).toContain('no identifier registry found');
    expect(stdout.mock.calls.flat().join('')).toContain('structural patterns only — no identifier registry found');
  });

  it('resolves identifiers from the main checkout when run inside a linked worktree', () => {
    const mainRoot = initInstallRepo('Acme Registry Corp', 'Acme Local Team');
    const worktreeRoot = addLinkedWorktree(mainRoot);
    fs.writeFileSync(
      path.join(worktreeRoot, 'leak.md'),
      'From the registry: Acme Registry Corp\nFrom the local file: Acme Local Team\n',
    );
    execFileSync('git', ['add', 'leak.md'], { cwd: worktreeRoot });

    const options = resolveOptions(['--root', worktreeRoot], worktreeRoot);
    const report = runReport(options);
    expect(report.mode).toBe('install-aware');
    expect(report.registryOrigin).toBe('main-checkout');
    expect(report.identifiersOrigin).toBe('main-checkout');
    expect(report.findings.map((f) => f.category)).toEqual(['private-identifier', 'private-identifier']);
  });

  it('falls back past a 0-byte install-DB stub left in a worktree to the main checkout', () => {
    const mainRoot = initInstallRepo('Contoso Registry Ltd', 'Contoso Local Ltd');
    const worktreeRoot = addLinkedWorktree(mainRoot);
    fs.mkdirSync(path.join(worktreeRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, 'data', 'v2.db'), '');
    fs.writeFileSync(path.join(worktreeRoot, 'clean.md'), 'nothing private here\n');
    execFileSync('git', ['add', 'clean.md'], { cwd: worktreeRoot });

    const report = runReport(resolveOptions(['--root', worktreeRoot], worktreeRoot));
    expect(report.mode).toBe('install-aware');
    expect(report.registryOrigin).toBe('main-checkout');
    expect(report.findings).toEqual([]);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(main(['--root', worktreeRoot])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain('identifiers from main checkout');
  });

  it('explicit --db/--identifiers win over the main-checkout fallback even inside a worktree', () => {
    const mainRoot = initInstallRepo('Umbrella Registry Inc', 'Umbrella Local Inc');
    const worktreeRoot = addLinkedWorktree(mainRoot);
    const localDb = path.join(worktreeRoot, 'local.db');
    const db = new Database(localDb);
    db.exec('CREATE TABLE workgroups (id TEXT, display_name TEXT);');
    db.prepare('INSERT INTO workgroups (id, display_name) VALUES (?, ?)').run('local-house', 'Locally Scoped House');
    db.close();
    fs.writeFileSync(path.join(worktreeRoot, 'local-ids'), 'Locally Scoped Team\n');
    fs.writeFileSync(
      path.join(worktreeRoot, 'leak.md'),
      'Umbrella Registry Inc appears here but should not be flagged.\n',
    );
    execFileSync('git', ['add', 'leak.md'], { cwd: worktreeRoot });

    const report = runReport(
      resolveOptions(['--root', worktreeRoot, '--db', 'local.db', '--identifiers', 'local-ids'], worktreeRoot),
    );
    expect(report.registryOrigin).toBe('explicit');
    expect(report.identifiersOrigin).toBe('explicit');
    expect(report.findings).toEqual([]);
  });

  it('portable mode works without install state', () => {
    const root = initRepo();
    expect(run(resolveOptions(['--root', root, '--portable'], root))).toEqual([]);
  });
});

describe('commit message scanning (--message)', () => {
  // History travels with the branch, so a message naming an install identifier
  // publishes upstream exactly like source does. pre-commit scans staged files
  // and pre-push scans the index; neither ever saw the message.
  function fixture(messageBody: string): { options: ReturnType<typeof resolveOptions>; msgPath: string } {
    const root = initRepo();
    const privateValue = 'Private Customer';
    fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), `${privateValue}\n`);

    const dbPath = path.join(root, 'registry.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workgroups (id TEXT, display_name TEXT);
      CREATE TABLE agent_groups (id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
      CREATE TABLE messaging_groups (id TEXT, platform_id TEXT, instance TEXT, name TEXT);
      INSERT INTO workgroups VALUES ('example-house', 'Example House');
    `);
    db.close();

    const msgPath = path.join(root, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgPath, messageBody);
    const options = resolveOptions(
      [
        '--root',
        root,
        '--db',
        'registry.db',
        '--identifiers',
        '.nanoclaw/public-boundary-identifiers',
        '--message',
        'COMMIT_EDITMSG',
      ],
      root,
    );
    return { options, msgPath };
  }

  it('rejects an identifier in the message body', () => {
    const { options } = fixture('fix: something\n\nThis names Private Customer in the body.\n');
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 3, category: 'private-identifier' }]);
  });

  it('passes a message with no install identifiers', () => {
    const { options } = fixture('fix: something\n\nNothing private here.\n');
    expect(run(options)).toEqual([]);
  });

  it('ignores `#` comment lines, which git strips before committing', () => {
    // git's default template lists every staged path. For an install whose
    // directories are named after groups that is a guaranteed false positive
    // on text that never ships.
    const { options } = fixture(
      'fix: something\n\n# Changes to be committed:\n#\tmodified: groups/Private Customer/config.json\n',
    );
    expect(run(options)).toEqual([]);
  });

  it('reports the line the author sees, counting blanked comment lines', () => {
    // Comment lines are blanked rather than removed so line numbers still
    // match the file in the editor.
    const { options } = fixture('fix: something\n\n# a comment\nPrivate Customer on line four.\n');
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 4, category: 'private-identifier' }]);
  });

  it('scans ONLY the message, not the tracked tree', () => {
    const { options } = fixture('fix: clean message\n');
    // A tracked file carrying the identifier must not be reported here — this
    // mode answers "is the message clean", and pre-commit already gates files.
    fs.writeFileSync(path.join(options.root, 'leaky.md'), 'Private Customer\n');
    execFileSync('git', ['add', 'leaky.md'], { cwd: options.root });
    expect(run(options)).toEqual([]);
  });

  it('rejects --message with no path rather than silently scanning everything', () => {
    expect(() => resolveOptions(['--message'])).toThrow(/--message requires a path/);
  });
});
