#!/usr/bin/env tsx
/**
 * Enable a `~/plugins/<name>` plugin across all three container agent providers
 * (Claude, Codex, OpenCode) — the deterministic half of the /enable-agent-plugins
 * skill.
 *
 * What this does NOT do: NanoClaw containers never run Codex's or OpenCode's
 * native plugin systems (no `.codex-plugin`/`opencode.json` loader fires here),
 * so there is nothing to "install" for those. Parity is achieved on NanoClaw's
 * own surfaces instead:
 *
 *   - Claude   → the mount + CLAUDE_PLUGINS_ROOT auto-loads the plugin, but ONLY
 *                if it carries a Claude manifest. We generate a minimal
 *                `.claude-plugin/plugin.json` when one is missing (the taste-skill gap).
 *   - Codex    → portable `skills/<n>/SKILL.md` mirror into `~/.agents/skills/`.
 *   - OpenCode → same skills mirror into `~/.config/opencode/skill/`.
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
 *   pnpm exec tsx scripts/enable-agent-plugin.ts ponytail --report-json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoverPortableSkills } from '../src/plugin-skill-discovery.js';
import { syncCodexPluginSkills } from '../src/codex-sync.js';
import { syncOpenCodePluginSkills } from '../src/opencode-sync.js';
import { readContainerConfig, writeContainerConfig } from '../src/container-config.js';
import { GROUPS_DIR } from '../src/config.js';

const PLUGINS_ROOT = path.join(os.homedir(), 'plugins');

interface Classification {
  name: string;
  dir: string;
  hasClaudeManifest: boolean;
  generatedManifest: boolean;
  portableSkills: string[];
  sessionStartHook: boolean;
  hasAlwaysOnFile: boolean;
  alwaysOnIsStub: boolean;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(): { target: string; exclude: string[]; dryRun: boolean; reportJson: boolean } {
  const argv = process.argv.slice(2);
  let target = '';
  let exclude: string[] = [];
  let dryRun = false;
  let reportJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--report-json') reportJson = true;
    else if (a === '--exclude') exclude = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith('--') && !target) target = a;
    else die(`unexpected argument: ${a}`);
  }
  if (!target) die('usage: enable-agent-plugin.ts <name|path> [--exclude g1,g2] [--dry-run]');
  return { target, exclude, dryRun, reportJson };
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
  const { target, exclude, dryRun, reportJson } = parseArgs();
  const { name, dir } = resolvePluginDir(target);

  const generatedManifest = generateClaudeManifest(dir, name, dryRun);
  const hasClaudeManifest =
    generatedManifest ||
    fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')) ||
    fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'));

  const portableSkills = discoverPortableSkills(PLUGINS_ROOT, { runtime: 'opencode' })
    .filter((s) => s.plugin === name)
    .map((s) => s.name);

  const alwaysOnPath = path.join(dir, '.nanoclaw-always-on.md');
  const hasAlwaysOnFile = fs.existsSync(alwaysOnPath);
  const alwaysOnIsStub = hasAlwaysOnFile && fs.readFileSync(alwaysOnPath, 'utf-8').trim().length === 0;

  const classification: Classification = {
    name,
    dir,
    hasClaudeManifest,
    generatedManifest,
    portableSkills,
    sessionStartHook: detectSessionStartHook(dir),
    hasAlwaysOnFile,
    alwaysOnIsStub,
  };

  // Mirror skills to Codex + OpenCode discovery paths (idempotent).
  let codexCreated = 0;
  let opencodeCreated = 0;
  if (!dryRun) {
    codexCreated = syncCodexPluginSkills().created.length;
    opencodeCreated = syncOpenCodePluginSkills().created;
  }

  const optedOut = applyOptOut(exclude, name, dryRun);

  if (reportJson) {
    console.log(JSON.stringify({ ...classification, optedOut, codexCreated, opencodeCreated, dryRun }, null, 2));
    return;
  }

  const needsRuleset = classification.sessionStartHook && (!hasAlwaysOnFile || alwaysOnIsStub);
  console.log(`\n${dryRun ? '[dry-run] ' : ''}enable-agent-plugin: ${name}`);
  console.log(`  dir:               ${dir}`);
  console.log(`  Claude manifest:   ${hasClaudeManifest ? 'present' : 'MISSING'}${generatedManifest ? ' (generated)' : ''}`);
  console.log(`  portable skills:   ${portableSkills.length}${portableSkills.length ? ` (${portableSkills.join(', ')})` : ''}`);
  console.log(`  skills mirrored:   codex +${codexCreated}, opencode +${opencodeCreated}`);
  console.log(`  always-on plugin:  ${classification.sessionStartHook ? 'yes (has SessionStart hook)' : 'no (skills-only)'}`);
  console.log(`  ruleset file:      ${hasAlwaysOnFile ? (alwaysOnIsStub ? 'present but EMPTY' : 'present') : 'absent'}`);
  if (optedOut.length) console.log(`  opted out:         ${optedOut.join(', ')}`);
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
