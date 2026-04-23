import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink name inside the group's dir. Claude Code's @-import only
// follows paths inside cwd, so we can't reference /workspace/global
// directly — we symlink into the group dir and import the symlink. The
// symlink resolves to /workspace/global/CLAUDE.md inside the container;
// dangling on the host is fine, host tools don't follow it.
export const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
export const GLOBAL_CLAUDE_IMPORT = `@./${GLOBAL_MEMORY_LINK_NAME}`;

// Nanoclaw-managed env vars. Reconciled to trunk on every container spawn:
// values here always win over what's on disk, keys in DEPRECATED_ENV get
// deleted, anything outside both lists is user-owned and left alone.
const REQUIRED_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // Auto-compact at 80% of context window instead of SDK default (~97%).
  // Prevents sessions from hitting the hard context limit and triggering
  // silent model fallback on upstream 400 errors.
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  // Lock the `opus` alias to 4.7. Model IDs are bundled into each SDK
  // release, so when a new flagship ships before the installed SDK knows
  // about it, the alias resolver silently falls back to whatever is newest
  // in its bundled map. This env short-circuits the alias and passes the
  // explicit id to the API, keeping "opus" pointed at the real flagship
  // regardless of SDK lag.
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
  // Lock the `sonnet` alias to 4.6 (explicit id, no [1m] suffix — extended
  // context is opt-in per query). Same reason as opus pin above.
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  // Default reasoning effort. Per-message-overridable via `-e1 high` and
  // session-sticky via `-e high` flags.
  NANOCLAW_DEFAULT_EFFORT: 'medium',
};

// Env keys whose meaning moved or got dropped. Removed from existing
// settings.json on next init so stale values can't leak into the SDK.
const DEPRECATED_ENV: readonly string[] = ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_USE_EFFORT'];

// Nanoclaw-managed top-level settings. Same reconciliation semantics as
// REQUIRED_ENV above.
const REQUIRED_SETTINGS: Record<string, unknown> = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  // Background memory consolidation — prunes stale notes, resolves
  // contradictions, keeps MEMORY.md concise so auto-memory stays useful.
  autoDreamEnabled: true,
  // Default model alias. Combined with ANTHROPIC_DEFAULT_OPUS_MODEL in env
  // above, this resolves to claude-opus-4-7 at spawn time.
  model: 'opus',
};

const DEFAULT_SETTINGS_JSON = JSON.stringify({ env: REQUIRED_ENV, ...REQUIRED_SETTINGS }, null, 2) + '\n';

/**
 * Reconcile an existing settings.json against trunk.
 *
 * For keys in REQUIRED_ENV / REQUIRED_SETTINGS: overwrite to trunk value
 * (so `/update-nanoclaw` pushes model/effort/alias changes out to every
 * existing group without a manual pass). For keys in DEPRECATED_ENV:
 * delete. Anything outside all three lists is user-owned and untouched.
 * Returns true if the file was modified.
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
  for (const k of DEPRECATED_ENV) {
    if (k in env) {
      delete env[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    if (env[k] !== v) {
      env[k] = v;
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(REQUIRED_SETTINGS)) {
    if (settings[k] !== v) {
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
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.local.md — per-group agent memory, auto-loaded by
  // Claude Code. Seeded with caller-provided instructions on first creation.
  const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocalFile)) {
    const body = opts?.instructions ? opts.instructions + '\n' : '';
    fs.writeFileSync(claudeLocalFile, body);
    initialized.push('CLAUDE.local.md');
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

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  // Container skills themselves live in trunk (`container/skills/`) and are
  // bind-mounted RO; this dir just holds the symlinks that Claude Code
  // discovers via ~/.claude/skills.
  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
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
