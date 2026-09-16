import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('claude-md-compose-test') }));
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: `${TEST_ROOT}/groups`,
  // Hermetic: the plugin scope policy (src/plugin-scopes.ts) must never be read from the host.
  DATA_DIR: `${TEST_ROOT}/data`,
}));

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations, getRawDb } from './db/index.js';
import { STANDING_INSTRUCTIONS_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

async function seed(ag: AgentGroup): Promise<void> {
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STANDING_INSTRUCTIONS_FILE), text);
}

function docOf(folder: string): string {
  return fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
}

/** Lines that would have reached the model as a literal, unresolved `@`-import. */
function importsOf(folder: string): string[] {
  return docOf(folder)
    .split('\n')
    .filter((line) => line.startsWith('@'));
}

// The composer translates its container-path symlinks (`/app/CLAUDE.md`,
// `/app/src/mcp-tools/...`) to host paths under `path.resolve(GROUPS_DIR, '..')`.
// GROUPS_DIR is mocked to TEST_ROOT/groups, so stand up the sources there with
// sentinels — that is what lets these tests assert the sections were INLINED
// rather than merely referenced.
const SHARED_BASE_SENTINEL = 'SENTINEL_SHARED_BASE_9f2c';
const MODULE_CLI_SENTINEL = 'SENTINEL_MODULE_CLI_4a71';

function seedInstructionSources(): void {
  const sharedBase = path.join(TEST_ROOT, 'container', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(sharedBase), { recursive: true });
  fs.writeFileSync(sharedBase, `# Shared base\n\n${SHARED_BASE_SENTINEL}\n`);

  const mcpTools = path.join(TEST_ROOT, 'container', 'agent-runner', 'src', 'mcp-tools');
  fs.mkdirSync(mcpTools, { recursive: true });
  fs.writeFileSync(path.join(mcpTools, 'cli.instructions.md'), `# ncl\n\n${MODULE_CLI_SENTINEL}\n`);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  seedInstructionSources();
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('every instruction section reaches the model (issue #233)', () => {
  // Claude Code silently DROPS an `@`-import whose resolved realpath falls
  // outside the project directory. The container's project directory is
  // /workspace/agent (the group folder); `.claude-shared.md` resolved to
  // /app/CLAUDE.md and `module-cli.md` to /app/src/mcp-tools/..., both
  // outside it. Measured 2026-09-03 in the real agent image (claude-code
  // 2.1.257) by capturing the outgoing Messages API request body: the
  // inline fragment's sentinel was present, both symlinked ones absent.
  // Every section is now written into the file itself.
  it('inlines the shared base and module fragments instead of importing them', async () => {
    const ag = group('ag-inline', 'inline-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(SHARED_BASE_SENTINEL);
    expect(doc).toContain(MODULE_CLI_SENTINEL);
  });

  it('leaves no `@`-import line anywhere in the composed document', async () => {
    const ag = group('ag-no-imports', 'no-imports-group');
    await seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    await composeGroupClaudeMd(ag, 'claude');

    expect(importsOf(ag.folder)).toEqual([]);
  });

  it('inlines the same sections into AGENTS.md for non-Claude providers', async () => {
    const ag = group('ag-inline-codex', 'inline-codex-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain(SHARED_BASE_SENTINEL);
    expect(agents).toContain(MODULE_CLI_SENTINEL);
  });

  it('does NOT expand @-includes inside an agent-writable inline fragment', async () => {
    // The persona source lives in the group folder, mounted RW at
    // /workspace/agent. The flattener runs host-side with the host user's
    // filesystem access, so expanding here would let a container author
    // `@~/.env`, have the host inline those bytes into the composed doc,
    // and read them back through its own mount. Same guard as
    // CLAUDE.local.md — a literal, unexpanded reference is the safe failure.
    const secretFile = path.join(TEST_ROOT, 'host-only-secret.txt');
    fs.writeFileSync(secretFile, 'SENTINEL_PERSONA_EXFIL_5b3e\n');

    const ag = group('ag-persona-inc', 'persona-inc-group');
    await seed(ag);
    writePersona(ag.folder, `@${secretFile}\n`);

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(`@${secretFile}`);
    expect(doc).not.toContain('SENTINEL_PERSONA_EXFIL_5b3e');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('SENTINEL_PERSONA_EXFIL_5b3e');
  });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('places the persona FIRST, before the shared base', async () => {
    const ag = group('ag-persona', 'persona-group');
    await seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain('You are an SDR agent.');
    expect(doc.indexOf('You are an SDR agent.')).toBeLessThan(doc.indexOf(SHARED_BASE_SENTINEL));
  });

  it('keeps the persona across a second compose (not pruned)', async () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    await seed(ag);
    writePersona(ag.folder, 'persona body');

    await composeGroupClaudeMd(ag, 'claude');
    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain('persona body');
    expect(doc.indexOf('persona body')).toBeLessThan(doc.indexOf(SHARED_BASE_SENTINEL));
  });

  it('is inert when no persona file is present (non-template groups)', async () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(SHARED_BASE_SENTINEL);
    // The shared base is the first section after the composed header.
    expect(doc.split('\n')[1]).toBe('# Shared base');
  });
});

describe('no vestigial fragment/symlink artifacts are written (post issue #233 inlining)', () => {
  // Before every instruction section was inlined into CLAUDE.md/AGENTS.md,
  // composeGroupClaudeMd also wrote a `.claude-shared.md` symlink and a
  // `.claude-fragments/` directory of per-fragment files so the composed doc
  // could `@`-import them. Both are superseded now that every section is
  // read from its host path and written into the doc directly.
  it('never creates .claude-fragments or .claude-shared.md', async () => {
    const ag = group('ag-no-artifacts', 'no-artifacts-group');
    await seed(ag);
    writePersona(ag.folder, 'persona body\n');
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      demo: { command: 'demo', instructions: 'demo instructions' },
    });

    await composeGroupClaudeMd(ag, 'codex');

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);
  });

  it('deletes a stale .claude-fragments/ and .claude-shared.md left by a pre-cutover compose, idempotently', async () => {
    const ag = group('ag-cleanup', 'cleanup-group');
    await seed(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(path.join(groupDir, '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.claude-fragments', 'stale-fragment.md'), 'stale');
    fs.symlinkSync('/app/CLAUDE.md', path.join(groupDir, '.claude-shared.md'));

    await composeGroupClaudeMd(ag, 'claude');

    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);

    // Idempotent: nothing stale is left, so a second compose is a clean no-op.
    await expect(composeGroupClaudeMd(ag, 'claude')).resolves.not.toThrow();
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions through ncl tasks', () => {
  it('imports module-cli.md with ncl tasks guidance and never imports module-scheduling.md', async () => {
    const ag = group('ag-sched', 'sched-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(MODULE_CLI_SENTINEL);
    expect(
      fs.readFileSync(
        path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'cli.instructions.md'),
        'utf-8',
      ),
    ).toContain('ncl tasks create');
  });

  it('excludes all scheduling guidance when cli_scope is disabled', async () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    await seed(ag);
    await updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    await composeGroupClaudeMd(ag, 'claude');

    expect(docOf(ag.folder)).not.toContain(MODULE_CLI_SENTINEL);
  });
});

