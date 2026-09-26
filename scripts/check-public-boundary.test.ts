import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyBaseline,
  loadInstallIdentifiers,
  loadLocalIdentifiers,
  loadRegistryIdentifiers,
  main,
  parseBaseline,
  publicRemotes,
  remoteOwnerRepo,
  resolveOptions,
  run,
  runReport,
  scanInputs,
  writeBaseline,
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
function addInstallRegistry(root: string, identifier: string): void {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'v2.db'));
  db.exec(`
    CREATE TABLE workgroups (id TEXT, display_name TEXT);
    CREATE TABLE agent_groups (id TEXT, name TEXT, folder TEXT, workgroup_id TEXT);
    CREATE TABLE messaging_groups (id TEXT, platform_id TEXT, instance TEXT, name TEXT);
    CREATE TABLE users (id TEXT, display_name TEXT);
  `);
  db.prepare('INSERT INTO workgroups (id, display_name) VALUES (?, ?)').run('main-house', identifier);
  db.close();
}

function addIdentifierInventory(root: string, identifier: string): void {
  fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nanoclaw', 'public-boundary-identifiers'), `${identifier}\n`);
}

function initInstallRepo(registryIdentifier: string, localIdentifier: string): string {
  const root = initRepo();
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  addInstallRegistry(root, registryIdentifier);
  addIdentifierInventory(root, localIdentifier);
  return root;
}

function addLinkedWorktree(mainRoot: string): string {
  const worktreeRoot = tempRoot();
  execFileSync('git', ['worktree', 'add', '--detach', '-q', worktreeRoot], { cwd: mainRoot });
  return worktreeRoot;
}

function cloneDetached(sourceRoot: string): string {
  const cloneRoot = path.join(tempRoot(), 'clone');
  execFileSync('git', ['clone', '--quiet', sourceRoot, cloneRoot]);
  execFileSync('git', ['checkout', '--detach', '-q'], { cwd: cloneRoot });
  return cloneRoot;
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

  it('permits reviewed allowlist values inside the file itself without hiding unreviewed private entries', () => {
    const publicId = ['1470', '188214710046894'].join('');
    const privateName = 'Private Customer';
    const unreviewedName = 'Unreviewed Internal';
    const allowlist = [
      { path: 'README.md', value: publicId, reason: 'published community identifier' },
      { path: 'NOTICE.md', value: privateName, reason: 'owner-approved publication of an install workgroup name' },
    ];

    // An owner-reviewed entry value may appear in its own serialized form…
    expect(
      scanInputs(
        [input('.public-boundary-allowlist.json', JSON.stringify({ entries: allowlist }, null, 2))],
        new Set([privateName]),
        allowlist,
      ),
    ).toEqual([]);

    // …but any OTHER private identifier inside the file still flags.
    const strayed = JSON.stringify({ entries: allowlist }, null, 2).replace(
      '"entries"',
      `"note": "see ${unreviewedName} policy",\n  "entries"`,
    );
    expect(
      scanInputs([input('.public-boundary-allowlist.json', strayed)], new Set([unreviewedName]), allowlist),
    ).toEqual([{ file: '.public-boundary-allowlist.json', line: 2, category: 'private-identifier' }]);
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

    const options = resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot);
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

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(main(['--root', root, '--index', '--portable'])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain('portable — structural patterns only');
  });

  it.each(['--index', '--staged'])('fails closed for %s when no identifier registry resolves', (surface) => {
    const root = cloneDetached(initInstallRepo('Synthetic Registry', 'Synthetic Local'));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(main(['--root', root, surface])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const output = stderr.mock.calls.flat().join('');
    expect(output).toContain(`registry paths tried: ${path.join(root, 'data', 'v2.db')}`);
    expect(output).toContain(
      `identifier inventory paths tried: ${path.join(root, '.nanoclaw', 'public-boundary-identifiers')}`,
    );
    expect(output).toContain('gating scans require both an install registry and identifier inventory');
  });

  it.each([
    {
      missing: 'install registry',
      addAvailableSource: (root: string) => addIdentifierInventory(root, 'Synthetic Local'),
      expectedPath: (root: string) => path.join(root, 'data', 'v2.db'),
    },
    {
      missing: 'identifier inventory',
      addAvailableSource: (root: string) => addInstallRegistry(root, 'Synthetic Registry'),
      expectedPath: (root: string) => path.join(root, '.nanoclaw', 'public-boundary-identifiers'),
    },
  ])('fails closed when $missing does not resolve', ({ missing, addAvailableSource, expectedPath }) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const surface of ['--index', '--staged']) {
      const root = initRepo();
      addAvailableSource(root);
      stdout.mockClear();
      stderr.mockClear();

      expect(main(['--root', root, surface])).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat().join('')).toContain(`missing ${missing}`);
      expect(stderr.mock.calls.flat().join('')).toContain(expectedPath(root));

      const at = String.fromCharCode(64);
      fs.writeFileSync(path.join(root, 'structural.md'), `person${at}company.dev\n`);
      execFileSync('git', ['add', 'structural.md'], { cwd: root });
      expect(main(['--root', root, surface, '--allow-structural'])).toBe(1);
      expect(stderr.mock.calls.flat().join('')).toContain('structural.md:1 email-address');
    }
  });

  it('allows explicit structural reporting for an indexed surface but still reports structural findings', () => {
    const root = initRepo();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(main(['--root', root, '--index', '--allow-structural'])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain('public boundary check passed');

    const at = String.fromCharCode(64);
    fs.writeFileSync(path.join(root, 'structural.md'), `person${at}company.dev\n`);
    execFileSync('git', ['add', 'structural.md'], { cwd: root });
    expect(main(['--root', root, '--index', '--allow-structural'])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('structural.md:1 email-address');
  });
});

