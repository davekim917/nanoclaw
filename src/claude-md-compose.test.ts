import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('claude-md-compose-test') }));
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: `${TEST_ROOT}/groups`,
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { STANDING_INSTRUCTIONS_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
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

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  seedInstructionSources();
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
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
  it('inlines the shared base and module fragments instead of importing them', () => {
    const ag = group('ag-inline', 'inline-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(SHARED_BASE_SENTINEL);
    expect(doc).toContain(MODULE_CLI_SENTINEL);
  });

  it('leaves no `@`-import line anywhere in the composed document', () => {
    const ag = group('ag-no-imports', 'no-imports-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag, 'claude');

    expect(importsOf(ag.folder)).toEqual([]);
  });

  it('inlines the same sections into AGENTS.md for non-Claude providers', () => {
    const ag = group('ag-inline-codex', 'inline-codex-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain(SHARED_BASE_SENTINEL);
    expect(agents).toContain(MODULE_CLI_SENTINEL);
  });

  it('does NOT expand @-includes inside an agent-writable inline fragment', () => {
    // The persona source lives in the group folder, mounted RW at
    // /workspace/agent. The flattener runs host-side with the host user's
    // filesystem access, so expanding here would let a container author
    // `@~/.env`, have the host inline those bytes into the composed doc,
    // and read them back through its own mount. Same guard as
    // CLAUDE.local.md — a literal, unexpanded reference is the safe failure.
    const secretFile = path.join(TEST_ROOT, 'host-only-secret.txt');
    fs.writeFileSync(secretFile, 'SENTINEL_PERSONA_EXFIL_5b3e\n');

    const ag = group('ag-persona-inc', 'persona-inc-group');
    seed(ag);
    writePersona(ag.folder, `@${secretFile}\n`);

    composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(`@${secretFile}`);
    expect(doc).not.toContain('SENTINEL_PERSONA_EXFIL_5b3e');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).not.toContain('SENTINEL_PERSONA_EXFIL_5b3e');
  });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('places the persona FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain('You are an SDR agent.');
    expect(doc.indexOf('You are an SDR agent.')).toBeLessThan(doc.indexOf(SHARED_BASE_SENTINEL));
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag, 'claude');
    composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain('persona body');
    expect(doc.indexOf('persona body')).toBeLessThan(doc.indexOf(SHARED_BASE_SENTINEL));
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

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
  it('never creates .claude-fragments or .claude-shared.md', () => {
    const ag = group('ag-no-artifacts', 'no-artifacts-group');
    seed(ag);
    writePersona(ag.folder, 'persona body\n');
    updateContainerConfigJson(ag.id, 'mcp_servers', {
      demo: { command: 'demo', instructions: 'demo instructions' },
    });

    composeGroupClaudeMd(ag, 'codex');

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);
  });

  it('deletes a stale .claude-fragments/ and .claude-shared.md left by a pre-cutover compose, idempotently', () => {
    const ag = group('ag-cleanup', 'cleanup-group');
    seed(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(path.join(groupDir, '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.claude-fragments', 'stale-fragment.md'), 'stale');
    fs.symlinkSync('/app/CLAUDE.md', path.join(groupDir, '.claude-shared.md'));

    composeGroupClaudeMd(ag, 'claude');

    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);

    // Idempotent: nothing stale is left, so a second compose is a clean no-op.
    expect(() => composeGroupClaudeMd(ag, 'claude')).not.toThrow();
    expect(fs.existsSync(path.join(groupDir, '.claude-fragments'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, '.claude-shared.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions through ncl tasks', () => {
  it('imports module-cli.md with ncl tasks guidance and never imports module-scheduling.md', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

    const doc = docOf(ag.folder);
    expect(doc).toContain(MODULE_CLI_SENTINEL);
    expect(
      fs.readFileSync(
        path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'cli.instructions.md'),
        'utf-8',
      ),
    ).toContain('ncl tasks create');
  });

  it('excludes all scheduling guidance when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag, 'claude');

    expect(docOf(ag.folder)).not.toContain(MODULE_CLI_SENTINEL);
  });
});

describe('instruction-stack-prune L2 fragment retirement (acceptance criterion 2)', () => {
  it('composes module-cli.md but never the five retired always-on fragments', () => {
    const ag = group('ag-fragment-retire', 'fragment-retire-group');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

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
  it('does not bake a group-only capability snapshot into composed instructions', () => {
    const ag = group('ag-no-group-caps', 'no-group-caps');
    seed(ag);

    composeGroupClaudeMd(ag, 'claude');

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
    it(`flattens local standing instructions into AGENTS.md for ${provider}`, () => {
      const ag = group(`ag-local-${provider}`, `local-${provider}`);
      seed(ag);
      withLocal(ag.folder, `# Group rules\n\n${RULE}\n`);

      composeGroupClaudeMd(ag, provider);

      const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
      expect(agents).toContain(RULE);
    });
  }

  it('creates the local file before flattening so a first spawn is not missing it', () => {
    const ag = group('ag-local-first', 'local-first');
    seed(ag);

    expect(() => composeGroupClaudeMd(ag, 'codex')).not.toThrow();
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'))).toBe(true);
  });

  it('does NOT expand @-includes in the local file (host-side exfiltration guard)', () => {
    // The group folder is mounted RW at /workspace/agent, so a container can
    // write this file. The flattener runs host-side and follows absolute and ~
    // paths, so expanding here would let an agent inline arbitrary host files
    // (e.g. `@~/.env`) into AGENTS.md and read them back through its own mount.
    // A literal, unexpanded reference is the safe failure.
    const secretFile = path.join(TEST_ROOT, 'host-only-secret.txt');
    fs.writeFileSync(secretFile, 'SENTINEL_HOST_SECRET_d41d8cd9\n');

    const ag = group('ag-local-inc', 'local-inc');
    seed(ag);
    withLocal(ag.folder, `@${secretFile}\n`);

    composeGroupClaudeMd(ag, 'codex');

    const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain(`@${secretFile}`);
    expect(agents).not.toContain('SENTINEL_HOST_SECRET_d41d8cd9');
  });

  it('omits the standing-instructions heading when the local file is empty', () => {
    const ag = group('ag-local-empty', 'local-empty');
    seed(ag);
    withLocal(ag.folder, '   \n');

    composeGroupClaudeMd(ag, 'codex');

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
    it(`does not truncate the document for ${provider}`, () => {
      const ag = group(`ag-notrunc-${provider}`, `notrunc-${provider}`);
      seed(ag);
      withHugeLocal(ag.folder);

      composeGroupClaudeMd(ag, provider);

      const agents = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'AGENTS.md'), 'utf-8');
      expect(Buffer.byteLength(agents, 'utf-8')).toBeGreaterThan(40 * 1024);
      expect(agents).not.toContain('## Omitted for size');
    });
  }
});