describe('instruction-stack-prune L2 fragment retirement (acceptance criterion 2)', () => {
  it('composes module-cli.md but never the five retired always-on fragments', async () => {
    const ag = group('ag-fragment-retire', 'fragment-retire-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(MODULE_CLI_SENTINEL);
    for (const retired of [
      'module-agents.md',
      'module-core.md',
      'module-self-mod.md',
      'module-orchestrator-workers.md',
      'skill-onecli-gateway.md',
    ]) {
      // Retired fragments never had a `<name>.instructions.md` source under
      // mcp-tools/, so their name can never appear as composed content.
      expect(doc).not.toContain(retired);
    }
  });
});

describe('session capability authority', () => {
  it('does not bake a group-only capability snapshot into composed instructions', async () => {
    const ag = group('ag-no-group-caps', 'no-group-caps');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude');

    expect(docOf(ag.folder)).not.toContain('session-capabilities');
  });
});

describe('CLAUDE.local.md reach across providers', () => {
  // Regression: operator standing instructions used to be Claude-only. Claude
  // Code auto-discovers CLAUDE.local.md, but Codex and OpenCode read only the
  // project doc, so per-group rules silently reached one sibling of three —
  // including trust-boundary rules ("never permanently delete an email", a
  // client's "never name AI tooling in these repos"), each of which was
  // measured at 0 hits in both of its non-Claude siblings' AGENTS.md.
  const RULE = 'Never permanently delete an email.';

  function withLocal(folder: string, body: string): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), body);
  }

  for (const provider of ['claude', 'codex', 'opencode']) {
    it(`flattens local standing instructions into AGENTS.md for ${provider}`, async () => {
      const ag = group(`ag-local-${provider}`, `local-${provider}`);
      await seed(ag);
      withLocal(ag.folder, `# Group rules\n\n${RULE}\n`);

      await composeGroupClaudeMd(ag, provider);

      const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain(RULE);
    });
  }

  it('creates the local file before flattening so a first spawn is not missing it', async () => {
    const ag = group('ag-local-first', 'local-first');
    await seed(ag);

    await expect(composeGroupClaudeMd(ag, 'codex')).resolves.not.toThrow();
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'))).toBe(true);
  });

  it('does NOT expand @-includes in the local file (host-side exfiltration guard)', async () => {
    // The group folder is mounted RW at /workspace/agent, so a container can
    // write this file. The flattener runs host-side and follows absolute and ~
    // paths, so expanding here would let an agent inline arbitrary host files
    // (e.g. `@~/.env`) into AGENTS.md and read them back through its own mount.
    // A literal, unexpanded reference is the safe failure.
    const secretFile = path.join(TEST_ROOT, 'host-only-secret.txt');
    fs.writeFileSync(secretFile, 'SENTINEL_HOST_SECRET_d41d8cd9\n');

    const ag = group('ag-local-inc', 'local-inc');
    await seed(ag);
    withLocal(ag.folder, `@${secretFile}\n`);

    await composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain(`@${secretFile}`);
    expect(agents).not.toContain('SENTINEL_HOST_SECRET_d41d8cd9');
  });

  it('omits the standing-instructions heading when the local file is empty', async () => {
    const ag = group('ag-local-empty', 'local-empty');
    await seed(ag);
    withLocal(ag.folder, '   \n');

    await composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('## Standing instructions for this group');
  });
});