describe('commit message scanning (--message)', () => {
  // History travels with the branch, so a message naming an install identifier
  // publishes upstream exactly like source does. pre-commit scans staged files
  // and pre-push scans the index; neither ever saw the message.
  function fixture(messageBody: string, raw = false): { options: ReturnType<typeof resolveOptions>; msgPath: string } {
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
      -- A group folder is the kind of identifier a branch gets named after,
      -- which is what git's template prints on its "On branch" line.
      INSERT INTO agent_groups VALUES ('ag-1', 'Private Group', 'private-customer', 'example-house');
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
        ...(raw ? ['--message-raw'] : []),
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

  it('ignores `#` comment lines in git`s editor template, which git strips before committing', () => {
    // git's default template lists every staged path. For an install whose
    // directories are named after groups that is a guaranteed false positive
    // on text that never ships. Template text verbatim from git 2.43.0 — the
    // bare `#` lines are what mark the trailing block as git's rather than
    // the author's, so the fixture has to carry them.
    const { options } = fixture(
      'fix: something\n\n' +
        '# Please enter the commit message for your changes. Lines starting\n' +
        "# with '#' will be ignored, and an empty message aborts the commit.\n" +
        '#\n' +
        '# On branch private-customer\n' +
        '# Changes to be committed:\n' +
        '#\tmodified: groups/Private Customer/config.json\n' +
        '#\n',
    );
    expect(run(options)).toEqual([]);
  });

  it('ignores the `--allow-empty` template, which carries no staged-path listing', () => {
    // The mirror-image bug of the `-m` bypass: `git commit --allow-empty` on a
    // clean tree emits a template with NO `#\t` line and no scissors, so a
    // marker set built from those two missed it entirely and scanned
    // `# On branch <branch>`. A branch named after a group folder then blocked
    // the commit — and a blocked gate gets --no-verify'd, which checks nothing.
    const { options } = fixture(
      'chore: empty\n\n' +
        '# Please enter the commit message for your changes. Lines starting\n' +
        "# with '#' will be ignored, and an empty message aborts the commit.\n" +
        '#\n' +
        '# On branch private-customer\n',
    );
    expect(run(options)).toEqual([]);
  });

  it('REJECTS an identifier below a `#\\t` line in a `-m` message', () => {
    // Bypass reproduced 2026-08-26: a single `#\t` line anywhere in the file
    // used to mark the WHOLE message as editor output, so every other `#`
    // line was blanked — including a real identifier further down, which
    // `-m`/`-F` ship verbatim. Only a trailing block bearing git's own bare
    // `#` lines is treated as a template now.
    const { options } = fixture('fix: something\n\n#\tmodified: some/file\n# Private Customer asked for this\n');
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 4, category: 'private-identifier' }]);
  });

  it('REJECTS an identifier below a scissors LOOKALIKE in a `-m` message', () => {
    // Second bypass reproduced the same day: the scissors pattern accepted any
    // dash count, so a hand-typed `# --- >8 ---` truncated the rest of the
    // message out of the scan while `-m` shipped it. Only git's exact line
    // (24 dashes each side) truncates.
    const { options } = fixture('fix: something\n\n# --- >8 ---\nPrivate Customer named below the fake rule.\n');
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 4, category: 'private-identifier' }]);
  });

  it('reports the line the author sees, counting blanked comment lines', () => {
    // Comment lines are blanked rather than removed so line numbers still
    // match the file in the editor.
    const { options } = fixture(
      'fix: something\n\n# a comment\nPrivate Customer on line four.\n#\tmodified: some/file\n',
    );
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 4, category: 'private-identifier' }]);
  });

  it('REJECTS a `#`-prefixed identifier in a `-m` message, which git does NOT strip', () => {
    // `git commit -m` uses cleanup mode `whitespace`, not `default` — comment
    // lines survive verbatim into `git log`. Blanking every `#` line let a real
    // identifier ship while this gate printed "passed"; only the editor path
    // (identified by git's own `#\t` path listing or a scissors rule) gets the
    // blanking treatment now.
    const { options } = fixture('fix: something\n# Private Customer asked for this\n');
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 2, category: 'private-identifier' }]);
  });

  it('ignores the verbose-diff body below the scissors rule, which git discards', () => {
    // `commit -v` appends the staged diff un-prefixed below the scissors.
    // pre-commit already gates that content under its real filenames, and none
    // of it reaches the commit message.
    const { options } = fixture(
      'fix: something\n\n# ------------------------ >8 ------------------------\n' +
        'diff --git a/x b/x\n+Private Customer\n',
    );
    expect(run(options)).toEqual([]);
  });

  it('scans a committed message below exact scissors in raw mode', () => {
    const { options } = fixture(
      'fix: imported\n# ------------------------ >8 ------------------------\nPrivate Customer after scissors\n',
      true,
    );
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 3, category: 'private-identifier' }]);
  });

  it('scans a committed trailing comment block in raw mode', () => {
    const { options } = fixture('fix: imported\n\n# Private Customer in history\n#\n', true);
    expect(run(options)).toEqual([{ file: 'COMMIT_EDITMSG', line: 3, category: 'private-identifier' }]);
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

  it('rejects --message-raw without a message path', () => {
    expect(() => resolveOptions(['--message-raw'])).toThrow(/--message-raw requires --message/);
  });
});

