#!/usr/bin/env tsx
/**
 * Enable a `~/plugins/<name>` plugin across the three container agent providers — the
 * deterministic half of the /enable-agent-plugins skill:
 *
 *   - Claude   → auto-loaded via the mount, but ONLY with a Claude manifest; a minimal one is
 *                generated when missing.
 *   - Codex    → registered by the CONTAINER at spawn; this only generates the
 *                `.codex-plugin/plugin.json` and self-referencing marketplace.json it needs.
 *   - OpenCode → skills mirrored into `~/.config/opencode/skill/` (no plugin loader).
 *
 * Container agent groups only: never touches host CLI plugin state, since containers strip
 * every inherited `[plugins.*]` / `[marketplaces.*]` table from the host Codex config.
 * Per-provider opt-out lives in `~/plugins/<name>/.nanoclaw-plugin.json` (`--deny`/`--allow`).
 *
 * Usage:
 *   pnpm exec tsx scripts/enable-agent-plugin.ts <name|path> [--exclude g1,g2] [--dry-run]
 *   pnpm exec tsx scripts/enable-agent-plugin.ts <name|path> [--deny csv] [--allow csv]
 *   pnpm exec tsx scripts/enable-agent-plugin.ts ponytail --report-json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readPluginDenySiblings, type AgentRuntime } from '../src/plugin-skill-discovery.js';
import { findCodexSkillsRoot, materializeSymlinkedSkills } from '../src/codex-skill-materialize.js';
import { openCodeMirrorSkills, syncOpenCodePluginSkills } from '../src/opencode-sync.js';
import { readContainerConfig, updateContainerConfig } from '../src/container-config.js';
import { GROUPS_DIR } from '../src/config.js';

const PLUGINS_ROOT = path.join(os.homedir(), 'plugins');
const VALID_RUNTIMES = new Set<AgentRuntime>(['claude', 'codex', 'opencode']);

interface Classification {
  name: string;
  dir: string;
  denySiblings: AgentRuntime[];
  hasClaudeManifest: boolean;
  generatedManifest: boolean;
  codexSkillsRoot: string | null;
  codexManifestGenerated: boolean;
  codexMarketplaceGenerated: boolean;
  codexRegisterable: boolean;
  portableSkills: string[];
  sessionStartHook: boolean;
  hasAlwaysOnFile: boolean;
  alwaysOnIsStub: boolean;
  /** The plugin carries its OWN generic `always-on.md` — no override wanted. */
  hasOwnRuleset: boolean;
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
    else if (a === '--exclude')
      exclude = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
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

function resolvePluginDir(target: string): { name: string; dir: string } {
  const abs = path.resolve(target.startsWith('~') ? target.replace(/^~/, os.homedir()) : target);
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
 * Writes only when the set changes, and writes `{ "denySiblings": [] }` rather than deleting
 * the file, so an explicit "allow everything" stays recorded.
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

  // Claude auto-discovers skills/, commands/, agents/; a non-conventional hooks file must be declared.
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
      ? parsed.plugins.find((p) => p?.source?.source === 'local' && (p.source?.path === './' || p.source?.path === '.'))
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
  registerable: boolean;
  reason: string | null;
}

/** Marketplace name from either manifest location Codex accepts. */
function readAnyMarketplaceName(repoDir: string): string | null {
  for (const rel of [
    path.join('.agents', 'plugins', 'marketplace.json'),
    path.join('.claude-plugin', 'marketplace.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(repoDir, rel), 'utf-8')) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name;
    } catch {
      /* try next */
    }
  }
  return null;
}

function readDeclaredCodexName(pluginDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf-8')) as {
      name?: unknown;
    };
    return typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : null;
  } catch {
    return null;
  }
}

function declaredCodexSourceDirs(repoDir: string): Set<string> | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(repoDir, '.agents', 'plugins', 'marketplace.json'), 'utf-8'),
    ) as { plugins?: Array<{ source?: { source?: unknown; path?: unknown } }> };
    if (!Array.isArray(parsed.plugins)) return null;
    const dirs = new Set<string>();
    for (const entry of parsed.plugins) {
      if (entry?.source?.source === 'local' && typeof entry.source.path === 'string') {
        dirs.add(path.resolve(repoDir, entry.source.path));
      }
    }
    return dirs.size > 0 ? dirs : null;
  } catch {
    return null;
  }
}