describe('AGENTS.md is never truncated', () => {
  // The eviction machinery was deleted — content bloat is judged by a human
  // reading the file, never by a byte number. A group with an oversized
  // CLAUDE.local.md must still get the FULL doc, for every provider.
  function withHugeLocal(folder: string): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    // Comfortably over 40KB, as many separate sections.
    const body = Array.from({ length: 45 }, (_, i) => `## Filler ${i}\n\n${'x'.repeat(1000)}`).join('\n\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), body);
  }

  for (const provider of ['codex', 'opencode', 'claude']) {
    it(`does not truncate the document for ${provider}`, async () => {
      const ag = group(`ag-notrunc-${provider}`, `notrunc-${provider}`);
      await seed(ag);
      withHugeLocal(ag.folder);

      await composeGroupClaudeMd(ag, provider);

      const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
      expect(Buffer.byteLength(agents, 'utf-8')).toBeGreaterThan(40 * 1024);
      expect(agents).not.toContain('## Omitted for size');
    });
  }
});

describe('workgroup wiki section (src/workgroup-wiki.ts)', () => {
  const WIKI_SECTION = '## Workgroup wiki\n\nSENTINEL_WIKI_7c3e';

  it('composes the host wiki section into CLAUDE.md', async () => {
    const ag = group('ag-wiki', 'wiki-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude', { workgroupId: 'wiki-group', workgroupWikiInstructions: WIKI_SECTION });

    expect(docOf(ag.folder)).toContain('SENTINEL_WIKI_7c3e');
  });

  it('composes the same section into AGENTS.md for non-Claude providers', async () => {
    const ag = group('ag-wiki-codex', 'wiki-codex-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'codex', {
      workgroupId: 'wiki-codex-group',
      workgroupWikiInstructions: WIKI_SECTION,
    });

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('SENTINEL_WIKI_7c3e');
  });

  it('omits the section when no wiki is mounted', async () => {
    const ag = group('ag-no-wiki', 'no-wiki-group');
    await seed(ag);

    await composeGroupClaudeMd(ag, 'claude', { workgroupId: 'no-wiki-group', workgroupWikiInstructions: null });

    expect(docOf(ag.folder)).not.toContain('## Workgroup wiki');
  });

  it('refuses wiki instructions without a spawn-resolved workgroup ID', async () => {
    const ag = group('ag-wiki-no-wg', 'wiki-no-wg-group');
    await seed(ag);

    await expect(composeGroupClaudeMd(ag, 'claude', { workgroupWikiInstructions: WIKI_SECTION })).rejects.toThrow(
      'spawn-resolved workgroup ID',
    );
  });
});

/**
 * Make a directory a sub-plugin the way the container walkers require: a
 * `.claude-plugin/plugin.json` (Claude) or `.codex-plugin/plugin.json` (Codex).
 * The composer honours either, and a directory declaring neither is not a
 * plugin to anything in this system.
 */
