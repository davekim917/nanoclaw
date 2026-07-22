#!/usr/bin/env tsx
/**
 * Enable a `~/plugins/<name>` plugin across all three container agent providers
 * (Claude, Codex, OpenCode) — the deterministic half of the /enable-agent-plugins
 * skill.
 *
 * Each provider gets its own native delivery path:
 *
 *   - Claude   → the mount + CLAUDE_PLUGINS_ROOT auto-loads the plugin, but ONLY
 *                if it carries a Claude manifest. We generate a minimal
 *                `.claude-plugin/plugin.json` when one is missing (the taste-skill gap).
 *   - Codex    → native `codex plugin` loading. We generate `.codex-plugin/plugin.json`
 *                and a self-referencing `.agents/plugins/marketplace.json` when either
 *                is missing, then report the `codex plugin marketplace add` / `codex
 *                plugin add` commands the caller must run (this script never mutates
 *                Codex's own state).
 *   - OpenCode → portable `skills/<n>/SKILL.md` mirror into `~/.config/opencode/skill/`
 *                (and per-sibling XDG dirs). OpenCode has no plugin loader, so the
 *                mirror is its only delivery path.
 *
 * Per-provider opt-out is controlled by `~/plugins/<name>/.nanoclaw-plugin.json`
 * (`{ "denySiblings": [...] }`, read by `readPluginDenySiblings`). `--deny`/`--allow`
 * mutate that marker.
 *
 * Always-on rulesets (plugins like ponytail that inject a system prompt every
 * turn) reach Codex/OpenCode via `~/plugins/<name>/.nanoclaw-always-on.md`, which
 * `composeGroupClaudeMd` folds into non-Claude groups' CLAUDE.md/AGENTS.md. This
 * script does NOT author that file — it only reports whether the plugin looks
 * like an always-on plugin, so the skill can author a clean ruleset (stripping
 * runtime banners/host-specific nudges a raw hook dump would carry).
 *
 * Usage:
 *   pnpm exec tsx scripts/enable-agent-plugin.ts <name|path> [--exclude g1,g2] [--dry-run]
 *   pnpm exec tsx scripts/enable-agent-plugin.ts <name|path> [--deny csv] [--allow csv]
 *   pnpm exec tsx scripts/enable-agent-plugin.ts ponytail --report-json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoverPortableSkills, readPluginDenySiblings, type AgentRuntime } from '../src/plugin-skill-discovery.js';
import { syncOpenCodePluginSkills } from '../src/opencode-sync.js';
import { readContainerConfig, writeContainerConfig } from '../src/container-config.js';
import { GROUPS_DIR } from '../src/config.js';

const PLUGINS_ROOT = path.join(os.homedir(), 'plugins');
const VALID_RUNTIMES = new Set<AgentRuntime>(['claude', 'codex', 'opencode']);
const CODEX_SKILLS_ROOT_CANDIDATES = ['.agents/skills', 'skills', 'plugin/skills'];

interface Classification {
  name: string;
  dir: string;
  denySiblings: AgentRuntime[];
  hasClaudeManifest: boolean;
  generatedManifest: boolean;
  codexSkillsRoot: string | null;
  codexManifestGenerated: boolean;
  codexMarketplaceGenerated: boolean;
  codexRegistered: boolean;
  codexCommands: string[];
  portableSkills: string[];
  sessionStartHook: boolean;
  hasAlwaysOnFile: boolean;
  alwaysOnIsStub: boolean;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

interface ParsedArgs {
  target: string;
  exclude: string[];
  deny: AgentRuntime[];
  allow: AgentRuntime[];
  dryRun: boolean;
  reportJson: boolean;
}

function parseRuntimeList(csv: string, flag: string): AgentRuntime[] {
  const values = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const v of values) {
    if (!VALID_RUNTIMES.has(v as AgentRuntime)) die(`invalid value for ${flag}: ${v} (expected claude|codex|opencode)`);
  }
  return values as AgentRuntime[];
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let target = '';
  let exclude: string[] = [];
  let deny: AgentRuntime[] = [];
  let allow: AgentRuntime[] = [];
  let dryRun = false;
  let reportJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--report-json') reportJson = true;
    else if (a === '--exclude') exclude = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--deny') deny = parseRuntimeList(argv[++i] ?? '', '--deny');
    else if (a === '--allow') allow = parseRuntimeList(argv[++i] ?? '', '--allow');
    else if (!a.startsWith('--') && !target) target = a;
    else die(`unexpected argument: ${a}`);
  }
  if (!target) {
    die('usage: enable-agent-plugin.ts <name|path> [--exclude g1,g2] [--deny csv] [--allow csv] [--dry-run]');
  }
  return { target, exclude, deny, allow, dryRun, reportJson };
}

/** Resolve a name or path to a real directory under ~/plugins. */
function resolvePluginDir(target: string): { name: string; dir: string } {
  const abs = path.resolve(target.startsWith('~') ? target.replace(/^~/, os.homedir()) : target);
  // Bare name?
  const asName = path.join(PLUGINS_ROOT, target);
  const dir = fs.existsSync(asName) && fs.statSync(asName).isDirectory() ? asName : abs;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    die(`not a directory: ${dir}`);
  }
  const parent = path.dirname(path.resolve(dir));
  if (path.resolve(parent) !== path.resolve(PLUGINS_ROOT)) {
    die(
      `plugin must live directly under ${PLUGINS_ROOT} (containers only mount ~/plugins/*).\n` +
        `  got: ${dir}\n  fix: clone it there, e.g. \`git clone <url> ${path.join(PLUGINS_ROOT, path.basename(dir))}\``,
    );
  }
  return { name: path.basename(dir), dir };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Apply `--deny`/`--allow` to the on-disk `.nanoclaw-plugin.json` marker.
 * Writes only when the resulting set differs from what's on disk (idempotent
 * no-flags re-runs never touch the file); `--dry-run` computes but never writes.
 * An empty resulting set still writes `{ "denySiblings": [] }` rather than
 * deleting the file, so an explicit "allow everything" stays recorded.
 */
