/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode stores creds at `$XDG_DATA_HOME/opencode/auth.json` and session
 * state at `$XDG_DATA_HOME/opencode/opencode.db`. We pin XDG_DATA_HOME to a
 * per-session host directory (`<sessionDir>/opencode-xdg`) so:
 *
 * - Session state (opencode.db) stays per-session, no cross-session collisions.
 * - The per-group auth.json reaches the container via copy-at-spawn (mirroring
 *   the codex pattern). Source lookup prefers `~/.local/share/opencode-<folder>/`
 *   so each sibling can hold its own OAuth without us touching the host's
 *   default `~/.local/share/opencode`.
 *
 * Env passthrough covers the runtime-read OPENCODE_* selector vars (provider/
 * model). NO_PROXY / no_proxy are merged so OpenCode's internal client can
 * still reach 127.0.0.1 when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getContainerConfig } from '../db/container-configs.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

// Code-level opencode defaults — the floor under the per-group DB value
// (container_configs), mirroring DEFAULT_OPUS_MODEL etc. for claude in
// container-runner.ts. Default to the Go subscription (cheapest tier); Zen is
// opt-in via an explicit `opencode/*` model. Bump these when the fleet default
// moves. The provider is derived from the model prefix at
// runtime; the constant only guards a malformed override.
const DEFAULT_OPENCODE_MODEL = 'opencode-go/ox-alpha-free';
const DEFAULT_OPENCODE_PROVIDER = 'opencode-go';
const DEFAULT_OPENCODE_EFFORT = 'high';

/**
 * Remove dangling symlinks under `root` (recursively), then any directories
 * the removal left empty. Skill mirrors are add-oriented — a skill retired
 * from its source plugin leaves its support-file links dangling forever —
 * and the spawn-time dereferencing copy hard-fails on the first one.
 */
export function pruneDanglingSymlinks(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      // existsSync follows the link — false means the target is gone.
      if (!fs.existsSync(p)) fs.unlinkSync(p);
    } else if (entry.isDirectory()) {
      pruneDanglingSymlinks(p);
      if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    }
  }
}

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