function declareSubPlugin(dir: string, flavour: 'claude' | 'codex' = 'claude'): void {
  const manifestDir = path.join(dir, flavour === 'claude' ? '.claude-plugin' : '.codex-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify({ name: path.basename(dir) }));
}

describe('workgroup-scoped plugin rulesets (src/plugin-scopes.ts)', () => {
  it('composes a scoped plugin ruleset only for groups in its workgroups', async () => {
    const home = path.join(TEST_ROOT, 'home');
    for (const [plugin, sentinel] of [
      ['client-plugin', 'SENTINEL_CLIENT_RULES_5b1d'],
      ['shared-plugin', 'SENTINEL_SHARED_RULES_2e8a'],
    ]) {
      fs.mkdirSync(path.join(home, 'plugins', plugin), { recursive: true });
      fs.writeFileSync(path.join(home, 'plugins', plugin, '.nanoclaw-always-on.md'), `${sentinel}\n`);
    }
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT, 'data', 'plugin-scopes.json'),
      JSON.stringify({ version: 1, plugins: { 'client-plugin': ['client-wg'] } }),
    );
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);

    try {
      const member = group('ag-rules-member', 'rules-member');
      const outsider = group('ag-rules-outsider', 'rules-outsider');
      await seed(member);
      await seed(outsider);

      await composeGroupClaudeMd(member, 'codex', { workgroupId: 'client-wg' });
      await composeGroupClaudeMd(outsider, 'codex', { workgroupId: 'other-wg' });

      const agentsDoc = (folder: string) => fs.readFileSync(path.join(GROUPS_DIR, folder, 'AGENTS.md'), 'utf-8');
      expect(agentsDoc(member.folder)).toContain('SENTINEL_CLIENT_RULES_5b1d');
      expect(agentsDoc(outsider.folder)).not.toContain('SENTINEL_CLIENT_RULES_5b1d');
      expect(agentsDoc(outsider.folder)).toContain('SENTINEL_SHARED_RULES_2e8a');
    } finally {
      homedirSpy.mockRestore();
    }
  });
});