function resolveDenySiblings(
  dir: string,
  denyFlags: AgentRuntime[],
  allowFlags: AgentRuntime[],
  dryRun: boolean,
): Set<AgentRuntime> {
  const onDisk = readPluginDenySiblings(dir);
  const next = new Set(onDisk);
  for (const v of denyFlags) next.add(v);
  for (const v of allowFlags) next.delete(v);

  if (!setsEqual(onDisk, next) && !dryRun) {
    const markerPath = path.join(dir, '.nanoclaw-plugin.json');
    fs.writeFileSync(markerPath, JSON.stringify({ denySiblings: [...next].sort() }, null, 2) + '\n');
  }
  return next;
}

/** Does any hooks JSON declared by the plugin contain a SessionStart entry? */
function detectSessionStartHook(dir: string): boolean {
  const candidates: string[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')) as {
      hooks?: string;
    };
    if (typeof manifest.hooks === 'string') candidates.push(path.resolve(dir, manifest.hooks));
  } catch {
    /* no manifest / no hooks field */
  }
  // Common conventional hook files.
  for (const rel of ['hooks/claude-codex-hooks.json', 'hooks/hooks.json']) {
    candidates.push(path.join(dir, rel));
  }
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { hooks?: Record<string, unknown> };
      if (parsed.hooks && Object.keys(parsed.hooks).some((k) => k.toLowerCase() === 'sessionstart')) return true;
    } catch {
      /* missing / malformed — skip */
    }
  }
  return false;
}

