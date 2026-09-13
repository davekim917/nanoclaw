import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('provider-surfaces-test') }));
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
  GROUPS_DIR: `${TEST_ROOT}/groups`,
  MOUNT_ALLOWLIST_PATH: `${TEST_ROOT}/mount-allowlist.json`,
  WORKGROUP_SHARED_FS: false,
}));

vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  isSurvivableIoError: vi.fn(() => false),
}));

vi.mock('./db/messaging-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/messaging-groups.js')>();
  return {
    ...actual,
    getMessagingGroup: (id: string) =>
      id === 'mg-shared'
        ? { id, channel_type: 'slack-test', platform_id: 'slack:C1', thread_policy: 'native' }
        : actual.getMessagingGroup(id),
  };
});

import { buildMounts } from './container-runner.js';
import { log } from './log.js';
import { getAgentMailbox } from './mailbox/index.js';
import { sessionContextPath, sessionDir, writeSessionContext } from './session-manager.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { buildContainerCodexConfig } from './providers/codex.js';
import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import { STANDING_INSTRUCTIONS_FILE, readGroupPersona } from './group-persona.js';
import {
  getProviderContainerConfig,
  registerProviderContainerConfig,
  type ProviderContainerContribution,
} from './providers/provider-container-registry.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

// A provider that declares (at registration) that it owns its agent surfaces.
// Registered once — the registry is module-global and rejects duplicates.
registerProviderContainerConfig('surfaces-test-provider', () => ({}), { providesAgentSurfaces: true });

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

// Provisioned, not just shaped. `buildMounts` migrates inbound.db under
// `<session>/.host/` and REFUSES to spawn a session that is not host-owned
// (#749, `assertHostOwnedInboundDb`), which is what production guarantees:
// every real session has a mailbox before it is ever handed to a container.
// A fixture that skipped provisioning was asserting mount behaviour for a
// session that could not exist, so the mailbox goes here rather than at each
// of the ~26 buildMounts call sites.
function session(id: string, agentGroupId: string): Session {
  getAgentMailbox().prepare({ agentGroupId, sessionId: id });
  return { id, agent_group_id: agentGroupId } as Session;
}