function resolveOpenCodeSourceDir(
  agentGroupFolder: string | undefined,
  agentGroupId: string,
  hostHome: string,
): string {
  const scopedFolder = agentGroupFolder || agentGroupId;
  // Defense-in-depth: agent_groups.folder/id is operator-controlled but reaches
  // path.join here; reject anything that looks like traversal before forming
  // the scoped path. assertValidGroupFolder throws on '..', leading '/', or
  // reserved names — matches the validation applied elsewhere on group folders.
  assertValidGroupFolder(scopedFolder);
  const scoped = path.join(hostHome, '.local', 'share', `opencode-${scopedFolder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(hostHome, '.local', 'share', 'opencode');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  const opencodeSubdir = path.join(opencodeDir, 'opencode');
  fs.mkdirSync(opencodeSubdir, { recursive: true });

  let authCopied = false;
  const hostHome = ctx.hostEnv.HOME || os.homedir();
  if (hostHome) {
    const sourceDir = resolveOpenCodeSourceDir(ctx.agentGroupFolder, ctx.agentGroupId, hostHome);
    const hostAuth = path.join(sourceDir, 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(opencodeSubdir, 'auth.json'));
      authCopied = true;
    }
    // Subagents (managed by scripts/sync-opencode-subagents.ts): copy every
    // `.md` from the per-sibling host agent/ dir into the session XDG. OpenCode
    // reads agents from `$XDG_CONFIG_HOME/opencode/agent/`; we point both
    // XDG_DATA_HOME and XDG_CONFIG_HOME at the same path below, so the agents
    // surface alongside auth.json + opencode.db. Per-session copy (not a host
    // bind mount) so sibling state stays read-only from the container's view
    // — agents on disk are owned by the host sync, not the running session.
    const hostAgentsDir = path.join(sourceDir, 'agent');
    if (fs.existsSync(hostAgentsDir)) {
      const targetAgentsDir = path.join(opencodeSubdir, 'agent');
      fs.mkdirSync(targetAgentsDir, { recursive: true });
      for (const entry of fs.readdirSync(hostAgentsDir)) {
        if (!entry.endsWith('.md')) continue;
        fs.copyFileSync(path.join(hostAgentsDir, entry), path.join(targetAgentsDir, entry));
      }
    }
    // Skills (managed by syncOpenCodePluginSkills in opencode-sync.ts): copy
    // the per-sibling skill/ tree into the session XDG with dereference:true.
    // OpenCode's skill sync writes managed mirror dirs whose children are
    // symlinks back to plugin source paths; dereference rewrites those to
    // real files so the container (which doesn't mount ~/plugins/) sees
    // every SKILL.md as a real file. Each SKILL.md becomes a slash command
    // automatically per packages/opencode/src/command/index.ts.
    const hostSkillsDir = path.join(sourceDir, 'skill');
    if (fs.existsSync(hostSkillsDir)) {
      // cpSync({dereference: true}) throws ENOENT on a dangling symlink, and
      // one stale mirror entry (a skill retired from its source plugin) then
      // wedges EVERY spawn of this group until someone hand-cleans the
      // mirror — bit an opencode group's session on 2026-08-06. The mirror
      // sync is add-oriented and leaves support-file links behind, so prune
      // dangling links (and dirs the prune empties) before each copy.
      pruneDanglingSymlinks(hostSkillsDir);
      const targetSkillsDir = path.join(opencodeSubdir, 'skill');
      fs.cpSync(hostSkillsDir, targetSkillsDir, {
        recursive: true,
        dereference: true,
        force: true,
      });
    }
  }

  // When the sibling has its own auth.json (OAuth-login flow), the container's
  // opencode CLI authenticates against opencode.ai directly via XDG-resolved
  // auth.json. OneCLI's HTTPS_PROXY would otherwise intercept that traffic and
  // 401 because no inject rule exists for opencode.ai. Add the host to NO_PROXY
  // so the SDK's outbound goes direct. The OneCLI vault path (static API key
  // registered with a host-pattern rule) is still available for users who pick
  // that option — they don't get auth.json copied, so NO_PROXY stays minimal.
  const noProxyAdditions = authCopied ? '127.0.0.1,localhost,opencode.ai' : '127.0.0.1,localhost';
  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    // OpenCode reads agents from `$XDG_CONFIG_HOME/opencode/agent/` (verified
    // empirically against opencode-ai@1.15.7). Pointing XDG_CONFIG_HOME at the
    // same mount as XDG_DATA_HOME means opencode.jsonc / agent/ / auth.json /
    // opencode.db all live in one /opencode-xdg/opencode/ tree — no second
    // mount needed. Provider copies the per-sibling agent/*.md above.
    XDG_CONFIG_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, noProxyAdditions),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, noProxyAdditions),
  };
  // Model + effort resolution mirrors the claude/codex template: a code-level
  // default (DEFAULT_OPENCODE_*) is the floor, the per-group DB value
  // (container_configs.model / .effort, set by `ncl groups config update` or
  // self-mod) overrides it. NO `.env` scoped vars — those were an opencode-only
  // anomaly (claude uses DEFAULT_OPUS_MODEL etc., never `.env`). Removing them
  // keeps one config pattern across all harnesses. The DB is authoritative; the
  // container reads OPENCODE_MODEL at startup, so an unread value would no-op.
  const dbConfig = getContainerConfig(ctx.agentGroupId);
  const model = dbConfig?.model ?? DEFAULT_OPENCODE_MODEL;
  env.OPENCODE_MODEL = model;

  // OPENCODE_PROVIDER is the opencode-INTERNAL billing/routing provider
  // (opencode=Zen /zen/v1 | opencode-go=Go /zen/go/v1 | nvidia | ...). DERIVE it
  // from the model slug's prefix so the two can never disagree (opencode
  // resolves `model:"<p>/<id>"` against the enabled providers). This is NOT
  // dbConfig.provider — that is the agent-RUNTIME selector (always "opencode"
  // for an opencode sibling; it picks the provider CLASS). Since `model` always
  // carries a prefix (DB value or DEFAULT_OPENCODE_MODEL), the fallback only
  // guards a malformed override.
  const slash = model.indexOf('/');
  env.OPENCODE_PROVIDER = slash > 0 ? model.slice(0, slash) : DEFAULT_OPENCODE_PROVIDER;

  env.OPENCODE_EFFORT = dbConfig?.effort ?? DEFAULT_OPENCODE_EFFORT;
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