describe('git hooks scan the committing tree, not the main checkout', () => {
  // Every hook resolves tooling from the main checkout (agent worktrees carry
  // no node_modules) and cds there to run this script. That cd also moved the
  // script's DEFAULT root, which is process.cwd() — so a commit or push made
  // from a linked worktree scanned MAIN's index, entirely different content,
  // and printed "passed" about work it never saw. `--root` is the fix, and it
  // is not optional.

  it('the default root follows cwd, so running from the main checkout misses worktree content', () => {
    const mainRoot = initInstallRepo('Northwind Registry AB', 'Northwind Local AB');
    const worktreeRoot = addLinkedWorktree(mainRoot);
    fs.writeFileSync(path.join(worktreeRoot, 'leak.md'), 'Northwind Registry AB\n');
    execFileSync('git', ['add', 'leak.md'], { cwd: worktreeRoot });

    // What the hooks used to do: run from the main checkout with no --root.
    expect(run(resolveOptions(['--index'], mainRoot))).toEqual([]);
    // What they do now.
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], mainRoot))).toEqual([
      { file: 'leak.md', line: 1, category: 'private-identifier' },
    ]);
  });

  // Asserted against the hook text because this suite does not execute Husky.
  it('.husky/pre-commit passes --root for the committing worktree', () => {
    const script = fs.readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8');
    expect(script).toMatch(/rev-parse --show-toplevel/);
    expect(script).toMatch(/check:public-boundary\s+--\s+--root\s+"\$worktree_root"/);
  });

  it('.husky/pre-push passes --root for each pushed snapshot', () => {
    const script = fs.readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');
    expect(script).toMatch(/while read -r local_ref local_sha remote_ref remote_sha/);
    expect(script).toMatch(/worktree add --detach --quiet "\$snapshot_root" "\$1"/);
    expect(script).toMatch(/check:public-boundary\s+--\s+--root\s+"\$snapshot_root" --index/);
  });
});