// Production sets workgroup_id via reconcileWorkgroupAtSpawn before buildMounts
// runs; buildMounts fail-closes (W3) on a NULL workgroup_id. Give the test group
// a workgroup-of-1 (folder as its own workgroup) so the archive projection resolves.
function withWorkgroup(ag: AgentGroup): void {
  const db = getRawDb();
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, '[]', ?, datetime('now'))`,
  ).run(ag.folder, ag.folder, ag.id);
  db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(ag.folder, ag.id);
}

function assignWorkgroup(ag: AgentGroup, workgroupId: string): void {
  const db = getRawDb();
  db.prepare(
    `INSERT OR IGNORE INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
     VALUES (?, ?, '[]', ?, datetime('now'))`,
  ).run(workgroupId, workgroupId, ag.id);
  db.prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, ag.id);
}

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

function writeWorkgroupReadAccessPolicy(
  recipients: Record<string, { mode: 'all' | 'archives'; sources: '*' | string[] }>,
): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'workgroup-read-access.json'), JSON.stringify({ version: 1, recipients }));
  fs.writeFileSync(
    path.join(TEST_ROOT, 'mount-allowlist.json'),
    JSON.stringify({ allowedRoots: [{ path: DATA_DIR, allowReadWrite: false }], blockedPatterns: [] }),
  );
}

async function providerContribution(
  provider: string,
  ag: AgentGroup,
  sess: Session,
): Promise<ProviderContainerContribution> {
  const factory = getProviderContainerConfig(provider);
  return (
    (await factory?.({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, sess.id),
      agentGroupId: ag.id,
      agentGroupFolder: ag.folder,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: [],
      hostEnv: { HOME: path.join(TEST_ROOT, 'home') },
    })) ?? {}
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('host-enrolled wiki maintenance mounts', () => {
  it('ordinary mounts survive malformed publication policy, but a listed actor missing its marker cannot spawn', async () => {
    const ag = group('ordinary-wiki-neighbor', 'ordinary-wiki-neighbor');
    await createAgentGroup(ag);
    assignWorkgroup(ag, 'example');
    await ensureContainerConfig(ag.id);
    const policyDir = path.join(GROUPS_DIR, '_ops', 'wiki');
    fs.mkdirSync(policyDir, { recursive: true });
    const identity = path.join(policyDir, 'actors.json');
    fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: ['writer', 'verifier'] }));
    fs.writeFileSync(path.join(policyDir, 'admission.json'), '{malformed');
    const mounts = await buildMounts(
      ag,
      session('ordinary-policy-test', ag.id),
      containerConfig(),
      'claude',
      {},
      'example',
    );
    expect(mounts.some((mount) => mount.containerPath === '/workspace/agent')).toBe(true);
    fs.writeFileSync(identity, JSON.stringify({ version: 1, actorGroupIds: [ag.id, 'verifier'] }));
    await expect(
      buildMounts(ag, session('listed-policy-test', ag.id), containerConfig(), 'claude', {}, 'example'),
    ).rejects.toThrow('marker');
  });
  it('uses private runtime surfaces and omits repository, shared-memory and application mounts', async () => {
    const ag = group('wiki-writer', 'wiki-writer');
    await createAgentGroup(ag);
    assignWorkgroup(ag, 'example');
    const policyDir = path.join(GROUPS_DIR, '_ops', 'wiki');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      path.join(policyDir, 'actors.json'),
      JSON.stringify({ version: 1, actorGroupIds: [ag.id, 'wiki-verifier'] }),
    );
    fs.writeFileSync(
      path.join(policyDir, 'admission.json'),
      JSON.stringify({
        version: 1,
        workgroupId: 'example',
        repository: 'wiki',
        defaultRef: 'refs/heads/main',
        writerGroupId: ag.id,
        verifierGroupId: 'wiki-verifier',
        seriesId: 'synth-example',
        sourcePrefixes: ['https://primary.example/'],
        notification: { channelType: 'test', instance: 'test', platformId: 'example', threadId: null },
      }),
    );
    const sess = session('wiki-maintenance-session', ag.id);
    const cfg = { ...containerConfig(), wikiMaintenance: true, provider: 'claude' };
    const mounts = await buildMounts(ag, sess, cfg, 'claude', {}, 'example');
    expect(mounts.some((m) => m.containerPath === '/workspace/archive.db' && m.readonly)).toBe(true);
    expect(mounts.some((m) => m.containerPath === '/app/src' && m.readonly)).toBe(true);
    expect(mounts.filter((m) => !m.readonly).map((m) => m.containerPath)).toEqual([
      '/workspace',
      '/workspace/agent',
      '/home/node/.claude',
    ]);
    expect(mounts.filter((m) => !m.readonly).every((m) => !m.hostPath.startsWith(GROUPS_DIR))).toBe(true);
    expect(mounts.some((m) => /worktrees|workgroup|gh-token|plugins|\.aws|\.wix/.test(m.containerPath))).toBe(false);
    await expect(
      buildMounts(ag, sess, { ...cfg, githubTokenEnv: 'FAKE_TOKEN' }, 'claude', {}, 'example'),
    ).rejects.toThrow('extra runtime');
    getRawDb()
      .prepare('UPDATE workgroups SET onecli_secrets = ? WHERE id = ?')
      .run('["unexpected-secret-name"]', 'example');
    const withWorkgroupSecrets = await buildMounts(ag, sess, cfg, 'claude', {}, 'example');
    // A wiki actor takes the isolated runtime path, whose environment is
    // assembled only from model authentication (container-runner.ts:6019-6065).
    // A target workgroup's ordinary OneCLI roster must not make the actor
    // unusable or add a mount to that isolated surface.
    expect(withWorkgroupSecrets.map((m) => m.containerPath)).toEqual(mounts.map((m) => m.containerPath));
  });
});

describe('container instruction contracts', async () => {
  it('routes Claude and OpenCode through the current seven-skill workflow', async () => {
    const retiredRoutes = ['/team-brief', '/team-design', '/team-qa'];
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');
    expect(instructions).toContain('start with `/team-plan`');
    expect(instructions).toContain('/team-build');
    expect(instructions).toContain('/team-review --implementation');
    expect(instructions).toContain('/team-auto');
    expect(instructions).toContain('/team-ship');
    for (const retired of retiredRoutes) expect(instructions).not.toContain(retired);
  });

  it('keeps nested-container Codex delegation on the supported foreground transport', async () => {
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');
    expect(instructions).toContain('codex exec --yolo');
    expect(instructions).toContain('`timeout` to `3600000`');
    expect(instructions).not.toContain('`timeout` to `600000`');
    expect(instructions).not.toContain('team-qa/team-review');
  });

  // Acceptance criterion 5 (instruction-stack-prune plan): each safety floor
  // must survive the L1 rewrite with an assertable marker phrase. A floor
  // dropped or reworded to the point the marker disappears fails this test
  // BEFORE it can reach a live container — see docs/specs/instruction-stack-prune/plan.md.
  it('keeps a marker phrase for every safety floor after the L1 rewrite', async () => {
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');

    // No credential-security assertion: the operator removed that section —
    // never-soliciting-credentials is model table stakes, and vault mechanics
    // live in the onecli-gateway skill.
    // Idle-reap window (task/chat/ceiling tiers).
    expect(instructions).toContain('reaped once it goes quiet');
    // Shared memory limit + its OOM-symptom warning (SIGKILL, not a clean failure).
    expect(instructions).toContain('one memory limit');
    expect(instructions).toContain('SIGKILLs individual child processes');
    // /tmp death on container kill.
    expect(instructions).toContain('`/tmp` plus every in-container background task, sleep, and timer dies with it');
    // Group-precedence rule.
    expect(instructions).toContain("your group's instructions win");
    // Grounding core (rewritten judgment-shaped per operator).
    expect(instructions).toContain('Training data is how you think, not evidence');
    // Test-is-the-contract guard: an existing test asserting the opposite
    // behavior IS the current contract, and a review comment alone never
    // overrides it without an explicit contract change from the user.
    expect(instructions).toContain('IS the current contract');
  });

  it('bans ISO dates and issue/PR references in the base file', async () => {
    const instructions = fs.readFileSync(path.join(process.cwd(), 'container/CLAUDE.md'), 'utf-8');
    expect(instructions).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    // Matches a bare `#123` and a parenthesized `(#123)`.
    expect(instructions).not.toMatch(/(?:^|[\s(])#\d{2,}\b/);
  });

  // ── Hand-synced host/container constants ──
  // The container tree is a separate Bun package (vitest excludes it, and an
  // import risks pulling in bun:sqlite), so the container side is read as TEXT.
  const CODEX_COMPANION_SETUP = 'container/agent-runner/src/codex-companion-setup.ts';
  const CONTAINER_RUNNER = 'src/container-runner.ts';

  const readRepoFile = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

  const PARALLEL_IMPL_NOTE =
    'These are a DELIBERATE parallel implementation: the host is Node/ESM and the container is Bun, ' +
    'and they share no modules by design. Extraction is not an option — update BOTH files together.';

  it('keeps the container Codex base config identical on both sides of the host/container boundary', async () => {
    // Evaluate the container's array literal instead of substring-matching the
    // source: the `[projects."…"]` lines are built by a flatMap over template
    // literals, so they never appear verbatim in the file text.
    const src = readRepoFile(CODEX_COMPANION_SETUP);
    const literal = src.match(/const CONTAINER_CODEX_CONFIG_BASE = (\[[\s\S]*?\n\]\.join\('\\n'\));/);
    expect(
      literal,
      `Could not find the CONTAINER_CODEX_CONFIG_BASE array literal in ${CODEX_COMPANION_SETUP}. ` +
        `If it was reshaped, update this test to match — it is the only thing keeping it in sync with ` +
        `buildContainerCodexConfig() in src/providers/codex.ts. ${PARALLEL_IMPL_NOTE}`,
    ).not.toBeNull();
    const containerBase = new Function(`return ${literal![1]}`)() as string;

    // Comments differ by design (each names its own generating file); every
    // other line must match exactly, in order, in both directions.
    const settings = (toml: string) =>
      toml
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    expect(
      settings(containerBase),
      `Codex container config DRIFT between src/providers/codex.ts (buildContainerCodexConfig) and ` +
        `${CODEX_COMPANION_SETUP} (CONTAINER_CODEX_CONFIG_BASE). ${PARALLEL_IMPL_NOTE} ` +
        `Every non-comment line — sandbox_mode, approval_policy, approvals_reviewer, [features], ` +
        `[features.multi_agent_v2], and the [projects."…"] trusted roots — must be byte-identical.`,
    ).toEqual(settings(buildContainerCodexConfig()));
  });

  it('keeps IN_TREE_SHADOWED_PLUGINS identical on both sides of the host/container boundary', async () => {
    // The host copy is a function-local const in buildMounts, so both sides are
    // read as text.
    const shadowed = (rel: string) => {
      const m = readRepoFile(rel).match(/IN_TREE_SHADOWED_PLUGINS = (?:new Set\()?\[([^\]]*)\]/);
      expect(
        m,
        `Could not find IN_TREE_SHADOWED_PLUGINS in ${rel}. If it was reshaped, update this test — ` +
          `it is the only thing keeping the host and container copies in sync. ${PARALLEL_IMPL_NOTE}`,
      ).not.toBeNull();
      return [...m![1].matchAll(/'([^']*)'/g)].map((q) => q[1]);
    };

    expect(
      shadowed(CODEX_COMPANION_SETUP),
      `IN_TREE_SHADOWED_PLUGINS DRIFT between ${CONTAINER_RUNNER} (host mount exclusion) and ` +
        `${CODEX_COMPANION_SETUP} (container plugin registration). ${PARALLEL_IMPL_NOTE} ` +
        `A plugin dropped from one side either gets double-delivered or silently un-shadowed.`,
    ).toEqual(shadowed(CONTAINER_RUNNER));
  });
});