function ensureCodexSubPluginManifests(repoDir: string, dryRun: boolean): { dir: string; generated: boolean }[] {
  const out: { dir: string; generated: boolean }[] = [];
  const seen = new Set<string>();
  // A repo that ships its own codex marketplace has already decided which sub-plugins are
  // registerable; manifests planted into the rest trip that repo's own drift gates.
  const declared = declaredCodexSourceDirs(repoDir);
  for (const container of [path.join(repoDir, 'plugins'), repoDir]) {
    if (!isDirectory(container)) continue;
    let subs: string[];
    try {
      subs = fs.readdirSync(container);
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (sub.startsWith('.')) continue;
      const subDir = path.join(container, sub);
      if (seen.has(subDir) || !isDirectory(subDir)) continue;
      if (declared !== null && !declared.has(path.resolve(subDir))) continue;
      if (declared === null && !fs.existsSync(path.join(subDir, '.claude-plugin', 'plugin.json'))) continue;
      const root = findCodexSkillsRoot(subDir);
      if (root === null) continue;
      seen.add(subDir);
      const resolved = materializeSymlinkedSkills(subDir, root, dryRun);
      out.push({ dir: subDir, generated: ensureCodexPluginManifest(subDir, sub, resolved, dryRun) });
    }
  }
  return out;
}

function resolveCodexRegistration(dir: string, name: string, dryRun: boolean): CodexRegistration {
  const discoveredRoot = findCodexSkillsRoot(dir);
  const skillsRoot = discoveredRoot === null ? null : materializeSymlinkedSkills(dir, discoveredRoot, dryRun);
  if (skillsRoot === null) {
    // No skills at the root: a marketplace monorepo, handled per sub-plugin.
    const subs = ensureCodexSubPluginManifests(dir, dryRun);
    if (subs.length > 0) {
      const self = parseCodexMarketplaceSelfEntry(path.join(dir, '.agents', 'plugins', 'marketplace.json'));
      const mkt = self?.marketplaceName ?? readAnyMarketplaceName(dir);
      const entries = subs.map((s) => readDeclaredCodexName(s.dir)).filter((n): n is string => Boolean(n));
      return {
        skillsRoot: `${subs.length} sub-plugin(s)`,
        manifestGenerated: subs.some((s) => s.generated),
        marketplaceGenerated: false,
        registerable: Boolean(mkt) && entries.length > 0,
        reason: mkt ? null : 'monorepo has no marketplace.json name',
      };
    }
    return {
      skillsRoot: null,
      manifestGenerated: false,
      marketplaceGenerated: false,
      registerable: false,
      reason: 'no skills root found under .agents/skills, skills, or plugin/skills',
    };
  }

  const manifestGenerated = ensureCodexPluginManifest(dir, name, skillsRoot, dryRun);

  // The marketplace entry name MUST match the name inside .codex-plugin/plugin.json (Codex
  // hard-errors otherwise), and a pre-existing manifest can differ from the folder name.
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
        JSON.stringify({ name, plugins: [{ name: entryName, source: { source: 'local', path: './' } }] }, null, 2) +
          '\n',
      );
    }
  } else {
    self = parseCodexMarketplaceSelfEntry(marketplacePath);
    if (!self) reason = 'existing marketplace.json has no self-referencing entry';
  }

  return { skillsRoot, manifestGenerated, marketplaceGenerated, registerable: self !== null, reason };
}

/**
 * Runs in a separate process from the host, so it must use the cross-process
 * `updateContainerConfig`: a plain read-modify-write races the host's spawn-time write and can
 * lose `excludePlugins`.
 */
async function applyOptOut(exclude: string[], pluginName: string, dryRun: boolean): Promise<string[]> {
  const applied: string[] = [];
  for (const folder of exclude) {
    const groupDir = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(groupDir)) {
      console.warn(`  opt-out: group folder not found, skipped: ${folder}`);
      continue;
    }
    if (dryRun) {
      if (!new Set(readContainerConfig(folder).excludePlugins ?? []).has(pluginName)) applied.push(folder);
      continue;
    }
    // The "already excluded" check stays inside the lock: deciding outside it is check-then-act.
    let added = false;
    await updateContainerConfig(folder, (cfg) => {
      const set = new Set(cfg.excludePlugins ?? []);
      if (set.has(pluginName)) return;
      set.add(pluginName);
      cfg.excludePlugins = [...set];
      added = true;
    });
    if (added) applied.push(folder);
  }
  return applied;
}