function generateClaudeManifest(dir: string, name: string, dryRun: boolean): boolean {
  const manifestPath = path.join(dir, '.claude-plugin', 'plugin.json');
  const marketplacePath = path.join(dir, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(manifestPath) || fs.existsSync(marketplacePath)) return false;

  // Minimal functional manifest. Claude auto-discovers skills/, commands/,
  // agents/ by convention; a non-conventional hooks file must be declared.
  const manifest: Record<string, unknown> = {
    name,
    version: '0.0.0',
    description: `Agent plugin: ${name}`,
  };
  for (const rel of ['hooks/claude-codex-hooks.json', 'hooks/hooks.json']) {
    if (fs.existsSync(path.join(dir, rel))) {
      manifest.hooks = `./${rel}`;
      break;
    }
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return true;
}

/** First existing candidate skills root, relative to the plugin dir (posix-style). */
function findCodexSkillsRoot(dir: string): string | null {
  for (const rel of CODEX_SKILLS_ROOT_CANDIDATES) {
    if (isDirectory(path.join(dir, rel))) return rel;
  }
  return null;
}

/** NanoClaw-owned, git-untracked skills root we materialize into when upstream symlinks SKILL.md. */
const CODEX_MATERIALIZED_ROOT = path.join('.nanoclaw', 'codex-skills');

/**
 * Codex's native plugin loader silently skips a skill whose `SKILL.md` is a SYMLINK
 * (verified in-container 2026-07-22: humanizer ships `skills/humanizer/SKILL.md ->
 * ../../SKILL.md` and loaded 0 skills, while impeccable's real file loaded fine).
 * Some upstreams ship exactly that shape to keep a root-level SKILL.md as the source
 * of truth.
 *
 * When we detect it, materialize a real skills tree under `<plugin>/.nanoclaw/codex-skills/`
 * — a real dir per skill with a REAL SKILL.md copy plus symlinks for any sibling files —
 * and point the generated manifest there. Same technique the OpenCode mirror already uses.
 * The path is inside the plugin clone but under our own `.nanoclaw/` namespace, so it stays
 * untracked by the plugin's git and never conflicts with `git pull`.
 *
 * Returns the skills root to use (the materialized one, or the original when no symlink).
 */
function materializeSymlinkedSkills(dir: string, skillsRoot: string, dryRun: boolean): string {
  const srcRoot = path.join(dir, skillsRoot);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(srcRoot);
  } catch {
    return skillsRoot;
  }
  const symlinked = entries.filter((e) => {
    try {
      return fs.lstatSync(path.join(srcRoot, e, 'SKILL.md')).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (symlinked.length === 0) return skillsRoot;
  if (dryRun) return CODEX_MATERIALIZED_ROOT;

  for (const skill of entries) {
    const from = path.join(srcRoot, skill);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;
    const to = path.join(dir, CODEX_MATERIALIZED_ROOT, skill);
    fs.mkdirSync(to, { recursive: true });
    for (const child of fs.readdirSync(from)) {
      const childSrc = path.join(from, child);
      const childDst = path.join(to, child);
      try {
        fs.rmSync(childDst, { recursive: true, force: true });
        if (child === 'SKILL.md') {
          // Real copy — the whole point: Codex must see a regular file here.
          fs.writeFileSync(childDst, fs.readFileSync(childSrc));
        } else {
          fs.symlinkSync(fs.realpathSync(childSrc), childDst);
        }
      } catch {
        /* best-effort per child; a partial skill dir is still better than none */
      }
    }
  }
  return CODEX_MATERIALIZED_ROOT;
}

function ensureCodexPluginManifest(dir: string, name: string, skillsRoot: string, dryRun: boolean): boolean {
  const manifestPath = path.join(dir, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) return false;
  const manifest = {
    name,
    version: '0.0.0',
    description: `Agent plugin: ${name}`,
    skills: `./${skillsRoot}/`,
  };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return true;
}

interface CodexMarketplaceSelfEntry {
  marketplaceName: string;
  pluginEntryName: string;
}

/** Parse an existing codex marketplace.json and find its self-referencing entry (source path `./` or `.`). */
function parseCodexMarketplaceSelfEntry(marketplacePath: string): CodexMarketplaceSelfEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(marketplacePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      plugins?: Array<{ name?: unknown; source?: { source?: unknown; path?: unknown } }>;
    };
    const marketplaceName = typeof parsed.name === 'string' ? parsed.name : null;
    const selfEntry = Array.isArray(parsed.plugins)
      ? parsed.plugins.find(
          (p) => p?.source?.source === 'local' && (p.source?.path === './' || p.source?.path === '.'),
        )
      : undefined;
    if (!marketplaceName || !selfEntry || typeof selfEntry.name !== 'string') return null;
    return { marketplaceName, pluginEntryName: selfEntry.name };
  } catch {
    return null;
  }
}

interface CodexRegistration {
  skillsRoot: string | null;
  manifestGenerated: boolean;
  marketplaceGenerated: boolean;
  registered: boolean;
  commands: string[];
  reason: string | null;
}

/** Codex-native registration: generate `.codex-plugin/plugin.json` + a self-referencing
 * marketplace.json when missing, then report (never execute) the `codex plugin` commands. */
function resolveCodexRegistration(dir: string, name: string, dryRun: boolean): CodexRegistration {
  const discoveredRoot = findCodexSkillsRoot(dir);
  const skillsRoot = discoveredRoot === null ? null : materializeSymlinkedSkills(dir, discoveredRoot, dryRun);
  if (skillsRoot === null) {
    return {
      skillsRoot: null,
      manifestGenerated: false,
      marketplaceGenerated: false,
      registered: false,
      commands: [],
      reason: 'no skills root found under .agents/skills, skills, or plugin/skills',
    };
  }

  const manifestGenerated = ensureCodexPluginManifest(dir, name, skillsRoot, dryRun);

  // The marketplace entry name MUST match the name inside .codex-plugin/plugin.json —
  // Codex hard-errors otherwise ("plugin.json name `wix` does not match marketplace
  // plugin name `skills`"). A pre-existing manifest can declare a name that differs
  // from the folder (wix ships in ~/plugins/skills), so read it rather than assuming.
  let entryName = name;
  try {
    const declared = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf-8')) as {
      name?: unknown;
    };
    if (typeof declared.name === 'string' && declared.name.trim()) entryName = declared.name.trim();
  } catch {
    // No manifest on disk yet (dry-run, or we just generated one keyed to `name`).
  }

  const marketplacePath = path.join(dir, '.agents', 'plugins', 'marketplace.json');
  let marketplaceGenerated = false;
  let self: CodexMarketplaceSelfEntry | null;
  let reason: string | null = null;

  if (!fs.existsSync(marketplacePath)) {
    marketplaceGenerated = true;
    self = { marketplaceName: name, pluginEntryName: entryName };
    if (!dryRun) {
      fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
      fs.writeFileSync(
        marketplacePath,
        JSON.stringify(
          { name, plugins: [{ name: entryName, source: { source: 'local', path: './' } }] },
          null,
          2,
        ) + '\n',
      );
    }
  } else {
    self = parseCodexMarketplaceSelfEntry(marketplacePath);
    if (!self) reason = 'existing marketplace.json has no self-referencing entry';
  }

  const commands = self
    ? [`codex plugin marketplace add ${dir}`, `codex plugin add ${self.pluginEntryName}@${self.marketplaceName}`]
    : [];

  return { skillsRoot, manifestGenerated, marketplaceGenerated, registered: self !== null, commands, reason };
}

