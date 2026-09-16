import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('opencode-sync-test') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

// NOT spread: log.ts installs process-wide handlers at module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { syncOpenCodePluginSkills, syncOpenCodeSubagents } from './opencode-sync.js';
import { resolvePluginRoots } from './plugin-skill-discovery.js';
import { splitExcludedPlugins } from './plugin-exclusions.js';
import { copyOpenCodeSkills, excludedOpenCodeSkillNames, mirrorSourceRootsByName } from './providers/opencode.js';

const HOME = path.join(TEST_ROOT, 'home');
const GLOBAL_SKILLS = path.join(HOME, '.config', 'opencode', 'skill');
const GLOBAL_AGENTS = path.join(HOME, '.config', 'opencode', 'agent');

function pluginSkill(plugin: string, name: string): void {
  const dir = path.join(HOME, 'plugins', plugin, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\nBody.\n`);
}

function pluginAgent(plugin: string, name: string, extraFrontmatter = ''): void {
  const dir = path.join(HOME, 'plugins', plugin, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Test agent ${name}.\n${extraFrontmatter}---\n\nYou are ${name}.\n`,
  );
}

/**
 * An agent at the depth the bootstrap plugin actually uses:
 * `~/plugins/<repo>/plugins/<sub>/agents/<name>.md` — where the orchestrate
 * plugin's five `worker-<effort>` shims live, so a walk that only reached
 * `<repo>/agents/` would miss all of them.
 */
