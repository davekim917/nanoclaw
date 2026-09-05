/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode stores creds at `$XDG_DATA_HOME/opencode/auth.json` and session
 * state at `$XDG_DATA_HOME/opencode/opencode.db`. We pin XDG_DATA_HOME to a
 * per-session host directory (`<sessionDir>/opencode-xdg`) so:
 *
 * - Session state (opencode.db) stays per-session, no cross-session collisions.
 * - Auth, agent definitions, and skills reach the container via copy-at-spawn.
 *   Each surface independently prefers `~/.local/share/opencode-<folder>/`;
 *   auth falls back to `~/.local/share/opencode`, while definitions fall back
 *   to `~/.config/opencode`, so a scoped definition does not need scoped auth.
 *
 * Env passthrough covers the runtime-read OPENCODE_* selector vars (provider/
 * model) plus the optional per-group model capability declarations
 * (OPENCODE_MODEL_CAPABILITY_VARS). NO_PROXY / no_proxy are merged so
 * OpenCode's internal client can still reach 127.0.0.1 when HTTPS_PROXY is set
 * by OneCLI.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getContainerConfig } from '../db/container-configs.js';
import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from '../fs-safety.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Code-level opencode defaults — the floor under the per-group DB value
// (container_configs), mirroring DEFAULT_OPUS_MODEL etc. for claude in
// container-runner.ts. Default to the Go subscription (cheapest tier); Zen is
// opt-in via an explicit `opencode/*` model. Bump these when the fleet default
// moves. The provider is derived from the model prefix at
// runtime; the constant only guards a malformed override.
const DEFAULT_OPENCODE_MODEL = 'opencode-go/glm-5.3-flash';
const DEFAULT_OPENCODE_PROVIDER = 'opencode-go';
const DEFAULT_OPENCODE_EFFORT = 'high';

/** Copy a host-owned skill tree without mutating it or following stale links. */
export function copyOpenCodeSkills(source: string, target: string): void {
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (sourcePath) => {
      const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
      return stat !== undefined && (!stat.isSymbolicLink() || fs.existsSync(sourcePath));
    },
  });
}

/**
 * Per-group env passthrough, following the install-wide scoped-env convention:
 * `<VAR>_<FOLDER>` (folder upper-cased, `-` → `_`) wins over the bare `<VAR>`.
 * Mirrors container-runner's `resolveScopedEnv`, read off the spawn context's
 * env rather than `process.env` so a caller can supply its own.
 *
 * This is NOT the `.env` selector-var pattern removed above. Provider and model
 * are DB-authoritative (`container_configs`), so an env copy of those would be a
 * second source of truth. The model-capability declarations below have no DB
 * column at all — `.env` is their only channel, and an unset var leaves
 * OpenCode's own behavior untouched.
 */
export function resolveScopedOpenCodeEnv(
  hostEnv: NodeJS.ProcessEnv,
  baseName: string,
  folder: string | undefined,
): string | undefined {
  if (folder) {
    const scoped = hostEnv[`${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`];
    if (scoped !== undefined) return scoped;
  }
  return hostEnv[baseName];
}

/**
 * Model capability declarations the container provider reads at startup.
 *
 * `OPENCODE_MODEL_CONTEXT_LIMIT` + `OPENCODE_MODEL_OUTPUT_LIMIT` re-enable
 * auto-compaction for a model OpenCode's registry does not know: an undeclared
 * model resolves its context limit to 0, which silently disables compaction and
 * kills long sessions against a fixed-window backend. opencode requires both
 * halves, so a half-set pair is dropped by the container side.
 *
 * `OPENCODE_MODEL_INPUT_MODALITIES` (comma-separated: image, pdf, audio, video)
 * opens the gate that lets non-text file parts reach an undeclared model at all.
 *
 * All three are inert when unset, which is the default for every group.
 */
