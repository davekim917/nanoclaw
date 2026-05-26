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

function resolveScopedEnv(
  base: string,
  agentGroupFolder: string | undefined,
  hostEnv: NodeJS.ProcessEnv,
): string | undefined {
  if (agentGroupFolder) {
    const suffix = agentGroupFolder.toUpperCase().replace(/-/g, '_');
    const scopedValue = hostEnv[`${base}_${suffix}`];
    if (scopedValue) return scopedValue;
  }
  return hostEnv[base];
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
  // Model + effort: prefer the DB value (container_configs.model / .effort)
  // over the .env scoped value. The DB is what `change_model` (self-mod) +
  // `ncl groups config update --model X` mutate, so it must win — otherwise
  // those changes never take effect (the container reads OPENCODE_MODEL at
  // startup, and an unread DB value silently no-ops). .env stays as the
  // initial-bootstrap source for groups that haven't been touched via DB yet.
  const dbConfig = getContainerConfig(ctx.agentGroupId);
  const dbProvider = dbConfig?.provider ?? null;
  const dbModel = dbConfig?.model ?? null;
  const dbEffort = dbConfig?.effort ?? null;

  // The model is the freely-changeable knob: DB value (set by self-mod
  // change_model / `ncl groups config update --model`) wins over the .env
  // scoped default, so those changes take effect on the next spawn.
  const model = dbModel ?? resolveScopedEnv('OPENCODE_MODEL', ctx.agentGroupFolder, ctx.hostEnv);
  if (model) env.OPENCODE_MODEL = model;

  // OPENCODE_PROVIDER is the opencode-INTERNAL billing/routing provider
  // (opencode=Zen /zen/v1 | opencode-go=Go /zen/go/v1 | nvidia | ...). It MUST
  // equal the model slug's provider prefix: opencode resolves `model:"<p>/<id>"`
  // against `enabled_providers:["<p>"]`, so any drift yields "Model not found".
  // DERIVE it from the resolved model so the two can never disagree — including
  // after a change_model to a different provider's model. This is NOT
  // dbConfig.provider: that is the agent-RUNTIME selector (always "opencode" for
  // an opencode sibling — it picks the provider CLASS), and conflating the two
  // forced OPENCODE_PROVIDER="opencode" for every sibling, mismatching every
  // "opencode-go/*" model. Scoped env / runtime selector are fallbacks only when
  // no model (hence no prefix) is configured.
  const provider =
    (model && model.includes('/') ? model.slice(0, model.indexOf('/')) : null) ??
    resolveScopedEnv('OPENCODE_PROVIDER', ctx.agentGroupFolder, ctx.hostEnv) ??
    dbProvider;
  if (provider) env.OPENCODE_PROVIDER = provider;
  const effort = dbEffort ?? resolveScopedEnv('OPENCODE_EFFORT', ctx.agentGroupFolder, ctx.hostEnv);
  if (effort) env.OPENCODE_EFFORT = effort;
  // SMALL_MODEL — kept env-only for now; no DB field. If it ever moves to DB,
  // mirror the pattern above.
  const smallModel = resolveScopedEnv('OPENCODE_SMALL_MODEL', ctx.agentGroupFolder, ctx.hostEnv);
  if (smallModel) env.OPENCODE_SMALL_MODEL = smallModel;
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