describe('initGroupFilesystem agent surfaces', async () => {
  it('preserves local instructions and stages default Claude support files', async () => {
    const ag = group('ag-default', 'default-group');
    await createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    expect(fs.readFileSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE), 'utf-8')).toBe('hello\n');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('');
    // Host-owned placeholder for the nested spawn-template.md mount — without
    // it Docker creates the destination in this folder root-owned.
    expect(fs.readFileSync(path.join(groupDir, 'spawn-template.md'), 'utf-8')).toBe('');
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')) as {
      autoMemoryEnabled?: boolean;
      env: Record<string, string>;
      hooks: Record<string, unknown>;
    };
    expect(settings.env.BASH_MAX_TIMEOUT_MS).toBe('3600000');
    expect(settings.env).not.toHaveProperty('BASH_DEFAULT_TIMEOUT_MS');
    expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(true);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.PreToolUse).toBeUndefined();

    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    const mounts = await buildMounts(ag, session('s-default-instructions', ag.id), containerConfig(), 'claude', {});
    // Inlined, not `@`-imported: Claude Code drops imports that resolve
    // outside the project directory (issue #233).
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toContain('hello');
    // No fragment/symlink delivery mechanism left to mount: the composer
    // writes the composed doc directly, and .claude-fragments/.claude-shared.md
    // are gone (superseded by full inlining — issue #233 follow-up).
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);
    expect(mounts.some((m) => m.containerPath === '/workspace/agent/.claude-fragments')).toBe(false);
    expect(mounts.some((m) => m.containerPath === '/app/CLAUDE.md')).toBe(false);
  });

  it('reconciles the managed Bash maximum while preserving an operator-owned default', async () => {
    const ag = group('ag-bash-timeout', 'bash-timeout-group');
    await createAgentGroup(ag);
    initGroupFilesystem(ag, {});

    const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { env: Record<string, string> };
    settings.env.BASH_MAX_TIMEOUT_MS = '600000';
    settings.env.BASH_DEFAULT_TIMEOUT_MS = '45000';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

    initGroupFilesystem(ag, {});

    const reconciled = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as { env: Record<string, string> };
    expect(reconciled.env.BASH_MAX_TIMEOUT_MS).toBe('3600000');
    expect(reconciled.env.BASH_DEFAULT_TIMEOUT_MS).toBe('45000');
  });

  it('stages instructions outside memory for a provider with its own surfaces and is idempotent', async () => {
    const ag = group('ag-surfy', 'surfy-group');
    await createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });
    initGroupFilesystem(ag, { instructions: 'replacement', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    const canonicalMemory = path.join(DATA_DIR, 'workgroups', ag.folder, 'memory');
    const compatibilityLink = path.join(groupDir, 'memory');
    expect(fs.existsSync(groupDir)).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    // The spawn-template mount isn't gated on defaultSurfaces, so its
    // placeholder isn't either.
    expect(fs.existsSync(path.join(groupDir, 'spawn-template.md'))).toBe(true);
    expect(fs.readFileSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE), 'utf-8')).toBe('hello\n');
    expect(readGroupPersona(groupDir)).toBe('hello');
    expect(fs.existsSync(path.join(canonicalMemory, 'memories', 'imported-agent-memory.md'))).toBe(false);
    expect(fs.lstatSync(compatibilityLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(compatibilityLink)).toBe('/workspace/workgroup/memory');
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('leaves container-resolvable placeholder symlinks alone instead of writing through them', async () => {
    const ag = group('ag-danglink', 'danglink-group');
    await createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    // Targets that only resolve inside the container. existsSync FOLLOWS these
    // and reports false, so the placeholder write would traverse the same link
    // and throw ENOENT — and initGroupFilesystem runs before every spawn, so
    // that throw makes the group unstartable.
    fs.symlinkSync('/workspace/workgroup/private-spawn-template.md', path.join(groupDir, 'spawn-template.md'));
    fs.symlinkSync('/workspace/workgroup/shared-CLAUDE.local.md', path.join(groupDir, 'CLAUDE.local.md'));

    expect(() => initGroupFilesystem(ag, { instructions: 'hello' })).not.toThrow();

    for (const name of ['spawn-template.md', 'CLAUDE.local.md']) {
      const entry = path.join(groupDir, name);
      expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(entry)).toContain('/workspace/workgroup/');
    }
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', async () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    await createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE))).toBe(false);
  });

  it('treats an unregistered provider name as default support files without creating memory', async () => {
    const ag = group('ag-unknown', 'unknown-group');
    await createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'not-registered' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });
});

describe('initGroupFilesystem legacy seed isolation', async () => {
  it('never reads, transforms, or deletes .seed.md', async () => {
    const ag = group('ag-seed', 'seed-group');
    await createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const seedFile = path.join(groupDir, '.seed.md');
    const seedBytes = Buffer.from('seeded identity\r\n  trailing bytes \n');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(seedFile, seedBytes);

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      initGroupFilesystem(ag, {});
      initGroupFilesystem(ag, {});
      expect(readSpy.mock.calls.some(([target]) => path.resolve(String(target)) === seedFile)).toBe(false);
    } finally {
      readSpy.mockRestore();
    }

    expect(fs.readFileSync(seedFile)).toEqual(seedBytes);
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('');
    expect(fs.existsSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });

  it('does not overwrite existing nonempty instruction surfaces', async () => {
    const ag = group('ag-existing-instructions', 'existing-instructions-group');
    await createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE), 'operator persona\n');
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'operator local\n');

    initGroupFilesystem(ag, { instructions: 'replacement' });
    initGroupFilesystem(ag, { instructions: 'another replacement' });

    expect(fs.readFileSync(path.join(groupDir, STANDING_INSTRUCTIONS_FILE), 'utf-8')).toBe('operator persona\n');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('operator local\n');
  });
});

