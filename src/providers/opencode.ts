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

import { readContainerConfig } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from '../fs-safety.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { splitExcludedPlugins, type ExcludedPlugins } from '../plugin-exclusions.js';
import { discoverPortableSkills } from '../plugin-skill-discovery.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Code-level opencode defaults — the floor under the per-group DB value
// (container_configs), mirroring DEFAULT_OPUS_MODEL etc. for claude in
// container-runner.ts. Default to the Go subscription (cheapest tier); Zen is
// opt-in via an explicit `opencode/*` model. Bump these when the fleet default
// moves (2026-09-15: glm-5.3-flash → deepseek-v4.1-flash). This is the ONLY
// place the default lives: the `provider_models` allowlist that once carried
// an `is_default` row was dropped by migration 039
// (`src/db/migrations/039-denied-models.ts:42`), so no DB row shadows it.
// DeepSeek models on Go are China-hosted and the OpenCode workspace must have
// opted in, or every request errors at the endpoint while `opencode models`
// still lists the slug. The provider is derived from the model prefix at
// runtime; the constant only guards a malformed override.
const DEFAULT_OPENCODE_MODEL = 'opencode-go/deepseek-v4.1-flash';
const DEFAULT_OPENCODE_PROVIDER = 'opencode-go';
const DEFAULT_OPENCODE_EFFORT = 'high';

/**
 * Skill names this group's `excludePlugins` SUB-PATH entries withhold from the
 * host-side OpenCode mirror.
 *
 * OpenCode receives skills by TWO paths, and the container-side one is not
 * enough on its own: the in-container mirror at `~/.agents/skills`
 * (`syncAgentSkillsMirror`, which honours `excludePlugins` in the container)
 * AND this copy of the host's per-sibling mirror into the session XDG. The host
 * mirror is built once for every sibling of a provider, with no agent group in
 * hand (`syncOpenCodePluginSkills`, `src/opencode-sync.ts`), so an excluded
 * sub-plugin's skills sit in it and would reach the group anyway — a sub-plugin
 * exclusion would be half-applied on exactly one provider.
 *
 * SUB-PATHS ONLY, deliberately. A TOP-LEVEL entry's skills also survive in this
 * mirror today, and that is a pre-existing, documented behaviour
 * (`.claude/skills/enable-agent-plugins/SKILL.md`: "drops the ruleset, keeps the
 * skills") that live groups are configured against — every OpenCode group on
 * this install carries top-level entries. Widening this filter to cover them
 * would silently withdraw skills those groups have today, which is a fleet
 * change, not this one's. The top-level gap stays as it was.
 *
 * Deriving the drop set by DIFFERENCE — discover twice over the host's own
 * `~/plugins`, once with the list and once without — rather than by mapping
 * mirror entries back to plugin paths, keeps three properties that matter:
 * the same predicate decides here as in the container, first-plugin-wins name
 * dedup is respected (a name another plugin also provides is NOT dropped), and
 * nothing resolves a path across a mount namespace.
 *
 * Returns an empty set for a group with no sub-path entry, which is every group
 * today: the copy below then behaves exactly as it did.
 */
export function excludedOpenCodeSkillNames(pluginsRoot: string, excluded: ExcludedPlugins): Set<string> {
  if (excluded.subPaths.size === 0) return new Set();
  const subPathsOnly: ExcludedPlugins = { topLevel: new Set(), subPaths: excluded.subPaths };
  const kept = new Set(
    discoverPortableSkills(pluginsRoot, { runtime: 'opencode', excludePlugins: subPathsOnly }).map((s) => s.name),
  );
  const dropped = new Set<string>();
  for (const skill of discoverPortableSkills(pluginsRoot, { runtime: 'opencode' })) {
    if (!kept.has(skill.name)) dropped.add(skill.name);
  }
  return dropped;
}

/**
 * Copy a host-owned skill tree without mutating it or following stale links,
 * omitting any top-level skill dir in `dropNames`.
 */
export function copyOpenCodeSkills(source: string, target: string, dropNames: ReadonlySet<string> = new Set()): void {
  fs.cpSync(source, target, {
    recursive: true,
    dereference: true,
    force: true,
    filter: (sourcePath) => {
      // `<mirror>/<skill-name>/...` — the first segment is the skill name the
      // mirror published, which is what the drop set holds. `''` is the root.
      const rel = path.relative(source, sourcePath);
      if (rel && dropNames.has(rel.split(path.sep)[0])) return false;
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
    // The group's own exclusions, read from the file that is authoritative for
    // them (`groups/<folder>/container.json`, the same file the container reads
    // through its read-only mount). The mirror is shared across siblings; the
    // filter is per group.
    const dropNames = excludedOpenCodeSkillNames(
      path.join(hostHome, 'plugins'),
      splitExcludedPlugins(readContainerConfig(path.basename(ctx.groupDir)).excludePlugins),
    );
    copyOpenCodeSkills(hostSkillsDir, targetSkillsDir, dropNames);
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