describe("sub-plugin always-on: the plugin's own always-on.md (OpenCode only)", () => {
  const OVERRIDE_SENTINEL = 'SENTINEL_OVERRIDE_RULES_1a2b';
  const ORCHESTRATE_SENTINEL = 'SENTINEL_ORCHESTRATE_RULES_3c4d';
  const WWBD_SENTINEL = 'SENTINEL_WWBD_RULES_5e6f';
  const ROOTLEVEL_SENTINEL = 'SENTINEL_ROOTLEVEL_RULES_7a8b';

  /**
   * ~/plugins/bootstrap carrying each sub-plugin's OWN `always-on.md` in both
   * walked layouts, plus (optionally) the operator's NanoClaw-side override at
   * the repo root.
   */
  function seedBootstrapPlugin(override: string | null): string {
    const home = path.join(TEST_ROOT, 'home');
    const repo = path.join(home, 'plugins', 'bootstrap');
    for (const [dir, sentinel] of [
      [path.join(repo, 'plugins', 'orchestrate'), ORCHESTRATE_SENTINEL],
      [path.join(repo, 'plugins', 'wwbd'), WWBD_SENTINEL],
      [path.join(repo, 'rootlevel'), ROOTLEVEL_SENTINEL],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'always-on.md'), `${sentinel}\n`);
      declareSubPlugin(dir);
    }
    fs.mkdirSync(repo, { recursive: true });
    if (override !== null) fs.writeFileSync(path.join(repo, '.nanoclaw-always-on.md'), override);
    return home;
  }

  function setExcludePlugins(folder: string, entries: string[]): void {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({ excludePlugins: entries }, null, 2));
  }

  function agentsDoc(folder: string): string {
    return fs.readFileSync(path.join(GROUPS_DIR, folder, 'AGENTS.md'), 'utf-8');
  }

  it("injects every sub-plugin's own always-on.md into an OpenCode group", async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(null));
    try {
      const ag = group('ag-sub-opencode', 'sub-opencode');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      for (const sentinel of [ORCHESTRATE_SENTINEL, WWBD_SENTINEL, ROOTLEVEL_SENTINEL]) {
        expect(doc).toContain(sentinel);
      }
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("composes a single-plugin repo's ROOT always-on.md, with the operator override winning", async () => {
    // A repo we maintain must reach OpenCode without a NanoClaw-specific file,
    // which is only true if the composer reads the root's own generic ruleset —
    // `subPluginDirs` returns children only, so a single-plugin repo has no
    // sub-plugin to carry it. The override keeps precedence where both exist,
    // because that is the operator deliberately replacing a third party's text.
    const home = seedBootstrapPlugin(null);
    const solo = path.join(home, 'plugins', 'solo');
    fs.mkdirSync(solo, { recursive: true });
    fs.writeFileSync(path.join(solo, 'always-on.md'), 'SENTINEL_SOLO_ROOT_3a9c\n');

    const both = path.join(home, 'plugins', 'overridden');
    fs.mkdirSync(both, { recursive: true });
    fs.writeFileSync(path.join(both, 'always-on.md'), 'SENTINEL_OWN_LOSES_7c1b\n');
    fs.writeFileSync(path.join(both, '.nanoclaw-always-on.md'), 'SENTINEL_OVERRIDE_WINS_4d2f\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-root-ruleset', 'root-ruleset');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      expect(doc).toContain('SENTINEL_SOLO_ROOT_3a9c');
      expect(doc).toContain('SENTINEL_OVERRIDE_WINS_4d2f');
      expect(doc).not.toContain('SENTINEL_OWN_LOSES_7c1b');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("excludes a single-plugin repo's root ruleset by its top-level name", async () => {
    const home = seedBootstrapPlugin(null);
    const solo = path.join(home, 'plugins', 'solo');
    fs.mkdirSync(solo, { recursive: true });
    fs.writeFileSync(path.join(solo, 'always-on.md'), 'SENTINEL_SOLO_EXCLUDED_8e4a\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-root-excluded', 'root-excluded');
      await seed(ag);
      setExcludePlugins(ag.folder, ['solo']);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain('SENTINEL_SOLO_EXCLUDED_8e4a');
      expect(doc).toContain(ORCHESTRATE_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('never composes a root always-on.md into a Codex group before #827 lands', async () => {
    const home = seedBootstrapPlugin(null);
    const solo = path.join(home, 'plugins', 'solo');
    fs.mkdirSync(solo, { recursive: true });
    fs.writeFileSync(path.join(solo, 'always-on.md'), 'SENTINEL_SOLO_CODEX_1b5d\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-root-codex', 'root-codex');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'codex', {});
      expect(agentsDoc(ag.folder)).not.toContain('SENTINEL_SOLO_CODEX_1b5d');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('never composes a ruleset that resolves outside its plugin repository', async () => {
    // The host reads these paths and publishes what it finds into AGENTS.md,
    // which is mounted into the container — so a symlink here moves host-only
    // state into container-visible state. That a plugin's code already runs in
    // the container is a different permission. Every component is
    // plugin-choosable, so containment is on the RESOLVED path, not the name.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const secret = path.join(TEST_ROOT, 'host-only-secret.json');
    fs.writeFileSync(secret, 'SENTINEL_HOST_SECRET_9f3e\n');

    // (a) the ruleset file itself is a symlink out of the repo
    const viaFile = path.join(repo, 'plugins', 'exfil-file');
    fs.mkdirSync(viaFile, { recursive: true });
    fs.symlinkSync(secret, path.join(viaFile, 'always-on.md'));

    // (b) the sub-plugin DIRECTORY is a symlink out of the repo — subPluginDirs
    //     follows it, so a check on the final component alone would miss this
    const outside = path.join(TEST_ROOT, 'outside-repo');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'always-on.md'), 'SENTINEL_HOST_SECRET_9f3e\n');
    fs.symlinkSync(outside, path.join(repo, 'plugins', 'exfil-dir'));

    // (c) a sibling whose path merely PREFIXES the repo root is not inside it —
    //     containment compares on a separator boundary. The planted file is
    //     NOT named always-on.md, so the only way its bytes could reach the doc
    //     is through bootstrap's symlink: the sibling is itself a plugin
    //     directory, and composing its OWN root ruleset would be correct.
    const sibling = `${repo}-evil`;
    fs.mkdirSync(path.join(sibling, 'plugins', 'sneak'), { recursive: true });
    fs.writeFileSync(path.join(sibling, 'plugins', 'sneak', 'always-on.md'), 'SENTINEL_HOST_SECRET_9f3e\n');
    fs.symlinkSync(path.join(sibling, 'plugins', 'sneak'), path.join(repo, 'plugins', 'exfil-sibling'));

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-symlink', 'sub-symlink');
      await seed(ag);
      // The sibling is itself a plugin directory under ~/plugins, so composing
      // ITS rulesets would be correct and would put the sentinel in the doc for
      // an innocent reason. Excluding it by name leaves bootstrap's symlink as
      // the only route the sentinel could take — which is the route under test.
      setExcludePlugins(ag.folder, ['bootstrap-evil']);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain('SENTINEL_HOST_SECRET_9f3e');
      // The legitimate siblings in the same repo still compose — this refuses
      // the escape, not the feature.
      expect(doc).toContain(ORCHESTRATE_SENTINEL);
      expect(doc).toContain(WWBD_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('skips a ruleset larger than the composer bound, keeping its siblings', async () => {
    // Containment says WHERE a ruleset may live, not how big it is. The read is
    // synchronous and on the spawn path, so an oversized file is paid as spawn
    // latency and host memory before anything downstream looks. Refusing beats
    // truncating: half a standing ruleset is a directive with its carve-outs
    // cut off.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const huge = path.join(repo, 'plugins', 'huge');
    fs.mkdirSync(huge, { recursive: true });
    fs.writeFileSync(path.join(huge, 'always-on.md'), `SENTINEL_HUGE_RULESET_8b1d\n${'x'.repeat(64 * 1024)}`);

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-huge', 'sub-huge');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain('SENTINEL_HUGE_RULESET_8b1d');
      expect(doc).toContain(ORCHESTRATE_SENTINEL);
      expect(doc).toContain(WWBD_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('never composes a ruleset that is a hard link to a file outside the repository', async () => {
    // A hard link is not an indirection — the directory entry IS the file — so
    // `realpath` and the open descriptor BOTH answer with the in-repo name and
    // containment passes (measured on this host). `nlink` is the property that
    // actually differs, and this repo already uses it for the same reason on
    // the canonical-git sentinel (#739). A standing ruleset with a second name
    // is not a legitimate shape.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const secret = path.join(TEST_ROOT, 'host-only-secret-hardlink.json');
    fs.writeFileSync(secret, 'SENTINEL_HARDLINKED_SECRET_6e2a\n');

    const sub = path.join(repo, 'plugins', 'linked-out');
    fs.mkdirSync(sub, { recursive: true });
    fs.linkSync(secret, path.join(sub, 'always-on.md'));

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-hardlink', 'sub-hardlink');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain('SENTINEL_HARDLINKED_SECRET_6e2a');
      // The escape is refused, not the feature.
      expect(doc).toContain(ORCHESTRATE_SENTINEL);
      expect(doc).toContain(WWBD_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('resolves the repository root BEFORE opening the file, not after', async () => {
    // An ordering claim needs an ordering probe: asserting the composed output
    // holds either way, because the race this ordering closes cannot be driven
    // from outside the function. A root resolved AFTER the open is a second
    // pathname lookup the first cannot constrain — swap `~/plugins/<repo>` for
    // a symlink to a parent between the two and a descriptor holding
    // `~/.codex/auth.json` measures as contained by the freshly-resolved root.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const calls: string[] = [];
    const realRealpath = fs.realpathSync;
    const realOpen = fs.openSync;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === repo) calls.push(`realpath:${p}`);
      return (realRealpath as unknown as (...a: unknown[]) => string)(p, ...rest);
    }) as typeof fs.realpathSync);
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).startsWith(repo)) calls.push(`open:${p}`);
      return (realOpen as unknown as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-order', 'sub-order');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});

      // Per READ, not globally: the composer reads one ruleset per sub-plugin,
      // so the sequence is realpath, open, realpath, open... What must never
      // appear is an open whose root lookup came after it.
      expect(
        calls.some((c) => c.startsWith('open:')),
        'the composer must open at least one ruleset',
      ).toBe(true);
      expect(calls[0] ?? '', 'the first filesystem call must be the root lookup').toMatch(/^realpath:/);
      calls.forEach((call, i) => {
        if (!call.startsWith('open:')) return;
        expect(calls[i - 1] ?? '', `open at ${i} must be preceded by its root lookup`).toMatch(/^realpath:/);
      });
    } finally {
      homedirSpy.mockRestore();
      openSpy.mockRestore();
      realpathSpy.mockRestore();
    }
  });

  it('composes nothing when the open descriptor cannot be identified', async () => {
    // r7 claimed no deterministic test could reach the fd path; r8 pointed out
    // an fs spy can. Forcing `/proc/self/fd/<fd>` to fail is the no-`/proc`
    // platform (macOS). The old fallback re-resolved the path by name, which is
    // exactly the lookup the descriptor check exists to avoid — so it now fails
    // closed instead, and this pins that rather than the fallback.
    const home = seedBootstrapPlugin(null);
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation((p: fs.PathLike, ...rest) => {
      if (String(p).startsWith('/proc/self/fd/')) throw new Error('ENOSYS: no /proc on this platform');
      return (fs.readlinkSync as unknown as (...a: unknown[]) => string)(p, ...rest);
    });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-noproc', 'sub-noproc');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      // Every plugin ruleset is withheld — not just an escaping one.
      expect(doc).not.toContain(ORCHESTRATE_SENTINEL);
      expect(doc).not.toContain(WWBD_SENTINEL);
      expect(doc).not.toContain(ROOTLEVEL_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
      readlinkSpy.mockRestore();
    }
  });

  it('composes a ruleset reached by a symlink that stays inside the repository', async () => {
    // Containment, not a ban on symlinks: a repo is free to point a sub-plugin's
    // directive at another file of its own.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const inRepo = path.join(repo, 'shared-rules.md');
    fs.writeFileSync(inRepo, 'SENTINEL_IN_REPO_LINK_2c5a\n');
    const sub = path.join(repo, 'plugins', 'linked');
    fs.mkdirSync(sub, { recursive: true });
    declareSubPlugin(sub);
    fs.symlinkSync(inRepo, path.join(sub, 'always-on.md'));

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-inrepo-link', 'sub-inrepo-link');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      expect(agentsDoc(ag.folder)).toContain('SENTINEL_IN_REPO_LINK_2c5a');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("never composes a NON-PLUGIN directory's always-on.md", async () => {
    // `<repo>/docs/` is not a plugin: no walker mounts, registers or excludes
    // it, and `excludePlugins` names plugins. Composing its file would put text
    // in every OpenCode group's standing prompt that no control can withhold.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const notAPlugin = path.join(repo, 'docs');
    fs.mkdirSync(notAPlugin, { recursive: true });
    fs.writeFileSync(path.join(notAPlugin, 'always-on.md'), 'SENTINEL_NOT_A_PLUGIN_8d3c\n');
    // The same directory name under the other walked layout, equally not one.
    const nestedNotAPlugin = path.join(repo, 'plugins', 'notes');
    fs.mkdirSync(nestedNotAPlugin, { recursive: true });
    fs.writeFileSync(path.join(nestedNotAPlugin, 'always-on.md'), 'SENTINEL_NOT_A_PLUGIN_NESTED_5b7e\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-nonplugin', 'sub-nonplugin');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain('SENTINEL_NOT_A_PLUGIN_8d3c');
      expect(doc).not.toContain('SENTINEL_NOT_A_PLUGIN_NESTED_5b7e');
      // The real sub-plugins beside them still compose.
      expect(doc).toContain(ORCHESTRATE_SENTINEL);
      expect(doc).toContain(ROOTLEVEL_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('accepts a sub-plugin that declares itself with a CODEX manifest only', async () => {
    // Either manifest, because this composer serves OpenCode and a directory
    // either container walker would load as a plugin is one it must speak for.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    const codexOnly = path.join(repo, 'plugins', 'codex-only');
    fs.mkdirSync(codexOnly, { recursive: true });
    declareSubPlugin(codexOnly, 'codex');
    fs.writeFileSync(path.join(codexOnly, 'always-on.md'), 'SENTINEL_CODEX_MANIFEST_3f9a\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-codexmanifest', 'sub-codexmanifest');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});
      expect(agentsDoc(ag.folder)).toContain('SENTINEL_CODEX_MANIFEST_3f9a');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('keeps a repo-root ruleset that a SUB-PATH exclusion does not name — only a top-level entry withholds it', async () => {
    // The seam #828 recorded, pinned as behaviour rather than left implicit. A
    // sub-path entry withholds the SUB-PLUGIN's own file; the repo root's file
    // is the repo's directive and stays. An operator isolating prompt content
    // has to exclude the repo, and a repo whose root file restates a
    // sub-plugin's directive defeats the sub-path entry — which is why
    // bootstrap ships its directives per sub-plugin and no root file at all.
    const home = seedBootstrapPlugin(null);
    const repo = path.join(home, 'plugins', 'bootstrap');
    fs.writeFileSync(path.join(repo, 'always-on.md'), 'SENTINEL_REPO_ROOT_RULES_6e2d\n');

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const kept = group('ag-root-kept', 'root-kept');
      await seed(kept);
      setExcludePlugins(kept.folder, ['bootstrap/plugins/orchestrate']);
      await composeGroupClaudeMd(kept, 'opencode', {});
      const keptDoc = agentsDoc(kept.folder);
      expect(keptDoc).not.toContain(ORCHESTRATE_SENTINEL);
      expect(keptDoc).toContain('SENTINEL_REPO_ROOT_RULES_6e2d');

      const dropped = group('ag-root-dropped', 'root-dropped');
      await seed(dropped);
      setExcludePlugins(dropped.folder, ['bootstrap']);
      await composeGroupClaudeMd(dropped, 'opencode', {});
      expect(agentsDoc(dropped.folder)).not.toContain('SENTINEL_REPO_ROOT_RULES_6e2d');
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('never injects a sub-plugin always-on.md into a Codex group — its plugin hook delivers it', async () => {
    // Codex fires plugin SessionStart hooks, so composing the same text here
    // would double-deliver the directive. Only the operator's NanoClaw-side
    // override at the repo root still reaches a Codex group.
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(`${OVERRIDE_SENTINEL}\n`));
    try {
      const ag = group('ag-sub-codex', 'sub-codex');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'codex', {});

      const doc = agentsDoc(ag.folder);
      for (const sentinel of [ORCHESTRATE_SENTINEL, WWBD_SENTINEL, ROOTLEVEL_SENTINEL]) {
        expect(doc).not.toContain(sentinel);
      }
      expect(doc).toContain(OVERRIDE_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('drops only the excluded sub-plugin, keeping its siblings and the operator override', async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(`${OVERRIDE_SENTINEL}\n`));
    try {
      const ag = group('ag-sub-excluded', 'sub-excluded');
      await seed(ag);
      setExcludePlugins(ag.folder, ['bootstrap/plugins/orchestrate']);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain(ORCHESTRATE_SENTINEL);
      expect(doc).toContain(WWBD_SENTINEL);
      expect(doc).toContain(ROOTLEVEL_SENTINEL);
      expect(doc).toContain(OVERRIDE_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('excluding the plugins/ container drops every sub-plugin under it', async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(null));
    try {
      const ag = group('ag-sub-container', 'sub-container');
      await seed(ag);
      setExcludePlugins(ag.folder, ['bootstrap/plugins']);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain(ORCHESTRATE_SENTINEL);
      expect(doc).not.toContain(WWBD_SENTINEL);
      expect(doc).toContain(ROOTLEVEL_SENTINEL);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('excluding the whole repo drops the sub-plugins and the override together', async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(`${OVERRIDE_SENTINEL}\n`));
    try {
      const ag = group('ag-sub-repo', 'sub-repo');
      await seed(ag);
      setExcludePlugins(ag.folder, ['bootstrap']);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      for (const sentinel of [OVERRIDE_SENTINEL, ORCHESTRATE_SENTINEL, WWBD_SENTINEL, ROOTLEVEL_SENTINEL]) {
        expect(doc).not.toContain(sentinel);
      }
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('keeps both rulesets when one repo carries the same sub-plugin name in both layouts', async () => {
    // `subPluginDirs` walks `<repo>/plugins/<sub>` AND `<repo>/<sub>`, so a repo
    // with both shares a basename. Keying the fragment by that basename dropped
    // one of the two silently. (PR #826 Codex round 3, P2.)
    const home = path.join(TEST_ROOT, 'home');
    const repo = path.join(home, 'plugins', 'bootstrap');
    const NESTED = 'SENTINEL_NESTED_TWIN_9c1e';
    const ROOTED = 'SENTINEL_ROOTED_TWIN_4f7d';
    for (const [dir, sentinel] of [
      [path.join(repo, 'plugins', 'twin'), NESTED],
      [path.join(repo, 'twin'), ROOTED],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'always-on.md'), `${sentinel}\n`);
      declareSubPlugin(dir);
    }
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-twin', 'sub-twin');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      expect(doc).toContain(NESTED);
      expect(doc).toContain(ROOTED);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('still excludes a twin by its own sub-path, leaving the other in place', async () => {
    const home = path.join(TEST_ROOT, 'home');
    const repo = path.join(home, 'plugins', 'bootstrap');
    const NESTED = 'SENTINEL_NESTED_TWIN_9c1e';
    const ROOTED = 'SENTINEL_ROOTED_TWIN_4f7d';
    for (const [dir, sentinel] of [
      [path.join(repo, 'plugins', 'twin'), NESTED],
      [path.join(repo, 'twin'), ROOTED],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'always-on.md'), `${sentinel}\n`);
      declareSubPlugin(dir);
    }
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      const ag = group('ag-sub-twin-excl', 'sub-twin-excl');
      await seed(ag);
      setExcludePlugins(ag.folder, ['bootstrap/plugins/twin']);
      await composeGroupClaudeMd(ag, 'opencode', {});

      const doc = agentsDoc(ag.folder);
      expect(doc).not.toContain(NESTED);
      expect(doc).toContain(ROOTED);
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it('never injects any plugin ruleset into a Claude group (its SessionStart hook owns that)', async () => {
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(seedBootstrapPlugin(`${OVERRIDE_SENTINEL}\n`));
    try {
      const ag = group('ag-sub-claude', 'sub-claude');
      await seed(ag);
      await composeGroupClaudeMd(ag, 'claude', {});

      const doc = docOf(ag.folder);
      for (const sentinel of [OVERRIDE_SENTINEL, ORCHESTRATE_SENTINEL, WWBD_SENTINEL]) {
        expect(doc).not.toContain(sentinel);
      }
    } finally {
      homedirSpy.mockRestore();
    }
  });
});