describe('buildMounts agent surfaces', async () => {
  it('applies one workgroup policy to every provider sibling through the real additional-mount allowlist', async () => {
    const recipient = group('ag-read-main', 'read-main');
    const sibling = group('ag-read-codex', 'read-codex');
    const source = group('ag-read-source', 'read-source');
    const unrelated = group('ag-read-unrelated', 'read-unrelated');
    for (const ag of [recipient, sibling, source, unrelated]) await createAgentGroup(ag);
    assignWorkgroup(recipient, 'recipient');
    assignWorkgroup(sibling, 'recipient');
    assignWorkgroup(source, 'source');
    assignWorkgroup(unrelated, 'unrelated');
    for (const ag of [recipient, sibling, source, unrelated]) await ensureContainerConfig(ag.id);
    for (const ag of [recipient, sibling, source, unrelated]) initGroupFilesystem(ag, {});

    for (const relative of [
      'workgroups/source/memory',
      'workgroups/source/conversations',
      'repositories/source',
      'v2-topics/source',
      'v2-threads/wg-source',
      'workgroups/unrelated/memory',
    ]) {
      fs.mkdirSync(path.join(DATA_DIR, relative), { recursive: true });
    }
    writeWorkgroupReadAccessPolicy({ recipient: { mode: 'all', sources: ['source'] } });

    const expectedPaths = [
      '/workspace/extra/work/source/files',
      '/workspace/extra/work/source/memory',
      '/workspace/extra/work/source/conversations',
      '/workspace/extra/work/source/repositories',
      '/workspace/extra/work/source/topics',
      '/workspace/extra/work/source/legacy-threads',
    ];
    for (const [provider, ag] of [
      ['claude', recipient],
      ['codex', sibling],
      ['opencode', sibling],
    ] as const) {
      const mounts = await buildMounts(
        ag,
        session(`s-read-${provider}`, ag.id),
        containerConfig(),
        provider,
        {},
        'recipient',
      );
      const granted = mounts.filter((mount) => mount.workgroupReadAccess);
      expect(granted.map((mount) => mount.containerPath).sort()).toEqual([...expectedPaths].sort());
      expect(granted.every((mount) => mount.readonly)).toBe(true);
      expect(granted.every((mount) => mount.hostPath.startsWith(DATA_DIR))).toBe(true);
      expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf8')).toContain(
        '/workspace/extra/work/source/files',
      );
    }

    const denied = await buildMounts(
      unrelated,
      session('s-read-denied', unrelated.id),
      containerConfig(),
      'claude',
      {},
      'unrelated',
    );
    expect(denied.some((mount) => mount.workgroupReadAccess)).toBe(false);
  });

  it('skips the workgroup wiki when an agent left a file at its /workspace mountpoint', async () => {
    const ag = group('ag-wiki-blocked', 'wiki-blocked');
    await createAgentGroup(ag);
    assignWorkgroup(ag, 'wiki-wg');
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});
    fs.mkdirSync(path.join(DATA_DIR, 'wikis', 'wiki-wg'), { recursive: true });
    const sess = session('s-wiki-blocked', ag.id);
    fs.mkdirSync(sessionDir(ag.id, sess.id), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(ag.id, sess.id), 'wiki'), 'notes an agent left here');

    const mounts = await buildMounts(ag, sess, containerConfig(), 'claude', {}, 'wiki-wg');

    expect(mounts.some((mount) => mount.containerPath === '/workspace/wiki')).toBe(false);
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf8')).not.toContain('## Workgroup wiki');
  });

  it('mounts the workgroup wiki read-only for every provider sibling and composes its section', async () => {
    const claudeAg = group('ag-wiki-main', 'wiki-main');
    const siblingAg = group('ag-wiki-codex', 'wiki-codex');
    const other = group('ag-wiki-other', 'wiki-other');
    for (const ag of [claudeAg, siblingAg, other]) await createAgentGroup(ag);
    assignWorkgroup(claudeAg, 'wiki-wg');
    assignWorkgroup(siblingAg, 'wiki-wg');
    assignWorkgroup(other, 'other-wg');
    for (const ag of [claudeAg, siblingAg, other]) await ensureContainerConfig(ag.id);
    for (const ag of [claudeAg, siblingAg, other]) initGroupFilesystem(ag, {});
    const wikiDir = path.join(DATA_DIR, 'wikis', 'wiki-wg');
    fs.mkdirSync(wikiDir, { recursive: true });
    fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Index\n');

    for (const [provider, ag] of [
      ['claude', claudeAg],
      ['codex', siblingAg],
      ['opencode', siblingAg],
    ] as const) {
      const mounts = await buildMounts(
        ag,
        session(`s-wiki-${provider}`, ag.id),
        containerConfig(),
        provider,
        {},
        'wiki-wg',
      );
      expect(mounts.filter((mount) => mount.containerPath === '/workspace/wiki')).toEqual([
        { hostPath: wikiDir, containerPath: '/workspace/wiki', readonly: true },
      ]);
      expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf8')).toContain('## Workgroup wiki');
    }

    const without = await buildMounts(
      other,
      session('s-wiki-none', other.id),
      containerConfig(),
      'claude',
      {},
      'other-wg',
    );
    expect(without.some((mount) => mount.containerPath === '/workspace/wiki')).toBe(false);
    expect(fs.readFileSync(path.join(GROUPS_DIR, other.folder, 'AGENTS.md'), 'utf8')).not.toContain(
      '## Workgroup wiki',
    );
  });

  it('canonical-working-tree-is-not-container-accessible', async () => {
    const workgroupId = 'wg-repositories';
    const ag = group('ag-repositories', 'repositories-agent');
    await createAgentGroup(ag);
    assignWorkgroup(ag, workgroupId);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem({ ...ag, workgroup_id: workgroupId }, { provider: 'claude' });

    const canonical = path.join(DATA_DIR, 'repositories', workgroupId, 'proj');
    fs.mkdirSync(canonical, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: canonical });
    const state = path.join(DATA_DIR, 'repository-state', workgroupId, 'proj');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, 'origin.json'),
      JSON.stringify({ origin: 'https://github.com/acme/proj.git', repositoryId: 'github.com/acme/proj' }),
    );

    const siblingA = {
      ...session('s-repo-a', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:171234.567',
    } as Session;
    const siblingB = {
      ...session('s-repo-b', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:171234.567',
    } as Session;
    const otherTopic = {
      ...session('s-repo-other', ag.id),
      messaging_group_id: 'mg-shared',
      thread_id: 'slack:C1:999999.000',
    } as Session;

    const a = await buildMounts(ag, siblingA, containerConfig(), 'claude', {}, workgroupId);
    const b = await buildMounts(ag, siblingB, containerConfig(), 'claude', {}, workgroupId);
    const other = await buildMounts(ag, otherTopic, containerConfig(), 'claude', {}, workgroupId);
    const stableA = a.find((mount) => mount.containerPath === '/workspace/worktrees');
    const stableB = b.find((mount) => mount.containerPath === '/workspace/worktrees');
    const stableOther = other.find((mount) => mount.containerPath === '/workspace/worktrees');

    expect(stableA?.hostPath).toBe(stableB?.hostPath);
    expect(stableOther?.hostPath).not.toBe(stableA?.hostPath);
    expect(a).toContainEqual({ hostPath: stableA?.hostPath, containerPath: stableA?.hostPath, readonly: false });
    expect(a).toContainEqual({
      hostPath: path.join(canonical, '.git'),
      containerPath: path.join(canonical, '.git'),
      readonly: false,
    });
    expect(a).toContainEqual({
      hostPath: path.join(canonical, '.git', 'HEAD'),
      containerPath: path.join(canonical, '.git', 'HEAD'),
      readonly: true,
    });
    expect(a).toContainEqual({
      hostPath: path.join(state, 'canonical-index-unavailable'),
      containerPath: path.join(canonical, '.git', 'index'),
      readonly: true,
    });
    const commonMount = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git'));
    const headOverlay = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git', 'HEAD'));
    const indexOverlay = a.findIndex((mount) => mount.containerPath === path.join(canonical, '.git', 'index'));
    expect(headOverlay).toBeGreaterThan(commonMount);
    expect(indexOverlay).toBeGreaterThan(commonMount);
    expect(a).toContainEqual({
      hostPath: path.join(state, 'repository.lock'),
      containerPath: path.join(state, 'repository.lock'),
      readonly: false,
    });
    expect(a.some((mount) => mount.hostPath === canonical || mount.containerPath === canonical)).toBe(false);
    expect(fs.lstatSync(path.join(state, 'repository.lock')).isFile()).toBe(true);
  });

  /** A canonical as an existing install holds it: a normal clone with no commondir, and its origin pin. */
  function seedCanonical(workgroupId: string, name: string): { gitDir: string; lock: string; pin: string } {
    const canonical = path.join(DATA_DIR, 'repositories', workgroupId, name);
    fs.mkdirSync(canonical, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: canonical });
    const state = path.join(DATA_DIR, 'repository-state', workgroupId, name);
    fs.mkdirSync(state, { recursive: true });
    const pin = path.join(state, 'origin.json');
    fs.writeFileSync(
      pin,
      JSON.stringify({ origin: `https://github.com/acme/${name}.git`, repositoryId: `github.com/acme/${name}` }),
    );
    return { gitDir: path.join(canonical, '.git'), lock: path.join(state, 'repository.lock'), pin };
  }

  async function repositoryAgent(workgroupId: string, folder: string): Promise<AgentGroup> {
    const ag = group(`ag-${folder}`, folder);
    await createAgentGroup(ag);
    assignWorkgroup(ag, workgroupId);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem({ ...ag, workgroup_id: workgroupId }, { provider: 'claude' });
    return ag;
  }

  function repositoryMounts(
    mounts: Awaited<ReturnType<typeof buildMounts>>,
    repo: { gitDir: string; lock: string; pin: string },
  ) {
    return mounts.filter(
      (mount) =>
        mount.containerPath === repo.gitDir ||
        mount.containerPath.startsWith(`${repo.gitDir}/`) ||
        mount.containerPath === repo.lock ||
        mount.containerPath === repo.pin,
    );
  }

  it('an existing canonical gets the commondir sentinel at its next spawn, and nothing else about its mounts changes (#669)', async () => {
    const workgroupId = 'wg-sentinel';
    const ag = await repositoryAgent(workgroupId, 'sentinel-agent');
    const repo = seedCanonical(workgroupId, 'proj');
    const commondir = path.join(repo.gitDir, 'commondir');
    expect(fs.existsSync(commondir)).toBe(false);

    const mounts = await buildMounts(ag, session('s-sentinel', ag.id), containerConfig(), 'claude', {}, workgroupId);

    expect(fs.readFileSync(commondir, 'utf8')).toBe('.\n');
    const readOnly = (file: string) => ({ hostPath: file, containerPath: file, readonly: true });
    const state = path.dirname(repo.lock);
    // What spawn mounted for this canonical before #669, in order...
    const controls = [
      { hostPath: repo.gitDir, containerPath: repo.gitDir, readonly: false },
      readOnly(path.join(repo.gitDir, 'config')),
      readOnly(path.join(repo.gitDir, 'HEAD')),
      {
        hostPath: path.join(state, 'canonical-index-unavailable'),
        containerPath: path.join(repo.gitDir, 'index'),
        readonly: true,
      },
      readOnly(path.join(repo.gitDir, 'hooks')),
      readOnly(path.join(repo.gitDir, 'objects', 'info')),
    ];
    const coordination = [{ hostPath: repo.lock, containerPath: repo.lock, readonly: false }, readOnly(repo.pin)];
    // ...plus exactly one entry: the sentinel, read-only, after the object-info overlay.
    expect(repositoryMounts(mounts, repo)).toEqual([...controls, readOnly(commondir), ...coordination]);
  });

  it.each<[string, (commondir: string, elsewhere: string) => void]>([
    ['another repository', (commondir, elsewhere) => fs.writeFileSync(commondir, `${path.join(elsewhere, '.git')}\n`)],
    [
      'a symlink to the sentinel bytes',
      (commondir, elsewhere) => {
        const bytes = path.join(elsewhere, 'sentinel-bytes');
        fs.writeFileSync(bytes, '.\n');
        fs.symlinkSync(bytes, commondir);
      },
    ],
    ['the same place in other bytes', (commondir) => fs.writeFileSync(commondir, './\n')],
    [
      // Left by a container spawned before the sentinel's read-only overlay:
      // the alias stays writable through the read-write .git mount.
      'the sentinel with a hard-link alias',
      (commondir) => {
        fs.writeFileSync(commondir, '.\n');
        fs.linkSync(commondir, path.join(path.dirname(commondir), 'writable-alias'));
      },
    ],
    [
      // The case that used to stop the whole workgroup: Git follows this
      // commondir to a directory that is not there and exits 128, and
      // discovery ran that probe before anything classified per repository.
      'a repository that does not exist',
      (commondir, elsewhere) => fs.writeFileSync(commondir, `${path.join(elsewhere, 'gone', '.git')}\n`),
    ],
  ])(
    'withholds every mount of a canonical whose commondir is %s, logs it, and still mounts its sibling (#669)',
    async (_shape, plant) => {
      const workgroupId = 'wg-commondir';
      const ag = await repositoryAgent(workgroupId, 'commondir-agent');
      const planted = seedCanonical(workgroupId, 'proj');
      const sibling = seedCanonical(workgroupId, 'sibling');
      // Another workgroup's canonical, whose host path a container can guess.
      const elsewhere = path.join(DATA_DIR, 'repositories', 'wg-elsewhere', 'secret');
      fs.mkdirSync(elsewhere, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: elsewhere });
      const commondir = path.join(planted.gitDir, 'commondir');
      plant(commondir, elsewhere);
      const read = (): string =>
        fs.lstatSync(commondir).isSymbolicLink()
          ? `link:${fs.readlinkSync(commondir)}`
          : fs.readFileSync(commondir, 'utf8');
      const plantedBytes = read();

      const mounts = await buildMounts(ag, session('s-commondir', ag.id), containerConfig(), 'claude', {}, workgroupId);

      expect(repositoryMounts(mounts, planted)).toEqual([]);
      const siblingCommondir = path.join(sibling.gitDir, 'commondir');
      expect(repositoryMounts(mounts, sibling)).toContainEqual({
        hostPath: sibling.gitDir,
        containerPath: sibling.gitDir,
        readonly: false,
      });
      expect(repositoryMounts(mounts, sibling)).toContainEqual({
        hostPath: siblingCommondir,
        containerPath: siblingCommondir,
        readonly: true,
      });
      // Discovery classifies this repository as unusable before Git runs on it
      // at all, so the log names the repository and why it was withheld.
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('#669'),
        expect.objectContaining({
          workgroupId,
          repository: 'proj',
          path: path.dirname(planted.gitDir),
          reason: expect.stringContaining('commondir'),
        }),
      );
      // Never overwritten.
      expect(read()).toBe(plantedBytes);
    },
  );

  // Pins the deletion of the global-~/.codex `config.toml` / `plugins` fallback
  // mounts (822f1deb). Nothing in the container reads /home/node/.codex/* in
  // codex-as-peer mode — the runner redirects CODEX_HOME to
  // /home/node/.codex-runtime — and as nested mounts runc created both entries
  // as root inside the operator's host ~/.codex-<folder>/.
  it('never nests global-codex config.toml or plugins inside a scoped ~/.codex home', async () => {
    const ag = group('ag-codex-peer', 'codex-peer');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem({ ...ag, workgroup_id: ag.folder }, { provider: 'claude' });

    const fakeHome = path.join(TEST_ROOT, 'codex-home');
    const scoped = path.join(fakeHome, `.codex-${ag.folder}`);
    const globalCodex = path.join(fakeHome, '.codex');
    fs.mkdirSync(path.join(fakeHome, 'plugins', 'codex'), { recursive: true });
    fs.mkdirSync(scoped, { recursive: true });
    fs.mkdirSync(path.join(globalCodex, 'plugins'), { recursive: true });
    // Scoped home has auth (so resolveCodexAuthDir picks it) but no config.toml
    // and no plugins/ — the exact shape the removed fallback fired on.
    fs.writeFileSync(path.join(scoped, 'auth.json'), '{}');
    fs.writeFileSync(path.join(globalCodex, 'config.toml'), 'model = "gpt-5.6-terra"\n');

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let mounts;
    try {
      mounts = await buildMounts(
        ag,
        session('s-codex-peer', ag.id),
        { ...containerConfig(), codexHostAuth: true },
        'claude',
        {},
        ag.folder,
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }

    // The scoped home itself still mounts — that is the credential surface.
    expect(mounts).toContainEqual({ hostPath: scoped, containerPath: '/home/node/.codex', readonly: false });
    expect(mounts.some((m) => m.containerPath.startsWith('/home/node/.codex/'))).toBe(false);
    expect(mounts.some((m) => m.hostPath === globalCodex || m.hostPath.startsWith(`${globalCodex}/`))).toBe(false);
  });

  it('uses the OpenCode Go default at high effort when no DB override exists', async () => {
    const ag = group('ag-opencode-defaults', 'opencode-defaults');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);

    const contribution = await providerContribution('opencode', ag, session('s-opencode-defaults', ag.id));

    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'opencode-go/glm-5.3-flash',
      OPENCODE_PROVIDER: 'opencode-go',
      OPENCODE_EFFORT: 'high',
    });
  });

  it('keeps explicit OpenCode DB model and effort overrides authoritative', async () => {
    const ag = group('ag-opencode-overrides', 'opencode-overrides');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigScalars(ag.id, { model: 'opencode-go/kimi-k3', effort: 'high' });

    const contribution = await providerContribution('opencode', ag, session('s-opencode-overrides', ag.id));

    expect(contribution.env).toMatchObject({
      OPENCODE_MODEL: 'opencode-go/kimi-k3',
      OPENCODE_PROVIDER: 'opencode-go',
      OPENCODE_EFFORT: 'high',
    });
  });

  it('mounts one shared kernel-lock inode for real Claude, Codex, and OpenCode build plans', async () => {
    const workgroupId = 'shared-house';
    const providerGroups = [
      { provider: 'claude', ag: group('ag-lock-claude', 'lock-claude') },
      { provider: 'codex', ag: group('ag-lock-codex', 'lock-codex') },
      { provider: 'opencode', ag: group('ag-lock-opencode', 'lock-opencode') },
    ];

    for (const { provider, ag } of providerGroups) {
      await createAgentGroup(ag);
      assignWorkgroup(ag, workgroupId);
      await ensureContainerConfig(ag.id);
      initGroupFilesystem({ ...ag, workgroup_id: workgroupId }, { provider });
    }

    const buildProviderMounts = async (provider: string, ag: AgentGroup, suffix: string) => {
      const sess = session(`s-lock-${provider}-${suffix}`, ag.id);
      return await buildMounts(
        ag,
        sess,
        containerConfig(),
        provider,
        await providerContribution(provider, ag, sess),
        workgroupId,
      );
    };
    const assertNestedMounts = (
      mounts: Awaited<ReturnType<typeof buildMounts>>,
      expectParent: boolean,
    ): { dev: number; ino: number } => {
      const parentIdx = mounts.findIndex((mount) => mount.containerPath === '/workspace/workgroup');
      const memoryIdx = mounts.findIndex((mount) => mount.containerPath === '/workspace/workgroup/memory');
      const lockMounts = mounts.filter((mount) => mount.containerPath === '/workspace/workgroup/.memory-write.lock');
      const lockIdx = mounts.indexOf(lockMounts[0]);

      expect(parentIdx >= 0).toBe(expectParent);
      expect(memoryIdx).toBeGreaterThan(parentIdx);
      expect(lockMounts).toEqual([
        {
          hostPath: path.join(DATA_DIR, 'workgroups', workgroupId, '.memory-write.lock'),
          containerPath: '/workspace/workgroup/.memory-write.lock',
          readonly: false,
        },
      ]);
      expect(lockIdx).toBeGreaterThan(memoryIdx);
      const stat = fs.lstatSync(lockMounts[0].hostPath);
      return { dev: stat.dev, ino: stat.ino };
    };

    // The test config forces WORKGROUP_SHARED_FS off. All three real provider
    // build plans still receive the exact nested memory + lock mounts.
    const memoryOnlyIdentities = await Promise.all(
      providerGroups.map(async ({ provider, ag }) =>
        assertNestedMounts(await buildProviderMounts(provider, ag, 'memory-only'), false),
      ),
    );
    expect(new Set(memoryOnlyIdentities.map(({ dev, ino }) => `${dev}:${ino}`)).size).toBe(1);

    // A prior full-FS migration marker activates the parent mount even with
    // the flag disabled. The nested file overlay must remain later than both
    // the parent and memory mounts for every provider.
    fs.writeFileSync(path.join(DATA_DIR, 'workgroups', workgroupId, '.migrated'), '{}\n');
    const fullIdentities = await Promise.all(
      providerGroups.map(async ({ provider, ag }) =>
        assertNestedMounts(await buildProviderMounts(provider, ag, 'full'), true),
      ),
    );
    expect(new Set(fullIdentities.map(({ dev, ino }) => `${dev}:${ino}`)).size).toBe(1);
    expect(fullIdentities[0]).toEqual(memoryOnlyIdentities[0]);

    const outsider = group('ag-lock-outsider', 'lock-outsider');
    await createAgentGroup(outsider);
    assignWorkgroup(outsider, 'other-house');
    await ensureContainerConfig(outsider.id);
    initGroupFilesystem({ ...outsider, workgroup_id: 'other-house' }, { provider: 'claude' });
    const outsiderSession = session('s-lock-outsider', outsider.id);
    const outsiderLock = (
      await buildMounts(
        outsider,
        outsiderSession,
        containerConfig(),
        'claude',
        await providerContribution('claude', outsider, outsiderSession),
        'other-house',
      )
    ).find((mount) => mount.containerPath === '/workspace/workgroup/.memory-write.lock');
    expect(outsiderLock?.hostPath).toBe(path.join(DATA_DIR, 'workgroups', 'other-house', '.memory-write.lock'));
    expect(outsiderLock?.hostPath).not.toBe(path.join(DATA_DIR, 'workgroups', workgroupId, '.memory-write.lock'));
  });

  it('mounts the default surfaces for an unregistered provider (today’s behavior)', async () => {
    const ag = group('ag-mounts-default', 'mounts-default');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    const mounts = await buildMounts(ag, session('s1', ag.id), containerConfig(), 'claude', {});

    const byContainerPath = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byContainerPath.has('/home/node/.claude')).toBe(true);
    expect(byContainerPath.has('/workspace/agent/CLAUDE.md')).toBe(true);
    // No fragment/symlink delivery mounts: the composer inlines every
    // section into CLAUDE.md/AGENTS.md directly, so nothing inside the
    // container ever needs the shared base or fragments at their own paths.
    expect(byContainerPath.has('/app/CLAUDE.md')).toBe(false);
    expect(byContainerPath.has('/workspace/agent/.claude-fragments')).toBe(false);
    // Composer ran: the generated project doc exists on disk.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(true);
  });

  it('suppresses the default surfaces and keeps contributed mounts for a surfaces-providing provider', async () => {
    const ag = group('ag-mounts-surfy', 'mounts-surfy');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const contributed = {
      mounts: [
        {
          hostPath: path.join(GROUPS_DIR, ag.folder),
          containerPath: '/workspace/agent/OWN-DOC.md',
          readonly: true,
        },
      ],
    };
    const mounts = await buildMounts(
      ag,
      session('s2', ag.id),
      containerConfig(),
      'surfaces-test-provider',
      contributed,
    );

    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/app/CLAUDE.md');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    // Composer did NOT run for this group.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(false);
    // Core mounts and the provider's own contribution are intact.
    expect(containerPaths).toContain('/workspace');
    expect(containerPaths).toContain('/workspace/agent');
    expect(containerPaths).toContain('/app/src');
    expect(containerPaths).toContain('/workspace/agent/OWN-DOC.md');
  });

  it('test_no_skill_is_force_added_beyond_the_group_selection', async () => {
    const cases: Array<{ provider: string; skills: ContainerConfig['skills']; suffix: string; expected?: string[] }> = [
      { provider: 'claude', skills: 'all', suffix: 'all' },
      { provider: 'codex', skills: [], suffix: 'empty', expected: [] },
      { provider: 'opencode', skills: ['debug', 'debug'], suffix: 'restricted', expected: ['debug'] },
    ];

    for (const testCase of cases) {
      const ag = group(`ag-skills-${testCase.suffix}`, `skills-${testCase.suffix}`);
      await createAgentGroup(ag);
      withWorkgroup(ag);
      await ensureContainerConfig(ag.id);
      initGroupFilesystem(ag, {});

      await buildMounts(
        ag,
        session(`s-skills-${testCase.suffix}`, ag.id),
        { ...containerConfig(), skills: testCase.skills },
        testCase.provider,
        {},
      );

      const skillsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
      const selected = fs.readdirSync(skillsDir);
      // Graphify is decommissioned — nothing may re-add it behind container.json.
      expect(selected).not.toContain('graphify');
      if (testCase.expected) {
        expect(selected).toEqual(testCase.expected);
      }
    }
  });

  it('test_gitnexus_host_plugin_and_builtin_hook_never_mount', async () => {
    const homedir = path.join(TEST_ROOT, 'home');
    const pluginsDir = path.join(homedir, 'plugins');
    const builtinDir = path.join(TEST_ROOT, 'container', 'nanoclaw-plugin');
    fs.mkdirSync(path.join(pluginsDir, 'gitnexus'), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, 'unrelated-plugin'), { recursive: true });
    fs.mkdirSync(builtinDir, { recursive: true });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homedir);

    try {
      const ag = group('ag-plugin-shadow', 'plugin-shadow');
      await createAgentGroup(ag);
      withWorkgroup(ag);
      await ensureContainerConfig(ag.id);
      initGroupFilesystem(ag, {});

      const mounts = await buildMounts(ag, session('s-plugin-shadow', ag.id), containerConfig(), 'claude', {});
      const paths = mounts.map((mount) => mount.containerPath);
      expect(paths).not.toContain('/workspace/plugins/gitnexus');
      expect(paths).not.toContain('/workspace/plugins/nanoclaw-hooks');
      expect(paths).toContain('/workspace/plugins/unrelated-plugin');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('mounts a workgroup-scoped plugin only for groups in its workgroups (src/plugin-scopes.ts)', async () => {
    const homedir = path.join(TEST_ROOT, 'home');
    fs.mkdirSync(path.join(homedir, 'plugins', 'client-plugin'), { recursive: true });
    fs.mkdirSync(path.join(homedir, 'plugins', 'shared-plugin'), { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'plugin-scopes.json'),
      JSON.stringify({ version: 1, plugins: { 'client-plugin': ['client-wg'], 'missing-plugin': ['client-wg'] } }),
    );
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homedir);

    try {
      const member = group('ag-scope-member', 'scope-member');
      const outsider = group('ag-scope-outsider', 'scope-outsider');
      for (const ag of [member, outsider]) await createAgentGroup(ag);
      assignWorkgroup(member, 'client-wg');
      assignWorkgroup(outsider, 'other-wg');
      for (const ag of [member, outsider]) {
        await ensureContainerConfig(ag.id);
        initGroupFilesystem(ag, {});
      }

      const memberPaths = (
        await buildMounts(member, session('s-scope-member', member.id), containerConfig(), 'claude', {}, 'client-wg')
      ).map((mount) => mount.containerPath);
      const outsiderPaths = (
        await buildMounts(
          outsider,
          session('s-scope-outsider', outsider.id),
          containerConfig(),
          'claude',
          {},
          'other-wg',
        )
      ).map((mount) => mount.containerPath);

      expect(memberPaths).toContain('/workspace/plugins/client-plugin');
      expect(memberPaths).toContain('/workspace/plugins/shared-plugin');
      expect(outsiderPaths).not.toContain('/workspace/plugins/client-plugin');
      expect(outsiderPaths).toContain('/workspace/plugins/shared-plugin');
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Plugin scope names no ~/plugins directory'),
        expect.objectContaining({ plugin: 'missing-plugin' }),
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });
});