describe('identifiers derived from the install', () => {
  function writeRegistry(dataDir: string): string {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'v2.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE workgroups (id TEXT, display_name TEXT);
      CREATE TABLE container_configs (agent_group_id TEXT, assistant_name TEXT);
      INSERT INTO workgroups VALUES ('wg-fictional', 'Fictional House');
      INSERT INTO container_configs VALUES ('ag-1', 'Nova');
    `);
    db.close();
    return dbPath;
  }

  function addCanonical(dataDir: string, workgroup: string, name: string, url: string): void {
    const repo = path.join(dataDir, 'repositories', workgroup, name);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: repo });
  }

  it('parses host, owner and repository from https, ssh and scp-style remotes', () => {
    expect(remoteOwnerRepo('https://github.com/acme-co/WIDGET.git')).toEqual({
      host: 'github.com',
      owner: 'acme-co',
      repo: 'WIDGET',
    });
    expect(remoteOwnerRepo('https://x-access-token:secret@Example.com/acme-co/widget/')).toEqual({
      host: 'example.com',
      owner: 'acme-co',
      repo: 'widget',
    });
    expect(remoteOwnerRepo('git@github.com:acme-co/widget.git')).toEqual({
      host: 'github.com',
      owner: 'acme-co',
      repo: 'widget',
    });
    expect(remoteOwnerRepo('ssh://git@ssh.github.com:443/acme-co/widget.git')).toEqual({
      host: 'ssh.github.com',
      owner: 'acme-co',
      repo: 'widget',
    });
    expect(remoteOwnerRepo('github.com:acme-co/widget.git')).toEqual({
      host: 'github.com',
      owner: 'acme-co',
      repo: 'widget',
    });
    expect(remoteOwnerRepo('./mirrors:acme-co/widget.git')).toBeNull();
    expect(remoteOwnerRepo('/srv/mirrors/widget.git')).toBeNull();
    expect(remoteOwnerRepo('file:///srv/acme-co/widget.git')).toBeNull();
    expect(remoteOwnerRepo('https://github.com/solo')).toBeNull();
  });

  it('reads persona names from the container_configs projection', () => {
    const dbPath = writeRegistry(path.join(tempRoot(), 'data'));
    expect(loadRegistryIdentifiers(dbPath).has('Nova')).toBe(true);
  });

  const publicProject = { owners: new Set(['open-org']), repositories: new Set(['github.com/open-org/project']) };

  it('derives persona names and client repositories, skipping public remotes and generic names', () => {
    const installRoot = tempRoot();
    const dataDir = path.join(installRoot, 'data');
    const dbPath = writeRegistry(dataDir);
    fs.mkdirSync(path.join(installRoot, 'groups', 'nova-agent'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'groups', 'nova-agent', 'container.json'), '{"assistantName":"Orion"}');
    fs.mkdirSync(path.join(installRoot, 'groups', 'no-config'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'groups', 'README.md'), 'not a group\n');
    addCanonical(dataDir, 'wg-fictional', 'WIDGET', 'https://github.com/acme-co/WIDGET.git');
    addCanonical(dataDir, 'wg-fictional', 'dbt', 'git@github.com:acme-co/dbt.git');
    addCanonical(dataDir, 'wg-fictional', 'project', 'https://github.com/open-org/project');
    fs.mkdirSync(path.join(dataDir, 'repositories', 'wg-fictional', 'not-a-clone'), { recursive: true });

    const problems: string[] = [];
    const values = loadInstallIdentifiers(dbPath, publicProject, problems);
    expect(values).toEqual(new Set(['Orion', 'acme-co', 'WIDGET']));
    expect(problems).toEqual([]);
  });

  it('exempts only the exact public repository, not every repository its owner holds', () => {
    const dataDir = path.join(tempRoot(), 'data');
    const dbPath = writeRegistry(dataDir);
    addCanonical(dataDir, 'wg-fictional', 'project', 'https://github.com/open-org/project.git');
    addCanonical(dataDir, 'wg-fictional', 'launch', 'https://github.com/open-org/SecretLaunch.git');
    addCanonical(dataDir, 'wg-fictional', 'mirror', 'https://git.example.com/open-org/project.git');
    const values = loadInstallIdentifiers(dbPath, publicProject, []);
    expect(values).toEqual(new Set(['SecretLaunch', 'project']));
  });

  it('records an unreadable or malformed source instead of silently dropping its names', () => {
    const installRoot = tempRoot();
    const dataDir = path.join(installRoot, 'data');
    const dbPath = writeRegistry(dataDir);
    fs.mkdirSync(path.join(installRoot, 'groups', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'groups', 'broken', 'container.json'), '{not json');
    fs.mkdirSync(path.join(installRoot, 'groups', 'locked'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'groups', 'locked', 'container.json'), '{"assistantName":"Vega"}');
    fs.chmodSync(path.join(installRoot, 'groups', 'locked', 'container.json'), 0o000);
    addCanonical(dataDir, 'wg-fictional', 'WIDGET', 'https://github.com/acme-co/WIDGET.git');
    fs.appendFileSync(path.join(dataDir, 'repositories', 'wg-fictional', 'WIDGET', '.git', 'config'), '[broken\n');

    const problems: string[] = [];
    const values = loadInstallIdentifiers(dbPath, publicProject, problems);
    expect(values).toEqual(new Set());
    expect(problems.sort()).toEqual([
      'a cloned repository configuration could not be read',
      'a group container.json could not be read or parsed',
      'a group container.json could not be read or parsed',
    ]);
  });

  it('fails an indexed scan closed when an install identifier source is unreadable', () => {
    const root = initInstallRepo('Fictional Registry House', 'Fictional Local Team');
    fs.mkdirSync(path.join(root, 'groups', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', 'broken', 'container.json'), '{not json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(runReport(resolveOptions(['--root', root, '--index'], root)).discoveryProblems).toEqual([
      'a group container.json could not be read or parsed',
    ]);
    expect(main(['--root', root, '--index'])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('require every install identifier source to be readable');
    const message = path.join(root, 'TAG_MSG');
    fs.writeFileSync(message, 'release notes\n');
    expect(main(['--root', root, '--message', message, '--message-raw'])).toBe(1);
    expect(main(['--root', root])).toBe(0);
  });

  it('records a clone whose directory cannot be traversed', () => {
    const dataDir = path.join(tempRoot(), 'data');
    const dbPath = writeRegistry(dataDir);
    addCanonical(dataDir, 'wg-fictional', 'WIDGET', 'https://github.com/acme-co/WIDGET.git');
    const gitDir = path.join(dataDir, 'repositories', 'wg-fictional', 'WIDGET', '.git');
    fs.chmodSync(gitDir, 0o000);
    const problems: string[] = [];
    try {
      expect(loadInstallIdentifiers(dbPath, publicProject, problems)).toEqual(new Set());
    } finally {
      fs.chmodSync(gitDir, 0o755);
    }
    expect(problems).toEqual(['a cloned repository configuration could not be read']);
  });

  it('refuses to write a baseline from incomplete discovery, leaving the file unchanged', () => {
    const root = initInstallRepo('Fictional Registry House', 'Fictional Local Team');
    const baselineFile = path.join(root, '.public-boundary-baseline.json');
    fs.writeFileSync(baselineFile, '{"files":{"old.md":2}}\n');
    fs.mkdirSync(path.join(root, 'groups', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', 'broken', 'container.json'), '{not json');
    for (const extra of [[], ['--accept-growth']]) {
      expect(() => writeBaseline(resolveOptions(['--root', root, '--write-baseline', ...extra], root))).toThrow(
        'requires every install identifier source',
      );
    }
    expect(fs.readFileSync(baselineFile, 'utf8')).toBe('{"files":{"old.md":2}}\n');
  });

  it('treats the remotes of the scanned and install checkouts as public', () => {
    const root = initRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Open-Org/project.git'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'upstream', 'git@github.com:parent-org/project.git'], { cwd: root });
    expect(publicRemotes([root, path.join(root, 'missing'), path.parse(root).root])).toEqual({
      owners: new Set(['open-org', 'parent-org']),
      repositories: new Set(['github.com/open-org/project', 'github.com/parent-org/project']),
    });
  });

  it('keeps an explicit registry outside a data directory usable, with no checkout inferred from it', () => {
    const root = initRepo();
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
    const registryDir = tempRoot();
    const dbPath = writeRegistry(path.join(registryDir, 'elsewhere'));
    addCanonical(
      path.join(registryDir, 'elsewhere'),
      'wg-fictional',
      'WIDGET',
      'https://github.com/acme-co/WIDGET.git',
    );
    const inventory = path.join(registryDir, 'identifiers');
    fs.writeFileSync(inventory, 'Fictional Local Team\n');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = ['--root', root, '--index', '--db', dbPath, '--identifiers', inventory];
    expect(runReport(resolveOptions(args, root)).discoveryProblems).toEqual([]);
    expect(main(args)).toBe(0);
    expect(loadInstallIdentifiers(dbPath, publicProject, [])).toEqual(new Set());
  });

  it('fails a message scan closed when an identifier source does not resolve', () => {
    const root = initRepo();
    const message = path.join(root, 'TAG_MSG');
    fs.writeFileSync(message, 'release notes\n');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(main(['--root', root, '--message', message, '--message-raw'])).toBe(1);
    expect(main(['--root', root, '--message', message, '--allow-structural'])).toBe(0);
    addInstallRegistry(root, 'Fictional Registry House');
    expect(main(['--root', root, '--message', message, '--message-raw'])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain('missing identifier inventory');
    addIdentifierInventory(root, 'Fictional Local Team');
    expect(main(['--root', root, '--message', message, '--message-raw'])).toBe(0);
  });

  it('adds derived names to an install-aware run', () => {
    const root = initInstallRepo('Fictional Registry House', 'Fictional Local Team');
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/open-org/project.git'], { cwd: root });
    addCanonical(path.join(root, 'data'), 'main-house', 'WIDGET', 'https://github.com/acme-co/WIDGET.git');
    addCanonical(path.join(root, 'data'), 'main-house', 'project', 'https://github.com/open-org/project.git');
    fs.writeFileSync(path.join(root, 'notes.md'), 'The widget release.\nClone open-org/project.\n');
    execFileSync('git', ['add', 'notes.md'], { cwd: root });
    expect(run(resolveOptions(['--root', root, '--index'], root))).toEqual([
      { file: 'notes.md', line: 1, category: 'private-identifier' },
    ]);
  });

  it('matches an all-caps three-letter name as a bare word, but keeps acronyms and lowercase names contextual', () => {
    const text = ['The WDG screen', 'export wdg_dev=1', 'wdgx is unrelated', 'The API screen', 'the abc screen'];
    const findings = scanInputs([input('a.md', text.join('\n'))], new Set(['WDG', 'API', 'abc']), []);
    expect(findings).toEqual([
      { file: 'a.md', line: 1, category: 'private-identifier' },
      { file: 'a.md', line: 2, category: 'private-identifier' },
    ]);
  });

  it('reports every matching line, so a second occurrence counts', () => {
    const findings = scanInputs(
      [input('a.md', 'Fictional House\nplain\nfictional-house again\n')],
      new Set(['Fictional House']),
      [],
    );
    expect(findings.map((finding) => finding.line)).toEqual([1, 3]);
  });
});

describe('baseline ratchet', () => {
  const finding = (file: string, line: number): { file: string; line: number; category: 'private-identifier' } => ({
    file,
    line,
    category: 'private-identifier',
  });

  it('holds a file within its count, fails a new file and a risen count, and notes a drop', () => {
    const baseline = { files: { 'held.md': 2, 'dropped.md': 3, 'rose.md': 1, 'gone.md': 4 } };
    const email = { file: 'held.md', line: 9, category: 'email-address' as const };
    const { findings, outcome } = applyBaseline(
      [
        finding('held.md', 1),
        finding('held.md', 2),
        email,
        finding('dropped.md', 1),
        finding('rose.md', 1),
        finding('rose.md', 2),
        finding('new.md', 5),
      ],
      baseline,
    );
    expect(findings).toEqual([email, finding('rose.md', 1), finding('rose.md', 2), finding('new.md', 5)]);
    expect(outcome.held).toBe(3);
    expect(outcome.heldFiles).toBe(2);
    expect(outcome.exceeded).toEqual([
      { file: 'new.md', count: 1, recorded: 0 },
      { file: 'rose.md', count: 2, recorded: 1 },
    ]);
    expect(outcome.below).toEqual(['dropped.md', 'gone.md']);
  });

  it('does not treat inherited object keys as baseline entries', () => {
    const { findings } = applyBaseline([finding('constructor', 1)], { files: {} });
    expect(findings).toHaveLength(1);
  });

  it('rejects a malformed baseline', () => {
    expect(() => parseBaseline('{')).toThrow('invalid JSON');
    expect(() => parseBaseline('[]')).toThrow('invalid schema');
    expect(() => parseBaseline('{"files":{"a.md":0}}')).toThrow('invalid schema');
    expect(() => parseBaseline('{"files":{"a.md":1.5}}')).toThrow('invalid schema');
    expect(() => parseBaseline('{"files":{"a.md":1},"note":"x"}')).toThrow('invalid schema');
    expect(parseBaseline('{"files":{"a.md":2}}')).toEqual({ files: { 'a.md': 2 } });
  });

  function baselineRepo(): string {
    const root = initInstallRepo('Fictional Registry House', 'Fictional Local Team');
    fs.writeFileSync(path.join(root, 'old.md'), 'Fictional Registry House\nFictional Local Team\n');
    fs.writeFileSync(path.join(root, '.public-boundary-baseline.json'), '{"files":{"old.md":2}}\n');
    execFileSync('git', ['add', 'old.md', '.public-boundary-baseline.json'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: root });
    return root;
  }

  it('passes a baselined tree and fails a new file or a risen count', () => {
    const root = baselineRepo();
    const report = runReport(resolveOptions(['--root', root, '--index'], root));
    expect(report.findings).toEqual([]);
    expect(report.baseline.held).toBe(2);

    fs.appendFileSync(path.join(root, 'old.md'), 'fictional registry house again\n');
    fs.writeFileSync(path.join(root, 'fresh.md'), 'Fictional Local Team\n');
    execFileSync('git', ['add', 'old.md', 'fresh.md'], { cwd: root });
    expect(run(resolveOptions(['--root', root, '--index'], root))).toEqual([
      { file: 'fresh.md', line: 1, category: 'private-identifier' },
      { file: 'old.md', line: 1, category: 'private-identifier' },
      { file: 'old.md', line: 2, category: 'private-identifier' },
      { file: 'old.md', line: 3, category: 'private-identifier' },
    ]);
  });

  it('reads the index copy for an index scan, so an unstaged baseline edit holds nothing', () => {
    const root = baselineRepo();
    fs.appendFileSync(path.join(root, 'old.md'), 'Fictional Local Team\n');
    execFileSync('git', ['add', 'old.md'], { cwd: root });
    fs.writeFileSync(path.join(root, '.public-boundary-baseline.json'), '{"files":{"old.md":3}}\n');
    expect(run(resolveOptions(['--root', root, '--index'], root))).toHaveLength(3);
    expect(run(resolveOptions(['--root', root], root))).toEqual([]);
  });

  function predatingWorktree(mainRoot: string): string {
    const worktreeRoot = tempRoot();
    execFileSync('git', ['worktree', 'add', '--detach', '-q', worktreeRoot, 'HEAD~1'], { cwd: mainRoot });
    fs.writeFileSync(path.join(worktreeRoot, 'old.md'), 'Fictional Registry House\n');
    execFileSync('git', ['add', 'old.md'], { cwd: worktreeRoot });
    return worktreeRoot;
  }

  it('gives a branch that predates the file the baseline merged on origin', () => {
    const mainRoot = baselineRepo();
    const worktreeRoot = predatingWorktree(mainRoot);
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot))).toHaveLength(1);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: mainRoot });
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot))).toEqual([]);
  });

  it('looks past an origin/HEAD that lacks the baseline to origin/main', () => {
    const mainRoot = baselineRepo();
    const worktreeRoot = predatingWorktree(mainRoot);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/stale', 'HEAD~1'], { cwd: mainRoot });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/stale'], { cwd: mainRoot });
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot))).toHaveLength(1);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: mainRoot });
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot))).toEqual([]);
  });

  it('never takes a predating branch baseline from a working copy or an unmerged commit', () => {
    const mainRoot = baselineRepo();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], { cwd: mainRoot });
    const worktreeRoot = predatingWorktree(mainRoot);
    fs.writeFileSync(path.join(mainRoot, '.public-boundary-baseline.json'), '{"files":{"old.md":9}}\n');
    expect(run(resolveOptions(['--root', worktreeRoot, '--index'], worktreeRoot))).toHaveLength(1);
  });

  it('holds nothing once a branch deletes the baseline it carried, staged or committed', () => {
    const root = baselineRepo();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root });
    execFileSync('git', ['rm', '-q', '--cached', '.public-boundary-baseline.json'], { cwd: root });
    expect(run(resolveOptions(['--root', root, '--index'], root))).toHaveLength(2);
    execFileSync('git', ['commit', '-q', '-m', 'drop baseline'], { cwd: root });
    fs.rmSync(path.join(root, '.public-boundary-baseline.json'));
    expect(run(resolveOptions(['--root', root, '--index'], root))).toHaveLength(2);
    expect(run(resolveOptions(['--root', root], root))).toHaveLength(2);
  });

  it('fails rather than reading a baseline it cannot load as absent', () => {
    const root = baselineRepo();
    const objectId = execFileSync('git', ['rev-parse', ':.public-boundary-baseline.json'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    fs.rmSync(path.join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2)), { force: true });
    expect(() => run(resolveOptions(['--root', root, '--index'], root))).toThrow('baseline object could not be read');
  });

  it('requires an explicit --baseline to exist', () => {
    const root = baselineRepo();
    expect(() => run(resolveOptions(['--root', root, '--baseline', 'missing.json'], root))).toThrow(
      'missing or unreadable',
    );
    expect(run(resolveOptions(['--root', root, '--baseline', '.public-boundary-baseline.json'], root))).toEqual([]);
  });

  it('never applies the baseline to a commit message', () => {
    const root = baselineRepo();
    const message = path.join(root, 'MSG');
    fs.writeFileSync(message, 'Fictional Local Team\n');
    const report = runReport(resolveOptions(['--root', root, '--message', message], root));
    expect(report.findings).toHaveLength(1);
    expect(report.baseline.held).toBe(0);
  });

  it('ratchets down on write, refuses growth, and absorbs it only with --accept-growth', () => {
    const root = baselineRepo();
    const baselineFile = path.join(root, '.public-boundary-baseline.json');
    fs.writeFileSync(path.join(root, 'old.md'), 'Fictional Registry House\n');
    fs.writeFileSync(path.join(root, 'fresh.md'), 'Fictional Local Team\n');
    execFileSync('git', ['add', 'fresh.md'], { cwd: root });

    expect(writeBaseline(resolveOptions(['--root', root, '--write-baseline'], root)).refused).toEqual(['fresh.md']);
    expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))).toEqual({ files: { 'old.md': 1 } });

    expect(
      writeBaseline(resolveOptions(['--root', root, '--write-baseline', '--accept-growth'], root)).refused,
    ).toEqual([]);
    expect(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))).toEqual({ files: { 'fresh.md': 1, 'old.md': 1 } });
  });

  it('refuses to write a baseline without install identifiers', () => {
    const root = initRepo();
    expect(() => writeBaseline(resolveOptions(['--root', root, '--write-baseline'], root))).toThrow('requires both');
  });

  it('validates the baseline flags', () => {
    expect(() => resolveOptions(['--baseline'])).toThrow('--baseline requires a path');
    expect(() => resolveOptions(['--accept-growth'])).toThrow('requires --write-baseline');
    expect(() => resolveOptions(['--write-baseline', '--portable'])).toThrow('--write-baseline scans');
  });

  it('prints held, dropped and exceeded counts without values', () => {
    const root = baselineRepo();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(main(['--root', root, '--index'])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain(
      '2 pre-existing line(s) in 1 file(s) held by .public-boundary-baseline.json',
    );

    fs.writeFileSync(
      path.join(root, 'old.md'),
      'Fictional Registry House\nFictional Local Team\nFictional Local Team\n',
    );
    execFileSync('git', ['add', 'old.md'], { cwd: root });
    expect(main(['--root', root, '--index'])).toBe(1);
    expect(stderr.mock.calls.flat().join('')).toContain(
      'old.md: 3 private-identifier line(s), above its baseline of 2',
    );

    fs.writeFileSync(path.join(root, 'old.md'), 'clean\n');
    execFileSync('git', ['add', 'old.md'], { cwd: root });
    expect(main(['--root', root, '--index'])).toBe(0);
    expect(stdout.mock.calls.flat().join('')).toContain('1 file(s) are below their baseline count');

    expect(main(['--root', root, '--write-baseline'])).toBe(0);
    fs.writeFileSync(path.join(root, 'old.md'), 'Fictional Local Team\n');
    expect(main(['--root', root, '--write-baseline'])).toBe(1);
    const output = stdout.mock.calls.flat().join('') + stderr.mock.calls.flat().join('');
    expect(output).toContain('refused growth in 1 file(s)');
    expect(output).not.toMatch(/Fictional/);
  });
});