function subPluginAgent(repo: string, sub: string, name: string, extraFrontmatter = ''): void {
  const dir = path.join(HOME, 'plugins', repo, 'plugins', sub, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: Test agent ${name}.\n${extraFrontmatter}---\n\nYou are ${name}.\n`,
  );
}

function scopePlugins(plugins: Record<string, string[]>): void {
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'data', 'plugin-scopes.json'), JSON.stringify({ version: 1, plugins }));
}

let homedirSpy: MockInstance<typeof os.homedir>;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(HOME);
  pluginSkill('client-plugin', 'client-skill');
  pluginSkill('shared-plugin', 'shared-skill');
});

afterEach(() => {
  homedirSpy.mockRestore();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('syncOpenCodePluginSkills with workgroup-scoped plugins (src/plugin-scopes.ts)', () => {
  it('mirrors every portable skill when nothing is scoped', () => {
    syncOpenCodePluginSkills();
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(true);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared-skill'))).toBe(true);
  });

  it('never mirrors a scoped plugin skill, and prunes one mirrored before it was scoped', () => {
    syncOpenCodePluginSkills();
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(true);

    scopePlugins({ 'client-plugin': ['client-wg'] });
    syncOpenCodePluginSkills();

    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-skill'))).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared-skill'))).toBe(true);
  });

  it('lets an unscoped plugin keep a skill name a scoped plugin also uses', () => {
    pluginSkill('a-client', 'dup-skill');
    pluginSkill('b-shared', 'dup-skill');
    fs.appendFileSync(path.join(HOME, 'plugins', 'b-shared', 'skills', 'dup-skill', 'SKILL.md'), 'FROM_B_SHARED\n');
    scopePlugins({ 'a-client': ['client-wg'] });

    syncOpenCodePluginSkills();

    expect(fs.readFileSync(path.join(GLOBAL_SKILLS, 'dup-skill', 'SKILL.md'), 'utf-8')).toContain('FROM_B_SHARED');
  });

  it('keeps a scoped plugin skill out of per-sibling targets too', () => {
    const sibling = path.join(HOME, '.local', 'share', 'opencode-client-wg-opencode');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'auth.json'), '{}');
    scopePlugins({ 'client-plugin': ['client-wg'] });

    const result = syncOpenCodePluginSkills();

    expect(result.targets).toContain(path.join(sibling, 'skill'));
    expect(fs.existsSync(path.join(sibling, 'skill', 'client-skill'))).toBe(false);
    expect(fs.existsSync(path.join(sibling, 'skill', 'shared-skill'))).toBe(true);
  });
});

describe('syncOpenCodePluginSkills containment (#829)', () => {
  it('mirrors an in-repo support dir but refuses a child linked out of the plugin', () => {
    // A support dir is a non-skill sibling of a skills root (e.g.
    // workflow-agents/skills/shared/), mirrored as per-child symlinks the
    // session copy later DEREFERENCES into a container. So a child linked out
    // of the plugin would move host-only state across that boundary.
    const support = path.join(HOME, 'plugins', 'shared-plugin', 'skills', 'shared');
    fs.mkdirSync(support, { recursive: true });
    fs.writeFileSync(path.join(support, 'primitives.md'), 'in-repo primitives');
    const secret = path.join(TEST_ROOT, 'host-only-auth.json');
    fs.writeFileSync(secret, 'HOST-ONLY-SECRET');
    fs.symlinkSync(secret, path.join(support, 'stolen.md'));
    // And a child linked into a DIFFERENT plugin, which a union-of-roots
    // boundary would admit.
    fs.symlinkSync(
      path.join(HOME, 'plugins', 'client-plugin', 'skills', 'client-skill', 'SKILL.md'),
      path.join(support, 'cross.md'),
    );

    const result = syncOpenCodePluginSkills();

    const mirrored = path.join(GLOBAL_SKILLS, 'shared');
    expect(fs.existsSync(path.join(mirrored, 'primitives.md'))).toBe(true);
    expect(fs.existsSync(path.join(mirrored, 'stolen.md'))).toBe(false);
    expect(fs.existsSync(path.join(mirrored, 'cross.md'))).toBe(false);
    expect(result.refused).toEqual(expect.arrayContaining(['shared/stolen.md', 'shared/cross.md']));
  });

  it('refuses a link NESTED inside a support dir that reaches another plugin', () => {
    // End to end: sync the mirror, then copy it as a spawn does. The support
    // dir's `sub/` is a real in-repo directory, so the writer links it whole and
    // never resolves what is under it — the record it left is what holds the
    // nested link to this plugin.
    const support = path.join(HOME, 'plugins', 'shared-plugin', 'skills', 'shared', 'sub');
    fs.mkdirSync(support, { recursive: true });
    fs.writeFileSync(path.join(support, 'own.md'), 'in-repo primitives');
    fs.symlinkSync(
      path.join(HOME, 'plugins', 'client-plugin', 'skills', 'client-skill', 'SKILL.md'),
      path.join(support, 'cross.md'),
    );

    syncOpenCodePluginSkills();

    // The widest inputs a spawn ever passes — every plugin root allowed, no
    // walk attribution — so the record this sync wrote is the only thing that
    // can refuse the cross-plugin link.
    const xdg = path.join(TEST_ROOT, 'xdg');
    copyOpenCodeSkills(GLOBAL_SKILLS, xdg, {
      allowedRoots: resolvePluginRoots(path.join(HOME, 'plugins')),
      sourceRootsByName: new Map(),
    });

    expect(fs.readFileSync(path.join(xdg, 'shared', 'sub', 'own.md'), 'utf-8')).toBe('in-repo primitives');
    expect(fs.existsSync(path.join(xdg, 'shared', 'sub', 'cross.md'))).toBe(false);
  });

  it('never treats the PLUGINS ROOT as a skills root, so a sibling repo is not published as a support dir', () => {
    // A single-skill repo's skill dir IS its repo root (discovery rule 3), so
    // its parent is ~/plugins. Treating that as a skills root made every other
    // repository without a root SKILL.md a "support dir" — published whole into
    // the shared mirror, workgroup scoping and all, since this path never
    // consults the deny set.
    const single = path.join(HOME, 'plugins', 'single-skill-repo');
    fs.mkdirSync(single, { recursive: true });
    fs.writeFileSync(
      path.join(single, 'SKILL.md'),
      '---\nname: single-skill-repo\ndescription: A single-skill repo.\n---\n\nBody.\n',
    );
    const clientDoc = path.join(HOME, 'plugins', 'client-plugin', 'domain', 'client.md');
    fs.mkdirSync(path.dirname(clientDoc), { recursive: true });
    fs.writeFileSync(clientDoc, 'CLIENT-TENANT-DATA');
    scopePlugins({ 'client-plugin': ['client-wg'] });

    syncOpenCodePluginSkills();

    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'client-plugin'))).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared-plugin'))).toBe(false);
    // The single-skill repo's own skill is still mirrored.
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'single-skill-repo', 'SKILL.md'))).toBe(true);
  });

  it('attributes a name to the plugin the MIRROR published it from, not to a scoped one', () => {
    // Discovery keeps the first plugin to claim a name, alphabetically. A walk
    // that denied less than the mirror's would name `a-client` as the owner of
    // `dup-skill`, so a legacy dir published from `b-shared` would be contained
    // to a scoped plugin's repository — refusing its own links and admitting
    // links into the scoped one, which is the escape this fix closes.
    pluginSkill('a-client', 'dup-skill');
    pluginSkill('b-shared', 'dup-skill');
    scopePlugins({ 'a-client': ['client-wg'] });

    const roots = mirrorSourceRootsByName(path.join(HOME, 'plugins'));

    expect(roots.get('dup-skill')).toBe(fs.realpathSync(path.join(HOME, 'plugins', 'b-shared')));
  });

  it('records the source repository in every mirror dir it writes, skills and support dirs alike', () => {
    const support = path.join(HOME, 'plugins', 'shared-plugin', 'skills', 'shared');
    fs.mkdirSync(support, { recursive: true });
    fs.writeFileSync(path.join(support, 'primitives.md'), 'in-repo primitives');

    syncOpenCodePluginSkills();

    const expected = `${JSON.stringify(fs.realpathSync(path.join(HOME, 'plugins', 'shared-plugin')))}\n`;
    expect(fs.readFileSync(path.join(GLOBAL_SKILLS, 'shared-skill', '.nanoclaw-source-root'), 'utf-8')).toBe(expected);
    expect(fs.readFileSync(path.join(GLOBAL_SKILLS, 'shared', '.nanoclaw-source-root'), 'utf-8')).toBe(expected);
    // The support dir must NOT read as a managed skill mirror, or the cleanup
    // pass would delete it on every sync (its name is no skill's).
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared', '.nanoclaw-managed'))).toBe(false);
    syncOpenCodePluginSkills();
    expect(fs.existsSync(path.join(GLOBAL_SKILLS, 'shared', 'primitives.md'))).toBe(true);
  });
});

describe('excludedOpenCodeSkillNames walks the mirror population (#836)', () => {
  const subPluginSkill = (repo: string, sub: string, name: string): void => {
    const dir = path.join(HOME, 'plugins', repo, 'plugins', sub);
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: sub }));
    const skillDir = path.join(dir, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody.\n`);
  };

  it('drops an excluded sub-plugin skill whose name a SCOPED plugin also claims', () => {
    // `a-client` sorts first, so with the default deny set it wins discovery's
    // first-plugin-wins dedup for `dup-skill` — it is not under an excluded
    // path, so the name is not dropped. But the MIRROR denied it for being
    // workgroup-scoped and published the excluded sub-plugin's directory under
    // that name, so the group receives the excluded source: the exclusion
    // inverted by two walks disagreeing about one population.
    pluginSkill('a-client', 'dup-skill');
    subPluginSkill('mono', 'alpha', 'dup-skill');
    scopePlugins({ 'a-client': ['client-wg'] });

    const dropped = excludedOpenCodeSkillNames(
      path.join(HOME, 'plugins'),
      splitExcludedPlugins(['mono/plugins/alpha']),
    );

    expect(dropped.has('dup-skill')).toBe(true);
    // And the mirror really does hold the excluded source under that name.
    syncOpenCodePluginSkills();
    expect(fs.readFileSync(path.join(GLOBAL_SKILLS, 'dup-skill', '.nanoclaw-source-root'), 'utf-8')).toBe(
      `${JSON.stringify(fs.realpathSync(path.join(HOME, 'plugins', 'mono')))}\n`,
    );
  });

  it('still drops nothing for a group with no sub-path entry, which is every group today', () => {
    subPluginSkill('mono', 'alpha', 'alpha-skill');
    expect(excludedOpenCodeSkillNames(path.join(HOME, 'plugins'), splitExcludedPlugins(['mono'])).size).toBe(0);
    expect(excludedOpenCodeSkillNames(path.join(HOME, 'plugins'), splitExcludedPlugins(undefined)).size).toBe(0);
  });
});