describe('worker agent def sync (orchestrator roster)', async () => {
  it('copies trunk defs for a claude spawn, prunes retired managed defs, preserves operator files', async () => {
    const ag = group('ag-worker-defs', 'worker-defs');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    const agentsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents');
    // Seed: an operator-owned def plus a currently-shipping managed def that a
    // later trunk revision could retire (worker-codex stands in — it IS in
    // MANAGED_WORKER_DEFS, so if trunk dropped it, the prune must remove it).
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'custom-op.md'), 'operator-owned\n');
    for (const retired of ['worker-fast.md', 'worker.md', 'worker-high.md', 'worker-opus.md', 'worker-codex.md']) {
      fs.writeFileSync(path.join(agentsDir, retired), 'old managed definition\n');
    }
    fs.writeFileSync(path.join(agentsDir, 'impeccable-reviewer.md'), 'specialized definition\n');

    await buildMounts(ag, session('s-wd', ag.id), containerConfig(), 'claude', {});

    // Trunk roster copied byte-for-byte.
    for (const def of ['worker-frontier.md']) {
      expect(fs.readFileSync(path.join(agentsDir, def), 'utf-8')).toBe(
        fs.readFileSync(path.join(process.cwd(), 'container', 'agents', def), 'utf-8'),
      );
    }
    // Operator file untouched.
    expect(fs.readFileSync(path.join(agentsDir, 'custom-op.md'), 'utf-8')).toBe('operator-owned\n');
    for (const retired of ['worker-fast.md', 'worker.md', 'worker-high.md', 'worker-opus.md', 'worker-codex.md']) {
      expect(fs.existsSync(path.join(agentsDir, retired))).toBe(false);
    }
    expect(fs.readFileSync(path.join(agentsDir, 'impeccable-reviewer.md'), 'utf8')).toBe('specialized definition\n');
    // Fable must retain the 1M context suffix and explicit medium default.
    const frontierWorker = fs.readFileSync(path.join(agentsDir, 'worker-frontier.md'), 'utf-8');
    expect(frontierWorker).toContain('model: claude-fable-5-1[1m]');
    expect(frontierWorker).toContain('effort: medium');
    expect(frontierWorker).toContain('including investigation, technical decisions');
    expect(frontierWorker).toContain('do not spawn a wrapper agent');
    expect(frontierWorker).toContain('foreground-attached for cancellation');
    // The retired always-on roster fragment stays absent.
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          'container',
          'agent-runner',
          'src',
          'mcp-tools',
          'orchestrator-workers.instructions.md',
        ),
      ),
    ).toBe(false);
    // The retired fragment is never composed for any provider.
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'), 'utf-8')).not.toContain(
      'module-orchestrator-workers.md',
    );
  });

  it('never deletes outside the agents dir even if a poisoned file is planted (F1 traversal guard)', async () => {
    const ag = group('ag-worker-defs-sec', 'worker-defs-sec');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    // A canary the old manifest-driven prune could have deleted via traversal.
    const canary = path.join(DATA_DIR, 'canary-must-survive.txt');
    fs.writeFileSync(canary, 'do not delete\n');
    const agentsDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Container-writable state an agent could plant; prune must ignore it
    // entirely (targets come only from the in-source MANAGED_WORKER_DEFS list).
    fs.writeFileSync(
      path.join(agentsDir, '.nanoclaw-managed.json'),
      JSON.stringify(['../../../../canary-must-survive.txt']),
    );

    await buildMounts(ag, session('s-wd-sec', ag.id), containerConfig(), 'claude', {});

    expect(fs.existsSync(canary)).toBe(true);
  });

  it('skips the worker-def sync when the spawn-resolved provider is codex', async () => {
    const ag = group('ag-worker-defs-cx', 'worker-defs-cx');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    await buildMounts(ag, session('s-wd-cx', ag.id), containerConfig(), 'codex', {});

    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'agents'))).toBe(false);
  });
});

