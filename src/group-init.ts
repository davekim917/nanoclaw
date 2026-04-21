import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Container path where groups/global is mounted. The symlink we drop
// into each group's dir resolves to this target inside the container.
// It's a dangling symlink on the host — that's fine, host tools don't
// follow it and the container mount makes it valid at read time.
const GLOBAL_MEMORY_CONTAINER_PATH = '/workspace/global/CLAUDE.md';

// Symlink name inside the group's dir. Claude Code's @-import only
// follows paths inside cwd, so we can't reference /workspace/global
// directly — we symlink into the group dir and import the symlink.
export const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
export const GLOBAL_CLAUDE_IMPORT = `@./${GLOBAL_MEMORY_LINK_NAME}`;

// Required env vars for every agent container. Kept in sync with
// ensureRequiredSettings() below — if you add a key here, it will be
// auto-applied to existing groups on next init call.
const REQUIRED_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // Auto-compact at 80% of context window instead of SDK default (~97%).
  // Prevents sessions from hitting the hard context limit and triggering
  // silent model fallback on upstream 400 errors.
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  // Lock the `opus` alias to 4.7. Model IDs are bundled into each SDK
  // release, so when a new flagship ships (4.7 → …) before the installed
  // SDK knows about it, the alias resolver silently falls back to whatever
  // is newest in its bundled map. This env is the first-checked branch in
  // the SDK's opus resolver — it short-circuits the alias and passes the
  // explicit id to the API, keeping "opus" pointed at the real flagship
  // regardless of SDK lag.
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
  // Lock the `sonnet` alias to 4.6 (explicit id, no [1m] extended-context
  // suffix — extended context is opt-in per query). Same reason as the opus
  // pin above: prevents silent fallback when the SDK's bundled alias map
  // lags behind a new Sonnet release.
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  // Default reasoning effort. Still per-message-overridable via `-e high`
  // and session-sticky via `-e1 high` flags; per-group override via
  // container.json `effort` field (planned). `medium` is a cost-balanced
  // default for general conversational use.
  CLAUDE_CODE_EFFORT_LEVEL: 'medium',
  CLAUDE_CODE_USE_EFFORT: 'medium',
};

// Required top-level settings. Merged into existing settings.json
// additively — never overwrites user-set values.
const REQUIRED_SETTINGS: Record<string, unknown> = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  // Background memory consolidation — prunes stale notes, resolves
  // contradictions, keeps MEMORY.md concise so auto-memory stays useful.
  autoDreamEnabled: true,
  // Default model alias. Combined with ANTHROPIC_DEFAULT_OPUS_MODEL in env
  // above, this resolves to claude-opus-4-7 at spawn time. Per-group
  // override via the group's own settings.json (the merge below preserves
  // existing values, so editing settings.json by hand works).
  model: 'opus',
};

const DEFAULT_SETTINGS_JSON = JSON.stringify({ env: REQUIRED_ENV, ...REQUIRED_SETTINGS }, null, 2) + '\n';

/**
 * Merge any missing required env vars + settings into an existing settings.json.
 * Additive only — user-customized values are preserved. Returns true if the
 * file was modified.
 */
function ensureRequiredSettings(settingsFile: string): boolean {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    return false;
  }
  let changed = false;
  if (!settings.env || typeof settings.env !== 'object') {
    settings.env = {};
    changed = true;
  }
  const env = settings.env as Record<string, string>;
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    if (env[k] === undefined) {
      env[k] = v;
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(REQUIRED_SETTINGS)) {
    if (settings[k] === undefined) {
      settings[k] = v;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  return changed;
}

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime: at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path. After init, the
 * host never overwrites any of these paths automatically — agents own them.
 * To pull in upstream changes, use the host-mediated reset/refresh tools.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const projectRoot = process.cwd();
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/.claude-global.md — symlink into the group dir so
  // Claude Code's @-import can follow it. Uses lstat to avoid tripping
  // existsSync on a dangling symlink (target only resolves inside the
  // container).
  const globalLinkPath = path.join(groupDir, GLOBAL_MEMORY_LINK_NAME);
  let linkExists = false;
  try {
    fs.lstatSync(globalLinkPath);
    linkExists = true;
  } catch {
    /* missing — recreate */
  }
  if (!linkExists) {
    fs.symlinkSync(GLOBAL_MEMORY_CONTAINER_PATH, globalLinkPath);
    initialized.push('.claude-global.md');
  }

  // groups/<folder>/CLAUDE.md — written once, then owned by the group
  const claudeMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdFile)) {
    const body = [GLOBAL_CLAUDE_IMPORT, '', opts?.instructions ?? `# ${group.name}`].join('\n') + '\n';
    fs.writeFileSync(claudeMdFile, body);
    initialized.push('CLAUDE.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  } else if (ensureRequiredSettings(settingsFile)) {
    initialized.push('settings.json (merged required keys)');
  }

  // Note: container skills are no longer copied here. They're bind-mounted
  // directly from trunk (`container/skills/`) in session-claude-mounts.ts,
  // so trunk fixes reach every group on the next container spawn. See the
  // mount ordering comment there for why this is a nested RO mount.

  // 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', group.id, 'agent-runner-src');
  if (!fs.existsSync(groupRunnerDir)) {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
      initialized.push('agent-runner-src/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