const OPENCODE_MODEL_CAPABILITY_VARS = [
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

interface OpenCodeSourcePaths {
  authFile: string;
  agentsDir: string;
  skillsDir: string;
}

/**
 * Resolve each host-owned OpenCode surface independently. A scoped auth.json
 * selects the credential, while scoped agent/ and skill/ dirs select only
 * their own definitions; neither decision may suppress the other fallbacks.
 */
function resolveOpenCodeSourcePaths(
  agentGroupFolder: string | undefined,
  agentGroupId: string,
  hostHome: string,
): OpenCodeSourcePaths {
  const scopedFolder = agentGroupFolder || agentGroupId;
  // Defense-in-depth: agent_groups.folder/id is operator-controlled but reaches
  // path.join here; reject anything that looks like traversal before forming
  // the scoped path. assertValidGroupFolder throws on '..', leading '/', or
  // reserved names — matches the validation applied elsewhere on group folders.
  assertValidGroupFolder(scopedFolder);
  const scoped = path.join(hostHome, '.local', 'share', `opencode-${scopedFolder}`);
  const shared = path.join(hostHome, '.local', 'share', 'opencode');
  const config = path.join(hostHome, '.config', 'opencode');
  const scopedAuth = path.join(scoped, 'auth.json');
  const scopedAgents = path.join(scoped, 'agent');
  const scopedSkills = path.join(scoped, 'skill');

  return {
    authFile: fs.existsSync(scopedAuth) ? scopedAuth : path.join(shared, 'auth.json'),
    agentsDir: fs.existsSync(scopedAgents) ? scopedAgents : path.join(config, 'agent'),
    skillsDir: fs.existsSync(scopedSkills) ? scopedSkills : path.join(config, 'skill'),
  };
}

registerProviderContainerConfig('opencode', async (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  const opencodeSubdir = path.join(opencodeDir, 'opencode');
  // Both directories were writable by the prior container. Do not let
  // mkdir/copy follow a symlink planted by that container on the next spawn.
  if (fs.lstatSync(opencodeDir, { throwIfNoEntry: false }) === undefined)
    fs.mkdirSync(opencodeDir, { recursive: true });
  assertRealDirectory(opencodeDir);
  if (fs.lstatSync(opencodeSubdir, { throwIfNoEntry: false }) === undefined) fs.mkdirSync(opencodeSubdir);
  assertRealDirectory(opencodeSubdir);

  let authContents: Buffer | null = null;
  let hostAgentsDir: string | null = null;
  let hostSkillsDir: string | null = null;
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  if (hostHome) {
    const source = resolveOpenCodeSourcePaths(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    if (fs.existsSync(source.authFile)) authContents = fs.readFileSync(source.authFile);
    if (fs.existsSync(source.agentsDir)) hostAgentsDir = source.agentsDir;
    if (fs.existsSync(source.skillsDir)) hostSkillsDir = source.skillsDir;
  }

  // Every managed entry may have been replaced while the prior container owned
  // this RW mount. Recreate or clear each one without following its old path.
  if (authContents) replaceUntrustedFile(opencodeSubdir, 'auth.json', authContents);
  else removeUntrustedPathEntry(opencodeSubdir, 'auth.json');

  removeUntrustedPathEntry(opencodeSubdir, 'agent');
  if (hostAgentsDir) {
    // Subagents (managed by scripts/sync-opencode-subagents.ts): copy every
    // `.md` from the scoped host agent/ dir (or global fallback) into the session XDG. OpenCode
    // reads agents from `$XDG_CONFIG_HOME/opencode/agent/`; we point both
    // XDG_DATA_HOME and XDG_CONFIG_HOME at the same path below, so the agents
    // surface alongside auth.json + opencode.db. Per-session copy (not a host
    // bind mount) so sibling state stays read-only from the container's view
    // — agents on disk are owned by the host sync, not the running session.
    const targetAgentsDir = replaceUntrustedDirectory(opencodeSubdir, 'agent');
    for (const entry of fs.readdirSync(hostAgentsDir)) {
      if (!entry.endsWith('.md')) continue;
      fs.copyFileSync(path.join(hostAgentsDir, entry), path.join(targetAgentsDir, entry));
    }
  }

  removeUntrustedPathEntry(opencodeSubdir, 'skill');
  if (hostSkillsDir) {
    // Skills (managed by syncOpenCodePluginSkills in opencode-sync.ts): copy
    // the scoped skill/ tree (or global fallback) into the session XDG with
    // dereference:true. OpenCode's mirror dirs contain links to plugin source;
    // the container does not mount that source, so it needs real files.
    // A stale mirror link must not wedge the spawn, but this source is
    // host-owned authority. Filter the derived copy; never prune the source.
    const targetSkillsDir = replaceUntrustedDirectory(opencodeSubdir, 'skill');
    copyOpenCodeSkills(hostSkillsDir, targetSkillsDir);
  }

  // Model + effort resolution mirrors the claude/codex template: a code-level
  // default (DEFAULT_OPENCODE_*) is the floor, the per-group DB value
  // (container_configs.model / .effort, set by `ncl groups config update` or
  // self-mod) overrides it. NO `.env` scoped vars — those were an opencode-only
  // anomaly (claude uses DEFAULT_OPUS_MODEL etc., never `.env`). Removing them
  // keeps one config pattern across all harnesses. The DB is authoritative; the
  // container reads OPENCODE_MODEL at startup, so an unread value would no-op.
  const dbConfig = await getContainerConfig(ctx.agentGroupId);
  const model = dbConfig?.model ?? DEFAULT_OPENCODE_MODEL;
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : DEFAULT_OPENCODE_PROVIDER;

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    // OpenCode reads agents from `$XDG_CONFIG_HOME/opencode/agent/` (verified
    // empirically against opencode-ai@1.15.7). Pointing XDG_CONFIG_HOME at the
    // same mount as XDG_DATA_HOME means opencode.jsonc / agent/ / auth.json /
    // opencode.db all live in one /opencode-xdg/opencode/ tree — no second
    // mount needed. Provider copies the per-sibling agent/*.md above.
    XDG_CONFIG_HOME: '/opencode-xdg',
    // The child runtime adds opencode.ai only when the effective turn model
    // has a matching native auth record. The host cannot decide that from the
    // boot model because `-m` and channel defaults can change it later.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  env.OPENCODE_MODEL = model;

  // OPENCODE_PROVIDER is the opencode-INTERNAL billing/routing provider
  // (opencode=Zen /zen/v1 | opencode-go=Go /zen/go/v1 | nvidia | ...). DERIVE it
  // from the model slug's prefix so the two can never disagree (opencode
  // resolves `model:"<p>/<id>"` against the enabled providers). This is NOT
  // dbConfig.provider — that is the agent-RUNTIME selector (always "opencode"
  // for an opencode sibling; it picks the provider CLASS). Since `model` always
  // carries a prefix (DB value or DEFAULT_OPENCODE_MODEL), the fallback only
  // guards a malformed override.
  env.OPENCODE_PROVIDER = modelProvider;

  env.OPENCODE_EFFORT = dbConfig?.effort ?? DEFAULT_OPENCODE_EFFORT;

  // Model capability declarations — see OPENCODE_MODEL_CAPABILITY_VARS. Only
  // forwarded when actually set, so a group that declares nothing gets exactly
  // the env it got before.
  for (const varName of OPENCODE_MODEL_CAPABILITY_VARS) {
    const value = resolveScopedOpenCodeEnv(ctx.hostEnv, varName, ctx.agentGroupFolder);
    if (value !== undefined && value.trim() !== '') env[varName] = value;
  }
  // Endpoint routing is determined by the cred-key in auth.json + the model
  // slug prefix (opencode-go/* → /zen/go/v1, opencode/* → /zen/v1, nvidia/*
  // → NVIDIA, etc.). We do NOT pass OPENCODE_BASE_URL — OpenCode's provider
  // registry handles the URL automatically. (Removed 2026-05-23 after the
  // earlier "force Go billing via base URL" hack proved unnecessary.)

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