describe('retired mirror snapshot topology', async () => {
  it('does not expose old mirror-backed snapshots as repository canonicals', async () => {
    const ag = group('ag-snap', 'snap-group');
    await createAgentGroup(ag);
    assignWorkgroup(ag, 'wg-snap');
    await ensureContainerConfig(ag.id);
    fs.mkdirSync(path.join(GROUPS_DIR, ag.folder), { recursive: true });

    const wgShared = path.join(DATA_DIR, 'workgroups', 'wg-snap');
    // .migrated marker forces the workgroup mount on even though the test
    // config pins WORKGROUP_SHARED_FS=false.
    fs.mkdirSync(wgShared, { recursive: true });
    fs.writeFileSync(path.join(wgShared, '.migrated'), '');
    fs.mkdirSync(path.join(wgShared, '.repos', 'proj.git'), { recursive: true });
    fs.mkdirSync(path.join(wgShared, 'proj', '.git'), { recursive: true });
    // A mirror with no snapshot yet must NOT produce a mount.
    fs.mkdirSync(path.join(wgShared, '.repos', 'pending.git'), { recursive: true });

    const mounts = await buildMounts(ag, session('s-snap', ag.id), containerConfig(), 'claude', {}, 'wg-snap');
    const snap = mounts.find((m) => m.containerPath === '/workspace/workgroup/proj');
    expect(snap).toBeUndefined();
    expect(mounts.find((m) => m.containerPath === '/workspace/workgroup/pending')).toBeUndefined();
  });
});

