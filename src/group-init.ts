import fs from 'fs';
import path from 'path';

import { CLAUDE_MAX_CONCURRENT_SUBAGENTS, CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH } from './claude-spawn-defaults.js';
import { DATA_DIR, DEFAULT_AGENT_PROVIDER, GROUPS_DIR } from './config.js';
import { stageGroupPersona, STANDING_INSTRUCTIONS_FILE } from './group-persona.js';
import { log } from './log.js';
import { providerProvidesAgentSurfaces } from './providers/provider-container-registry.js';
import { prepareWorkgroupMemoryMember } from './modules/workgroup/shared-dirs.js';
import type { AgentGroup } from './types.js';

// Reconciled on every spawn: these values win over disk, DEPRECATED_ENV keys are deleted, the rest is user-owned.
const REQUIRED_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  // BASH_DEFAULT_TIMEOUT_MS deliberately unset so ordinary Bash calls keep the shorter default.
  BASH_MAX_TIMEOUT_MS: '3600000',
  // Fleet constants, so pinning them is safe and stops a hand-edited settings.json shadowing the spawn `-e`.
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: CLAUDE_MAX_SUBAGENT_SPAWN_DEPTH,
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: CLAUDE_MAX_CONCURRENT_SUBAGENTS,
};

// Scrubbed from existing settings.json. Spawn-env-only keys are here because a settings.json pin is a group-level
// layer that would shadow the per-spawn `-e` for every session in the group.
const DEPRECATED_ENV: readonly string[] = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_EFFORT',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'NANOCLAW_DEFAULT_EFFORT',
  'NANOCLAW_EFFORT_OVERRIDE',
  'NANOCLAW_CLAUDE_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
];

const REQUIRED_SETTINGS: Record<string, unknown> = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  // Workgroup memory is the only durable authority; no second, provider-specific store.
  autoMemoryEnabled: false,
  alwaysThinkingEnabled: true,
  // Resolves via the install-wide ANTHROPIC_DEFAULT_OPUS_MODEL, so it means Opus in every group; the group's own
  // model travels as NANOCLAW_CLAUDE_MODEL.
  model: 'opus',
  outputStyle: 'Proactive',
  // Hides unused bundled skills (re-read every model call). Not plugin skills: use container.json excludePlugins.
  skillOverrides: {
    'update-config': 'user-invocable-only',
    'keybindings-help': 'user-invocable-only',
    'fewer-permission-prompts': 'user-invocable-only',
    schedule: 'user-invocable-only',
    loop: 'user-invocable-only',
    run: 'user-invocable-only',
    simplify: 'user-invocable-only',
    init: 'user-invocable-only',
    'security-review': 'user-invocable-only',
    'code-review': 'user-invocable-only',
    'workflow-authoring': 'user-invocable-only',
    'claude-api': 'name-only',
    welcome: 'name-only',
    'vercel-cli': 'name-only',
    hex: 'name-only',
    'frontend-engineer': 'name-only',
    'self-customize': 'name-only',
    'slack-a2a-rooms': 'name-only',
  },
};

const REQUIRED_HOOKS = {
  PreCompact: [
    {
      hooks: [
        {
          type: 'command',
          command: 'bun /app/src/compact-instructions.ts',
        },
      ],
    },
  ],
} as const;

const DEFAULT_SETTINGS_JSON =
  JSON.stringify({ env: REQUIRED_ENV, hooks: REQUIRED_HOOKS, ...REQUIRED_SETTINGS }, null, 2) + '\n';

export function prepareGroupCanonicalMemory(
  group: AgentGroup,
  dirs: { groupsDir?: string; dataDir?: string } = {},
): string {
  const workgroupId = group.workgroup_id ?? group.folder;
  return prepareWorkgroupMemoryMember({ id: group.id, folder: group.folder }, workgroupId, dirs).canonicalPath;
}

/**
 * Link included, target ignored: a link whose target resolves only inside the container reads as absent to
 * `existsSync`, and writing through it throws ENOENT before every spawn.
 */
function entryExists(target: string): boolean {
  return fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
}

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
    const cur = settings[k];
    const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
    if (isMap(v)) {
      // Merge, don't replace: replacing would drop an override the group set itself.
      const merged: Record<string, unknown> = isMap(cur) ? { ...cur } : {};
      let dirty = !isMap(cur);
      for (const [ek, ev] of Object.entries(v)) {
        if (merged[ek] !== ev) {
          merged[ek] = ev;
          dirty = true;
        }
      }
      if (dirty) {
        settings[k] = merged;
        changed = true;
      }
    } else if (JSON.stringify(cur) !== JSON.stringify(v)) {
      settings[k] = v;
      changed = true;
    }
  }
  // Present-or-add only; don't deep-merge: operators may legitimately change or extend the command.
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
    changed = true;
  }
  const hooks = settings.hooks as Record<string, unknown>;
  const existingPreCompact = hooks.PreCompact as unknown[] | undefined;
  if (!existingPreCompact || !JSON.stringify(existingPreCompact).includes('compact-instructions.ts')) {
    hooks.PreCompact = JSON.parse(JSON.stringify(REQUIRED_HOOKS.PreCompact));
    changed = true;
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
 * The composed `CLAUDE.md` is regenerated on every spawn. Initial per-group
 * instructions are staged on the provider-neutral standing-instructions
 * surface consumed by each provider's project-document composer.
 */
export function initGroupFilesystem(
  group: AgentGroup,
  opts?: { instructions?: string; provider?: string | null },
): void {
  const initialized: string[] = [];

  // Default surfaces apply unless the resolved provider declares its own.
  // An absent provider is the install default; unknown providers retain the
  // long-standing Claude-compatible fallback.
  const providerHint = (opts?.provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();
  const defaultSurfaces = !providerProvidesAgentSurfaces(providerHint);

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }
  prepareGroupCanonicalMemory(group);

  // Exclusive creation preserves existing operator-owned instructions.
  if (opts?.instructions && stageGroupPersona(groupDir, opts.instructions)) {
    initialized.push(STANDING_INSTRUCTIONS_FILE);
  }

  // The spawn template is nested-mounted into this folder; without a placeholder Docker creates it ROOT-owned.
  // Not gated on defaultSurfaces: the mount isn't either.
  const spawnTemplateFile = path.join(groupDir, 'spawn-template.md');
  if (!entryExists(spawnTemplateFile)) {
    fs.writeFileSync(spawnTemplateFile, '');
    initialized.push('spawn-template.md');
  }

  // plugins/ always exists (even for plugin-less groups) so the read-only
  // plugins mount in container-runner.ts is unconditional.
  const pluginsDir = path.join(groupDir, 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
    initialized.push('plugins/');
  }

  // The container_configs row is NOT created here: this runs before the agent_groups insert, so it would fail
  // the FK.

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  if (defaultSurfaces) {
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
    const skillsDst = path.join(claudeDir, 'skills');
    if (!fs.existsSync(skillsDst)) {
      fs.mkdirSync(skillsDst, { recursive: true });
      initialized.push('skills/');
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