describe('syncOpenCodeSubagents with workgroup-scoped plugins (src/plugin-scopes.ts)', () => {
  it('never mirrors a scoped plugin agent, and prunes one mirrored before it was scoped', () => {
    pluginAgent('client-plugin', 'client-agent');
    pluginAgent('shared-plugin', 'shared-agent');
    syncOpenCodeSubagents();
    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'client-agent.md'))).toBe(true);

    scopePlugins({ 'client-plugin': ['client-wg'] });
    syncOpenCodeSubagents();

    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'client-agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'shared-agent.md'))).toBe(true);
  });
});

describe('syncOpenCodeSubagents carries the delegation shims', () => {
  const read = (name: string) => fs.readFileSync(path.join(GLOBAL_AGENTS, `${name}.md`), 'utf8');

  it('finds an agent nested at <repo>/plugins/<sub>/agents/, where the shims live', () => {
    subPluginAgent('bootstrap', 'orchestrate', 'worker-high', 'model: inherit\neffort: high\n');
    expect(syncOpenCodeSubagents().discovered).toBe(1);
    expect(fs.existsSync(path.join(GLOBAL_AGENTS, 'worker-high.md'))).toBe(true);
  });

  it('writes `effort:` through as options.reasoningEffort, the provider option', () => {
    subPluginAgent('bootstrap', 'orchestrate', 'worker-low', 'model: inherit\neffort: low\n');
    syncOpenCodeSubagents();
    // Nested under `options:`, which OpenCode's v1 agent schema merges into the
    // provider model options (packages/core/src/v1/config/agent.ts, `normalize`).
    expect(read('worker-low')).toContain('options:\n  reasoningEffort: "low"\n');
  });

  it('never writes `model: inherit` — OpenCode inherits the parent when the key is unset', () => {
    subPluginAgent('bootstrap', 'orchestrate', 'worker-max', 'model: inherit\neffort: max\n');
    syncOpenCodeSubagents();
    const out = read('worker-max');
    expect(out).not.toMatch(/^model:/m);
    expect(out).not.toContain('inherit');
  });

  it('emits no options block for an agent with no effort', () => {
    pluginAgent('shared-plugin', 'plain-agent');
    syncOpenCodeSubagents();
    const out = read('plain-agent');
    expect(out).not.toContain('options:');
    expect(out).not.toContain('reasoningEffort');
  });

  it('rewrites an already-mirrored agent when only its effort changed', () => {
    // The sync compares rendered bytes against what is on disk, so an effort
    // flip must produce different bytes or the shim would keep its old effort
    // forever with the sync reporting "unchanged".
    subPluginAgent('bootstrap', 'orchestrate', 'worker-medium', 'model: inherit\neffort: medium\n');
    syncOpenCodeSubagents();
    expect(read('worker-medium')).toContain('reasoningEffort: "medium"');

    subPluginAgent('bootstrap', 'orchestrate', 'worker-medium', 'model: inherit\neffort: xhigh\n');
    const second = syncOpenCodeSubagents();
    expect(second.writes).toBeGreaterThan(0);
    expect(read('worker-medium')).toContain('reasoningEffort: "xhigh"');
  });
});