describe('symlink overlay workgroup allowlist', async () => {
  it('mounts same-workgroup targets and refuses outside targets', async () => {
    const ag = group('ag-sym', 'sym-main');
    const sib = group('ag-sym-sib', 'sym-sib');
    const outsider = group('ag-out', 'out-group');
    await createAgentGroup(ag);
    await createAgentGroup(sib);
    await createAgentGroup(outsider);
    assignWorkgroup(ag, 'wg-sym');
    assignWorkgroup(sib, 'wg-sym');
    assignWorkgroup(outsider, 'wg-other');
    await ensureContainerConfig(ag.id);

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sibTarget = path.join(GROUPS_DIR, sib.folder, 'SHARED-REPO');
    const outsiderTarget = path.join(GROUPS_DIR, outsider.folder, 'SECRET');
    const hostTarget = path.join(TEST_ROOT, 'host-secret');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(sibTarget, { recursive: true });
    fs.mkdirSync(outsiderTarget, { recursive: true });
    fs.mkdirSync(hostTarget, { recursive: true });
    // Sibling share (legit clone-as-codex pattern), cross-workgroup theft,
    // and arbitrary host path — only the first may mount.
    fs.symlinkSync(sibTarget, path.join(groupDir, 'SHARED-REPO'));
    fs.symlinkSync(outsiderTarget, path.join(groupDir, 'STOLEN'));
    fs.symlinkSync(hostTarget, path.join(groupDir, 'HOST'));

    const mounts = await buildMounts(ag, session('s-sym', ag.id), containerConfig(), 'claude', {}, 'wg-sym');
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/workspace/agent/SHARED-REPO');
    expect(containerPaths).not.toContain('/workspace/agent/STOLEN');
    expect(containerPaths).not.toContain('/workspace/agent/HOST');
  });

  it('declares the redirected destination for an upward-escaping relative symlink', async () => {
    const ag = group('ag-rel', 'rel-main');
    const sib = group('ag-rel-sib', 'rel-sib');
    await createAgentGroup(ag);
    await createAgentGroup(sib);
    assignWorkgroup(ag, 'wg-rel');
    assignWorkgroup(sib, 'wg-rel');
    await ensureContainerConfig(ag.id);

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, sib.folder, 'SHARED-REL'), { recursive: true });
    // clone-as-codex's relative-symlink pattern. Docker resolves the mount
    // destination through the container FS, where /workspace/agent IS this
    // group dir — so `../rel-sib/SHARED-REL` really attaches at
    // /workspace/rel-sib/SHARED-REL, inside the session-dir bind. Declaring
    // that path lets spawnContainer pre-create the parent as the host user
    // instead of leaving runc to create it root-owned.
    fs.symlinkSync('../rel-sib/SHARED-REL', path.join(groupDir, 'SHARED-REL'));
    // An absolute target resolves to itself — no redirect.
    fs.mkdirSync(path.join(GROUPS_DIR, sib.folder, 'SHARED-ABS'), { recursive: true });
    fs.symlinkSync(path.join(GROUPS_DIR, sib.folder, 'SHARED-ABS'), path.join(groupDir, 'SHARED-ABS'));

    const mounts = await buildMounts(ag, session('s-rel', ag.id), containerConfig(), 'claude', {}, 'wg-rel');
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/workspace/rel-sib/SHARED-REL');
    expect(containerPaths).not.toContain('/workspace/agent/SHARED-REL');
    expect(containerPaths).toContain('/workspace/agent/SHARED-ABS');
    expect(mounts.find((m) => m.containerPath === '/workspace/rel-sib/SHARED-REL')?.hostPath).toBe(
      fs.realpathSync(path.join(GROUPS_DIR, sib.folder, 'SHARED-REL')),
    );
  });

  it('redirects relative targets that escape only after normalization', async () => {
    const ag = group('ag-norm', 'norm-main');
    const sib = group('ag-norm-sib', 'norm-sib');
    await createAgentGroup(ag);
    await createAgentGroup(sib);
    assignWorkgroup(ag, 'wg-norm');
    assignWorkgroup(sib, 'wg-norm');
    await ensureContainerConfig(ag.id);

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    // Neither target starts with `../`, but both normalize outside
    // /workspace/agent — a textual prefix test sends them down the literal
    // branch, whose stub Docker never uses, and runc creates the parent root.
    fs.mkdirSync(path.join(GROUPS_DIR, sib.folder, 'DOT-REL'), { recursive: true });
    fs.symlinkSync('./../norm-sib/DOT-REL', path.join(groupDir, 'DOT-REL'));
    fs.mkdirSync(path.join(GROUPS_DIR, sib.folder, 'DEEP-REL'), { recursive: true });
    // `sub` must exist for the target to resolve host-side at all — the loop
    // skips unresolvable links before classification ever runs.
    fs.mkdirSync(path.join(groupDir, 'sub'), { recursive: true });
    fs.symlinkSync('sub/../../norm-sib/DEEP-REL', path.join(groupDir, 'DEEP-REL'));

    const mounts = await buildMounts(ag, session('s-norm', ag.id), containerConfig(), 'claude', {}, 'wg-norm');
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/workspace/norm-sib/DOT-REL');
    expect(containerPaths).not.toContain('/workspace/agent/DOT-REL');
    expect(containerPaths).toContain('/workspace/norm-sib/DEEP-REL');
    expect(containerPaths).not.toContain('/workspace/agent/DEEP-REL');
  });

  it('redirects through an intermediate symlink that only the filesystem can resolve', async () => {
    const ag = group('ag-chain', 'chain-main');
    const sib = group('ag-chain-sib', 'chain-sib');
    await createAgentGroup(ag);
    await createAgentGroup(sib);
    assignWorkgroup(ag, 'wg-chain');
    assignWorkgroup(sib, 'wg-chain');
    await ensureContainerConfig(ag.id);

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(path.join(groupDir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, sib.folder, 'T'), { recursive: true });
    // `jump` is itself a symlink out to the sibling, so the top-level link's
    // text (`sub/jump/T`) normalizes to /workspace/agent/sub/jump/T while the
    // container really attaches at /workspace/chain-sib/T. No lexical rule can
    // see this; only resolution can.
    fs.symlinkSync('../../chain-sib', path.join(groupDir, 'sub', 'jump'));
    fs.symlinkSync('sub/jump/T', path.join(groupDir, 'CHAINED'));

    const mounts = await buildMounts(ag, session('s-chain', ag.id), containerConfig(), 'claude', {}, 'wg-chain');
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/workspace/chain-sib/T');
    expect(containerPaths).not.toContain('/workspace/agent/CHAINED');
    expect(containerPaths).not.toContain('/workspace/agent/sub/jump/T');
  });
});