/** Denied for codex: never generate anything, but surface the removal command if a marketplace entry exists. */
function resolveCodexRemoval(dir: string): string[] {
  const marketplacePath = path.join(dir, '.agents', 'plugins', 'marketplace.json');
  if (!fs.existsSync(marketplacePath)) return [];
  const self = parseCodexMarketplaceSelfEntry(marketplacePath);
  return self ? [`codex plugin remove ${self.pluginEntryName}@${self.marketplaceName}`] : [];
}

function applyOptOut(exclude: string[], pluginName: string, dryRun: boolean): string[] {
  const applied: string[] = [];
  for (const folder of exclude) {
    const groupDir = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      console.warn(`  opt-out: group folder not found, skipped: ${folder}`);
      continue;
    }
    const cfg = readContainerConfig(folder);
    const set = new Set(cfg.excludePlugins ?? []);
    if (set.has(pluginName)) continue;
    set.add(pluginName);
    if (!dryRun) writeContainerConfig(folder, { ...cfg, excludePlugins: [...set] });
    applied.push(folder);
  }
  return applied;
}

function main(): void {
  const { target, exclude, deny: denyFlags, allow: allowFlags, dryRun, reportJson } = parseArgs();
  const { name, dir } = resolvePluginDir(target);

  const deny = resolveDenySiblings(dir, denyFlags, allowFlags, dryRun);

  const generatedManifest = deny.has('claude') ? false : generateClaudeManifest(dir, name, dryRun);
  const hasClaudeManifest =
    generatedManifest ||
    fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')) ||
    fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'));

  const codexReg: CodexRegistration = deny.has('codex')
    ? {
        skillsRoot: null,
        manifestGenerated: false,
        marketplaceGenerated: false,
        registered: false,
        commands: resolveCodexRemoval(dir),
        reason: null,
      }
    : resolveCodexRegistration(dir, name, dryRun);

  const portableSkills = discoverPortableSkills(PLUGINS_ROOT, { runtime: 'opencode' })
    .filter((s) => s.plugin === name)
    .map((s) => s.name);

  const alwaysOnPath = path.join(dir, '.nanoclaw-always-on.md');
  const hasAlwaysOnFile = fs.existsSync(alwaysOnPath);
  const alwaysOnIsStub = hasAlwaysOnFile && fs.readFileSync(alwaysOnPath, 'utf-8').trim().length === 0;

  const classification: Classification = {
    name,
    dir,
    denySiblings: [...deny].sort(),
    hasClaudeManifest,
    generatedManifest,
    codexSkillsRoot: codexReg.skillsRoot,
    codexManifestGenerated: codexReg.manifestGenerated,
    codexMarketplaceGenerated: codexReg.marketplaceGenerated,
    codexRegistered: codexReg.registered,
    codexCommands: codexReg.commands,
    portableSkills,
    sessionStartHook: detectSessionStartHook(dir),
    hasAlwaysOnFile,
    alwaysOnIsStub,
  };

  // Mirror skills to OpenCode's discovery path (idempotent). Codex now loads
  // natively (see resolveCodexRegistration above) — no mirror needed for it.
  let opencodeCreated = 0;
  if (!dryRun) {
    opencodeCreated = syncOpenCodePluginSkills().created;
  }

  const optedOut = applyOptOut(exclude, name, dryRun);

  if (reportJson) {
    console.log(JSON.stringify({ ...classification, optedOut, opencodeCreated, dryRun }, null, 2));
    return;
  }

  const needsRuleset = classification.sessionStartHook && (!hasAlwaysOnFile || alwaysOnIsStub);
  console.log(`\n${dryRun ? '[dry-run] ' : ''}enable-agent-plugin: ${name}`);
  console.log(`  dir:               ${dir}`);
  console.log(
    `  deny siblings:     ${classification.denySiblings.length ? classification.denySiblings.join(', ') : '(none — delivered to all three)'}`,
  );
  console.log(`  Claude manifest:   ${hasClaudeManifest ? 'present' : 'MISSING'}${generatedManifest ? ' (generated)' : ''}`);
  if (deny.has('codex')) {
    console.log(`  Codex:             denied (sibling opt-out)`);
  } else if (codexReg.skillsRoot === null) {
    console.log(`  Codex:             skipped — ${codexReg.reason}`);
  } else {
    console.log(`  Codex skills root: ${codexReg.skillsRoot}`);
    console.log(
      `  Codex manifest:    ${codexReg.manifestGenerated ? 'generated' : 'present'}, marketplace: ${codexReg.marketplaceGenerated ? 'generated' : codexReg.registered ? 'present' : `MISSING SELF ENTRY (${codexReg.reason})`}`,
    );
  }
  console.log(`  portable skills:   ${portableSkills.length}${portableSkills.length ? ` (${portableSkills.join(', ')})` : ''}`);
  console.log(`  skills mirrored:   opencode +${opencodeCreated}`);
  console.log(`  always-on plugin:  ${classification.sessionStartHook ? 'yes (has SessionStart hook)' : 'no (skills-only)'}`);
  console.log(`  ruleset file:      ${hasAlwaysOnFile ? (alwaysOnIsStub ? 'present but EMPTY' : 'present') : 'absent'}`);
  if (optedOut.length) console.log(`  opted out:         ${optedOut.join(', ')}`);
  if (codexReg.commands.length) {
    console.log('\n  codex commands to run (not executed by this script):');
    for (const cmd of codexReg.commands) console.log(`    ${cmd}`);
  }
  console.log('\n  next steps:');
  if (needsRuleset) {
    console.log(`    1. Author ${path.join(dir, '.nanoclaw-always-on.md')} with the plugin's clean always-on`);
    console.log(`       ruleset (strip runtime banners / host-only nudges). The skill does this.`);
    console.log(`    2. pnpm run build   # composer is host src/`);
    console.log(`    3. restart the host to respawn containers`);
  } else if (classification.sessionStartHook) {
    console.log(`    1. pnpm run build && restart host  (ruleset already present)`);
  } else {
    console.log(`    skills-only — already live on all 3 providers on next spawn. No build needed`);
    console.log(`    unless a Claude manifest was generated (then: restart host).`);
  }
}

main();