async function main(): Promise<void> {
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
        registerable: false,
        reason: null,
      }
    : resolveCodexRegistration(dir, name, dryRun);

  // What `syncOpenCodePluginSkills` will publish, so scoped-plugin precedence is reported correctly.
  const portableSkills = openCodeMirrorSkills(PLUGINS_ROOT)
    .filter((s) => s.plugin === name)
    .map((s) => s.name);

  const alwaysOnPath = path.join(dir, '.nanoclaw-always-on.md');
  const hasAlwaysOnFile = fs.existsSync(alwaysOnPath);
  const alwaysOnIsStub = hasAlwaysOnFile && fs.readFileSync(alwaysOnPath, 'utf-8').trim().length === 0;
  // A plugin with its own `always-on.md` needs no `.nanoclaw-always-on.md` override: both
  // would deliver the directive twice. Must match exactly the set the composer reads (root,
  // `plugins/<sub>`, `<sub>`; `subPluginDirs` in src/claude-md-compose.ts).
  const hasOwnRuleset =
    fs.existsSync(path.join(dir, 'always-on.md')) ||
    [path.join(dir, 'plugins'), dir].some((container) => {
      let subs: string[];
      try {
        subs = fs.readdirSync(container);
      } catch {
        return false;
      }
      return subs.some((sub) => !sub.startsWith('.') && fs.existsSync(path.join(container, sub, 'always-on.md')));
    });

  const classification: Classification = {
    name,
    dir,
    denySiblings: [...deny].sort(),
    hasClaudeManifest,
    generatedManifest,
    codexSkillsRoot: codexReg.skillsRoot,
    codexManifestGenerated: codexReg.manifestGenerated,
    codexMarketplaceGenerated: codexReg.marketplaceGenerated,
    codexRegisterable: codexReg.registerable,
    portableSkills,
    sessionStartHook: detectSessionStartHook(dir),
    hasAlwaysOnFile,
    alwaysOnIsStub,
    hasOwnRuleset,
  };

  let opencodeCreated = 0;
  if (!dryRun) {
    opencodeCreated = syncOpenCodePluginSkills().created;
  }

  const optedOut = await applyOptOut(exclude, name, dryRun);

  if (reportJson) {
    console.log(JSON.stringify({ ...classification, optedOut, opencodeCreated, dryRun }, null, 2));
    return;
  }

  const needsRuleset =
    classification.sessionStartHook && !classification.hasOwnRuleset && (!hasAlwaysOnFile || alwaysOnIsStub);
  console.log(`\n${dryRun ? '[dry-run] ' : ''}enable-agent-plugin: ${name}`);
  console.log(`  dir:               ${dir}`);
  console.log(
    `  deny siblings:     ${classification.denySiblings.length ? classification.denySiblings.join(', ') : '(none — delivered to all three)'}`,
  );
  console.log(
    `  Claude manifest:   ${hasClaudeManifest ? 'present' : 'MISSING'}${generatedManifest ? ' (generated)' : ''}`,
  );
  if (deny.has('codex')) {
    console.log(`  Codex:             denied (sibling opt-out)`);
  } else if (codexReg.skillsRoot === null) {
    console.log(`  Codex:             skipped — ${codexReg.reason}`);
  } else {
    console.log(`  Codex skills root: ${codexReg.skillsRoot}`);
    console.log(
      `  Codex manifest:    ${codexReg.manifestGenerated ? 'generated' : 'present'}, marketplace: ${codexReg.marketplaceGenerated ? 'generated' : codexReg.registerable ? 'present' : `MISSING SELF ENTRY (${codexReg.reason})`}`,
    );
    console.log(`  Codex registers:   at container spawn, from /workspace/plugins (no host CLI involved)`);
  }
  console.log(
    `  portable skills:   ${portableSkills.length}${portableSkills.length ? ` (${portableSkills.join(', ')})` : ''}`,
  );
  console.log(`  skills mirrored:   opencode +${opencodeCreated}`);
  console.log(
    `  always-on plugin:  ${classification.sessionStartHook ? 'yes (has SessionStart hook)' : 'no (skills-only)'}`,
  );
  console.log(
    `  ruleset file:      ${hasAlwaysOnFile ? (alwaysOnIsStub ? 'present but EMPTY' : 'present') : 'absent'}`,
  );
  if (optedOut.length) console.log(`  opted out:         ${optedOut.join(', ')}`);
  console.log('\n  next steps:');
  if (needsRuleset) {
    console.log(`    1. Author ${path.join(dir, '.nanoclaw-always-on.md')} with the plugin's clean always-on`);
    console.log(`       ruleset (strip runtime banners / host-only nudges). The skill does this.`);
    console.log(`    2. pnpm run build   # composer is host src/`);
    console.log(`    3. restart the host to respawn containers`);
  } else if (classification.hasOwnRuleset) {
    console.log(`    1. pnpm run build && restart host  (plugin ships its own always-on.md — no override wanted)`);
  } else if (classification.sessionStartHook) {
    console.log(`    1. pnpm run build && restart host  (ruleset already present)`);
  } else {
    console.log(`    skills-only — already live on all 3 providers on next spawn. No build needed`);
    console.log(`    unless a Claude manifest was generated (then: restart host).`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