// H-9 (docs/specs/upstream-mailbox-seam/plan.md §8): the spawn path
// materializes the runner's startup context and bind-mounts it read-only.
// spawnContainer runs writeSessionContext just after writeSessionRouting and
// well before buildMounts, so the two halves are asserted in that order here.
describe('runner session context file', () => {
  it('spawn writes the session context file and mounts it read-only at /app/.nanoclaw-session.json', async () => {
    const ag = group('ag-ctx', 'ctx-group');
    await createAgentGroup(ag);
    withWorkgroup(ag);
    await ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});
    const sess = session('s-ctx', ag.id);

    const mailbox = getAgentMailbox();
    const key = { agentGroupId: ag.id, sessionId: sess.id };
    // Provision first, as the spawn path does — the context file's mode is
    // taken from inbound.db in the same session dir.
    mailbox.prepare(key);
    writeSessionContext(ag.id, sess.id, await mailbox.runnerContext(key));

    const contextPath = sessionContextPath(ag.id, sess.id);
    expect(JSON.parse(fs.readFileSync(contextPath, 'utf-8'))).toEqual({
      agentGroupId: ag.id,
      sessionId: sess.id,
      mailbox: null,
    });
    // The container reads this file as a different UID than the host, so it
    // must be no stricter than the session DB the container already reads.
    const inboundMode = fs.statSync(inboundDbPath(ag.id, sess.id)).mode & 0o777;
    expect(fs.statSync(contextPath).mode & 0o777).toBe(inboundMode);
    expect(fs.statSync(path.dirname(contextPath)).mode & 0o777).toBe(
      fs.statSync(path.join(DATA_DIR, 'v2-sessions', ag.id, sess.id)).mode & 0o777,
    );
    // Nothing to configure for a bind-mounted SQLite mailbox.
    expect(await mailbox.runnerEnvironment(key)).toEqual({});

    const mounts = await buildMounts(ag, sess, containerConfig(), 'claude', {});
    expect(mounts).toContainEqual({
      hostPath: contextPath,
      containerPath: '/app/.nanoclaw-session.json',
      readonly: true,
    });
  });
});
