/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { getHostCapabilities } from './capabilities.js';
import {
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import YAML from 'yaml';

import { extractToolScopes, filterConfigSections, isToolEnabled } from './scoped-env.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import { markContainerRunning, markContainerStopped, sessionDir, writeSessionRouting } from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<void>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 */
export function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve();
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session).finally(() => {
    wakePromises.delete(session.id);
  });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Snapshot host capabilities into the session dir so the container can
  // read a static JSON (Phase 5.3). Refreshed every spawn so newly-mounted
  // credentials / plugins / channel registrations appear immediately.
  writeCapabilitiesSnapshot(agentGroup.id, session.id);

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup);

  const mounts = buildMounts(agentGroup, session, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;

  // Resolve per-channel (messaging_group_agents) default_model / default_effort
  // so buildContainerArgs can apply them ABOVE the per-agent container.json
  // defaults. Null/missing falls through. Agent-spawned sessions without a
  // messaging_group (e.g. pure agent-to-agent) skip this lookup.
  let channelDefaultModel: string | null = null;
  let channelDefaultEffort: string | null = null;
  let channelDefaultTone: string | null = null;
  if (session.messaging_group_id) {
    const { getMessagingGroupAgentByPair } = await import('./db/messaging-groups.js');
    const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, agentGroup.id);
    if (wiring) {
      channelDefaultModel = wiring.default_model;
      channelDefaultEffort = wiring.default_effort;
      channelDefaultTone = wiring.default_tone;
    }
  }

  const args = await buildContainerArgs(mounts, containerName, agentGroup, provider, contribution, agentIdentifier, {
    channelDefaultModel,
    channelDefaultEffort,
    channelDefaultTone,
  });

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Stop every active container synchronously at host shutdown.
 *
 * Load-bearing: without this, child container subprocesses linger in the
 * cgroup after the parent exits and systemd stalls for `TimeoutStopSec`
 * (default 90s) on every restart before SIGKILLing them. v1 wired this
 * into `GroupQueue.shutdown`; v2 lost it during the v1→v2 rewrite and the
 * host lingers similarly.
 *
 * Issues `docker stop` (SIGTERM then docker's own timeout → SIGKILL) to
 * every tracked container in parallel, waits for their close events up
 * to `gracePeriodMs`, then hard-kills anything still alive.
 */
export async function stopAllContainers(gracePeriodMs: number = 10_000): Promise<void> {
  const entries = Array.from(activeContainers.entries());
  if (entries.length === 0) return;
  log.info('Stopping all containers', { count: entries.length, gracePeriodMs });
  const exits = entries.map(([sessionId, entry]) => {
    const exited = new Promise<void>((resolve) => {
      if (entry.process.exitCode !== null) {
        resolve();
        return;
      }
      entry.process.once('close', () => resolve());
    });
    try {
      stopContainer(entry.containerName);
    } catch (err) {
      log.warn('stopContainer threw; falling back to SIGKILL', { sessionId, err });
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // process already gone — ignore
      }
    }
    return exited;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, gracePeriodMs);
  });
  await Promise.race([Promise.all(exits).then(() => undefined), timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  // Hard-kill anything still tracked after the grace period.
  for (const [sessionId, entry] of activeContainers.entries()) {
    log.warn('Container did not exit within grace period; SIGKILL', {
      sessionId,
      containerName: entry.containerName,
    });
    try {
      entry.process.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve a host env var value, folder-scoped.
 *
 * Lookup order:
 *   1. `<BASE>_<FOLDER_UPPER>` (dashes→underscores) — scoped variant
 *   2. `<BASE>` — unscoped default
 */
function resolveScopedEnv(baseName: string, folder: string): string | undefined {
  const conv = `${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`;
  return process.env[conv] ?? process.env[baseName];
}

/**
 * Remove every `-e <key>=...` pair from args whose key matches. Used to
 * delete placeholder values OneCLI injects for credentials we plan to
 * substitute with the real value ourselves. Mutates args in place.
 */
function stripEnvEntry(args: string[], key: string): void {
  const prefix = `${key}=`;
  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === '-e' && args[i + 1].startsWith(prefix)) {
      args.splice(i, 2);
    }
  }
}

/**
 * Append a host to the container's NO_PROXY / no_proxy env entries,
 * merging with any value OneCLI (or an earlier step) already set. Mutates
 * args in place. If neither form is present, adds both uppercase and
 * lowercase entries — Node respects uppercase, many Python/Go tools only
 * read lowercase.
 */
function mergeNoProxy(args: string[], host: string): void {
  const keys = ['NO_PROXY', 'no_proxy'];
  let touchedAny = false;
  for (const key of keys) {
    const prefix = `${key}=`;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '-e' || !args[i + 1].startsWith(prefix)) continue;
      const existing = args[i + 1].slice(prefix.length);
      const parts = existing
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.includes(host)) parts.push(host);
      args[i + 1] = `${key}=${parts.join(',')}`;
      touchedAny = true;
    }
  }
  if (!touchedAny) {
    args.push('-e', `NO_PROXY=${host}`);
    args.push('-e', `no_proxy=${host}`);
  }
}

/**
 * Phase 5.3: write a capabilities snapshot into the session dir at
 * every container spawn. Container's get_capabilities MCP tool reads
 * this JSON directly — no round-trip, always fresh per spawn.
 */
function writeCapabilitiesSnapshot(agentGroupId: string, sessionId: string): void {
  try {
    const caps = getHostCapabilities(agentGroupId);
    const outPath = path.join(sessionDir(agentGroupId, sessionId), 'capabilities.json');
    fs.writeFileSync(outPath, JSON.stringify(caps, null, 2) + '\n');
  } catch (err) {
    log.warn('Failed to write capabilities snapshot', { err });
  }
}

function resolveGitHubToken(folder: string, cfg: ContainerConfig): string | undefined {
  if (cfg.githubTokenEnv) {
    const v = process.env[cfg.githubTokenEnv];
    if (v) return v;
  }
  return resolveScopedEnv('GITHUB_TOKEN', folder);
}

/**
 * Credential env vars auto-forwarded per agent group via <NAME>_<FOLDER>
 * → <NAME> resolution. Non-sensitive tool-config vars belong in the image
 * or container.json — this list is for things whose *value* differs per
 * group.
 */
const SCOPED_CREDENTIAL_VARS = [
  'RENDER_API_KEY',
  'RENDER_WORKSPACE_ID',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PASSWORD',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_DATABASE',
  'DBT_CLOUD_ACCOUNT_ID',
  'DBT_CLOUD_API_TOKEN',
  // dbt Cloud email/password login path — v1 carried these; skills that
  // use the email+password flow (not just Account-ID/API-Token) need them.
  'DBT_CLOUD_EMAIL',
  'DBT_CLOUD_PASSWORD',
  'DBT_CLOUD_API_URL',
  'OPENAI_API_KEY',
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  // Omni API — required by the omni skill; absent → first call fails 401.
  'OMNI_BASE_URL',
  'OMNI_API_KEY',
  // Railway CLI / API — `railway login` uses this token; absent → CLI hangs
  // on interactive auth inside the container.
  'RAILWAY_API_TOKEN',
  // Browser-auth skill (Playwright geo-fenced login flows) — absent → login
  // form can't be filled and the skill times out on the first call.
  'BROWSER_AUTH_URL',
  'BROWSER_AUTH_EMAIL',
  'BROWSER_AUTH_PASSWORD',
];

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = (session.agent_provider || agentGroup.agent_provider || 'claude').toLowerCase();
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Pulling in upstream
  // built-in skill or agent-runner source updates is an explicit operation
  // (host-mediated tools), not something the spawn path does silently.
  initGroupFilesystem(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/).
  //
  // The session dir parent is mounted RW because the container legitimately
  // writes: outbound.db (its own), outbox/<id>/ (file deliveries), and
  // .heartbeat (liveness touch).
  //
  // inbound.db, however, is host-owned and MUST be unwritable from the
  // container. Without this, a compromised agent could forge admin
  // approvals by directly INSERT-ing into the `delivered` table, trivially
  // bypassing the email-gate, send_file ack, and any future host→container
  // signaling that rides on inbound.db. The file-level RO overlay below
  // reuses the same host file; Docker applies mount rules in order, so the
  // `:ro` on inbound.db overrides the parent mount's RW permission for
  // that specific path.
  //
  // The SDK-level `readonly: true` open in container/agent-runner/src/db/
  // connection.ts is belt and suspenders. The mount is the real boundary.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });
  const inboundDbFile = path.join(sessDir, 'inbound.db');
  if (fs.existsSync(inboundDbFile)) {
    mounts.push({ hostPath: inboundDbFile, containerPath: '/workspace/inbound.db', readonly: true });
  }

  // Agent group folder at /workspace/agent
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Global memory directory — always read-only. Edits to global config
  // happen through the approval flow, not by handing one workspace RW.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // .claude mount triple (group-shared parent + per-session projects overlay
  // + group-shared memory overlay). See session-claude-mounts.ts for the
  // ordering invariant and the race it prevents.
  mounts.push(...getSessionClaudeMounts(agentGroup, session));

  // Central message archive at /workspace/archive.db (read-only). Powers
  // the search_threads + resolve_thread_link MCP tools (Phase 2.9/2.10).
  // Separate file from v2.db so only message history is exposed — not
  // privileged central state (pending_approvals, user_roles, etc.).
  const archivePath = path.join(DATA_DIR, 'archive.db');
  if (fs.existsSync(archivePath)) {
    mounts.push({ hostPath: archivePath, containerPath: '/workspace/archive.db', readonly: true });
  }

  // Central DB at /workspace/central.db (read-only). Powers backlog + ship-log
  // MCP tools so the container can list/query without going through delivery.
  // Never write from the container — use system actions for mutations.
  const centralDbPath = path.join(DATA_DIR, 'v2.db');
  if (fs.existsSync(centralDbPath)) {
    mounts.push({ hostPath: centralDbPath, containerPath: '/workspace/central.db', readonly: true });
  }

  // Per-group agent-runner source at /app/src (initialized once at group
  // creation, persistent thereafter — agents can modify their runner)
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
  mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });

  // Additional mounts from container config (groups/<folder>/container.json)
  const containerConfig = readContainerConfig(agentGroup.folder);
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Built-in nanoclaw-hooks plugin: project-relative, always mounted.
  // Provides the GitNexus repo-readiness guard (PreToolUse) and the
  // post-commit blast-radius verification hook (PostToolUse). Unlike
  // external plugins, this one ships with NanoClaw itself. Same
  // discovery path (CLAUDE_PLUGINS_ROOT → /workspace/plugins/*).
  const builtinPlugin = path.resolve(GROUPS_DIR, '..', 'container', 'nanoclaw-plugin');
  if (fs.existsSync(builtinPlugin)) {
    mounts.push({
      hostPath: builtinPlugin,
      containerPath: '/workspace/plugins/nanoclaw-hooks',
      readonly: true,
    });
  }

  // Plugin mounts: every subdir of ~/plugins is mounted RO at
  // /workspace/plugins/<name>. Claude Code SDK auto-discovers via
  // CLAUDE_PLUGINS_ROOT (set in buildContainerArgs). Per-group
  // excludePlugins deny list skips named plugins — useful for limiting
  // a group's tool surface (e.g. security agents without codex).
  //
  // Special case: if codex plugin is mounted and the host's ~/.codex dir
  // exists, mount that RW so the Codex CLI can use the host's OAuth
  // session and persist refresh tokens.
  const pluginsHostDir = path.join(os.homedir(), 'plugins');
  if (fs.existsSync(pluginsHostDir)) {
    const excluded = new Set(containerConfig.excludePlugins ?? []);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsHostDir);
    } catch (err) {
      log.warn('Failed to read ~/plugins directory', { err });
    }
    for (const entry of entries) {
      if (excluded.has(entry)) continue;
      const pluginHostPath = path.join(pluginsHostDir, entry);
      try {
        if (!fs.statSync(pluginHostPath).isDirectory()) continue;
      } catch {
        continue;
      }
      mounts.push({
        hostPath: pluginHostPath,
        containerPath: `/workspace/plugins/${entry}`,
        readonly: true,
      });
    }

    if (!excluded.has('codex') && entries.includes('codex')) {
      const hostCodex = path.join(os.homedir(), '.codex');
      if (fs.existsSync(hostCodex)) {
        mounts.push({ hostPath: hostCodex, containerPath: '/home/node/.codex', readonly: false });
      }
    }
  }

  // Project source tree at /workspace/project (RO). Lets agents read the
  // NanoClaw codebase — useful for self-diagnostic questions ("why did
  // you do X?"), self-mod context, and understanding their own runtime.
  // We mount a selective allowlist rather than the whole project root
  // to exclude .env, data/, groups/, repo-tokens/, node_modules/, dist/,
  // logs/, and other sensitive or bulky paths.
  //
  // scripts/ and prompts/ are INTENTIONALLY excluded: v1 commit 3a31f9d
  // removed them from the allowlist after noting that scripts/ exposes
  // credential path topology (wire-*, migrate-*, init-* scripts reference
  // host paths) and prompts/ was unused agent-facing content. Keep them
  // out unless there's a specific capability that needs them and a clear
  // review of what's in them.
  const projectRoot = path.resolve(GROUPS_DIR, '..');
  const sourceEntries = [
    'src',
    'container',
    'docs',
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'AGENTS.md',
    'tsconfig.json',
  ];
  for (const entry of sourceEntries) {
    const hostEntry = path.join(projectRoot, entry);
    if (fs.existsSync(hostEntry)) {
      mounts.push({
        hostPath: hostEntry,
        containerPath: `/workspace/project/${entry}`,
        readonly: true,
      });
    }
  }

  // Tone profiles — project-relative, shared across all groups. Read-only:
  // groups select a profile in their CLAUDE.md; the files themselves are
  // managed via the /add-tone-profile skill on the host.
  const toneProfilesDir = path.resolve(GROUPS_DIR, '..', 'tone-profiles');
  if (fs.existsSync(toneProfilesDir)) {
    mounts.push({
      hostPath: toneProfilesDir,
      containerPath: '/workspace/tone-profiles',
      readonly: true,
    });
  }

  // Host-side credential dirs — gated by the per-agent `tools` allowlist in
  // container.json. Two modes:
  //
  //   tools = undefined  → legacy behavior, mount every credential surface.
  //                        Preserves the pre-v2-tools-port default.
  //   tools = [...]      → filter + stage per-tool. E.g. `snowflake:sunday`
  //                        stages only the [connections.sunday] section of
  //                        connections.toml and its referenced private
  //                        keys; `aws:work` stages [default] + [work] from
  //                        ~/.aws/credentials; `dbt:snowflake-db` stages a
  //                        profiles.yml containing only that profile.
  //
  // Rationale for the gate (see docs/V2_BACKLOG.md → scoped credentials):
  //   OneCLI's proxy covers API-level secrets (keys flowing through
  //   HTTPS_PROXY). Filesystem credentials — private keys, INI/TOML with
  //   raw passwords, service-account JSONs — are *not* OneCLI-mediated.
  //   Without per-agent scoping every agent can `cat` every other agent's
  //   creds. v1 enforced this at mount time; v2 now does too when `tools`
  //   is set.
  const home = os.homedir();
  const tools = containerConfig.tools;
  const stagingRoot = path.join(sessDir, 'creds');

  // Prepare a clean per-cred staging subdir. Caller passes the dir name;
  // returns the absolute path. We rm+mkdir to avoid stale files leaking
  // between spawns of the same session (e.g. after an agent re-scope).
  const stageDir = (name: string): string => {
    const p = path.join(stagingRoot, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---- Gmail MCP (legacy per-account dirs) --------------------------------
  if (isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly')) {
    const g = extractToolScopes(tools, 'gmail');
    const r = extractToolScopes(tools, 'gmail-readonly');
    const scopedAccounts = [...new Set([...g.scopes, ...r.scopes])];
    const anyScoped = scopedAccounts.length > 0 && !tools?.includes('gmail');

    if (anyScoped) {
      // First scoped account gets the primary path; extras mounted at named paths.
      const primary = scopedAccounts[0];
      const primaryDir = path.join(home, `.gmail-mcp-${primary}`);
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      for (let i = 1; i < scopedAccounts.length; i++) {
        const acctDir = path.join(home, `.gmail-mcp-${scopedAccounts[i]}`);
        if (fs.existsSync(acctDir)) {
          mounts.push({
            hostPath: acctDir,
            containerPath: `/home/node/.gmail-mcp-${scopedAccounts[i]}`,
            readonly: true,
          });
        }
      }
    } else {
      // Unscoped (or tools undefined): mount primary + every .gmail-mcp-*/
      const primaryDir = path.join(home, '.gmail-mcp');
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      try {
        for (const entry of fs.readdirSync(home)) {
          if (!entry.startsWith('.gmail-mcp-')) continue;
          const dir = path.join(home, entry);
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
          } catch {
            continue;
          }
          mounts.push({ hostPath: dir, containerPath: `/home/node/${entry}`, readonly: true });
        }
      } catch {
        // home may not be readable — skip
      }
    }
  }

  // ---- Google Calendar MCP ------------------------------------------------
  if (isToolEnabled(tools, 'calendar')) {
    const calDir = path.join(home, '.config', 'google-calendar-mcp');
    const { scopes: calAccts, isScoped: calScoped } = extractToolScopes(tools, 'calendar');
    if (fs.existsSync(calDir)) {
      if (calScoped) {
        // Filter tokens.json to allowed accounts; fail CLOSED on parse error
        // (do NOT fall back to the full dir — that defeats the scope).
        const tokensPath = path.join(calDir, 'tokens.json');
        if (fs.existsSync(tokensPath)) {
          try {
            const all = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')) as Record<string, unknown>;
            const filtered: Record<string, unknown> = {};
            for (const a of calAccts) if (all[a]) filtered[a] = all[a];
            const dest = stageDir('google-calendar-mcp');
            fs.writeFileSync(path.join(dest, 'tokens.json'), JSON.stringify(filtered, null, 2), { mode: 0o600 });
            // Copy non-token files (settings etc.) as-is.
            for (const entry of fs.readdirSync(calDir)) {
              if (entry === 'tokens.json') continue;
              const src = path.join(calDir, entry);
              try {
                if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, entry));
              } catch {
                continue;
              }
            }
            mounts.push({
              hostPath: dest,
              containerPath: '/home/node/.config/google-calendar-mcp',
              readonly: true,
            });
          } catch (err) {
            log.warn('Calendar tokens filter failed — skipping mount (fail closed)', {
              agent: agentGroup.folder,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        mounts.push({ hostPath: calDir, containerPath: '/home/node/.config/google-calendar-mcp', readonly: true });
      }
    }

    // Calendar reuses the Gmail OAuth app keys. If gmail isn't enabled for
    // this agent, mount JUST the keys file (not the full gmail dir, which
    // would leak Gmail tokens to a calendar-only scope).
    if (!isToolEnabled(tools, 'gmail')) {
      const oauthKeys = path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // ---- Google Workspace (gws-style accounts dir) --------------------------
  if (isToolEnabled(tools, 'google-workspace')) {
    const gwsAccountsDir = path.join(home, '.config', 'gws', 'accounts');
    if (fs.existsSync(gwsAccountsDir)) {
      const { scopes: gwsAccts, isScoped: gwsScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwsScoped) {
        // Each account has its own JSON file under accounts/. Stage only
        // the allowed ones. Entries can be files (<acct>.json) or dirs.
        const dest = stageDir('gws-accounts');
        for (const acct of gwsAccts) {
          const fileCandidate = path.join(gwsAccountsDir, `${acct}.json`);
          const dirCandidate = path.join(gwsAccountsDir, acct);
          try {
            if (fs.existsSync(fileCandidate) && fs.statSync(fileCandidate).isFile()) {
              fs.copyFileSync(fileCandidate, path.join(dest, `${acct}.json`));
              fs.chmodSync(path.join(dest, `${acct}.json`), 0o600);
            } else if (fs.existsSync(dirCandidate) && fs.statSync(dirCandidate).isDirectory()) {
              fs.cpSync(dirCandidate, path.join(dest, acct), { recursive: true });
            } else {
              log.warn('google-workspace account not found in gws dir', { acct, agent: agentGroup.folder });
            }
          } catch (err) {
            log.warn('google-workspace scoped copy failed', {
              acct,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        mounts.push({ hostPath: dest, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      } else {
        mounts.push({ hostPath: gwsAccountsDir, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      }
    }

    // Legacy google_workspace_mcp/credentials/ — same pattern.
    const gwCredsDir = path.join(home, '.google_workspace_mcp', 'credentials');
    if (fs.existsSync(gwCredsDir)) {
      const { scopes: gwAccts, isScoped: gwScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwScoped) {
        const dest = stageDir('google-workspace-mcp-credentials');
        for (const entry of fs.readdirSync(gwCredsDir)) {
          // match entries that START with an allowed account name (allows
          // <acct>.json, <acct>_token.json, etc. — v1 pattern).
          if (!gwAccts.some((a) => entry.startsWith(a))) continue;
          const src = path.join(gwCredsDir, entry);
          try {
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(dest, entry));
              fs.chmodSync(path.join(dest, entry), 0o600);
            }
          } catch {
            continue;
          }
        }
        mounts.push({
          hostPath: dest,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      } else {
        mounts.push({
          hostPath: gwCredsDir,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      }
    }
  }

  // ---- Snowflake (connections.toml + keys) --------------------------------
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(home, '.snowflake');
    const origToml = path.join(snowflakeDir, 'connections.toml');
    if (fs.existsSync(snowflakeDir) && fs.existsSync(origToml)) {
      const { scopes: allowedConns, isScoped: filterConns } = extractToolScopes(tools, 'snowflake');
      const dest = stageDir('snowflake');

      // Rewrite host paths → /home/node paths so in-container CLIs find
      // their own keys. snowflake-connector-python historically doesn't
      // expand `~`, so we normalize to absolute /home/node/... paths.
      const homePattern = new RegExp(escapeRegex(snowflakeDir) + '/', 'g');
      let tomlContent = fs.readFileSync(origToml, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
      if (filterConns) tomlContent = filterConfigSections(tomlContent, allowedConns);
      fs.writeFileSync(path.join(dest, 'connections.toml'), tomlContent, { mode: 0o600 });

      const origConfig = path.join(snowflakeDir, 'config.toml');
      if (fs.existsSync(origConfig)) {
        const configContent = fs.readFileSync(origConfig, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
        fs.writeFileSync(path.join(dest, 'config.toml'), configContent, { mode: 0o600 });
      }

      // Copy only key files that the (possibly filtered) toml actually
      // references — never the whole keys/ dir under scoping.
      const keysDir = path.join(snowflakeDir, 'keys');
      if (fs.existsSync(keysDir)) {
        const referenced = new Set<string>();
        for (const m of tomlContent.matchAll(/private_key_path\s*=\s*"[^"]*\/keys\/([^"]+)"/g)) {
          referenced.add(m[1]);
        }
        const destKeys = path.join(dest, 'keys');
        fs.mkdirSync(destKeys, { recursive: true });
        for (const entry of fs.readdirSync(keysDir, { withFileTypes: true, recursive: true })) {
          if (!entry.isFile()) continue;
          const srcPath = path.join(entry.parentPath, entry.name);
          const relPath = path.relative(keysDir, srcPath);
          // When filtering, skip any key not referenced by allowed conns.
          // When not filtering, copy everything.
          if (filterConns && referenced.size > 0 && !referenced.has(relPath)) continue;
          const destPath = path.join(destKeys, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      }

      // Mount RW: snow CLI writes to ~/.snowflake/logs/.
      mounts.push({ hostPath: dest, containerPath: '/home/node/.snowflake', readonly: false });

      // Dual-mount at host absolute path too — some snowflake libs record
      // the originally-resolved absolute path in session state and retry
      // reads at that path. The container sees the same staging dir.
      if (snowflakeDir !== '/home/node/.snowflake') {
        mounts.push({ hostPath: dest, containerPath: snowflakeDir, readonly: false });
      }
    }
  }

  // ---- AWS (~/.aws/{credentials,config}) ----------------------------------
  if (isToolEnabled(tools, 'aws')) {
    const awsDir = path.join(home, '.aws');
    if (fs.existsSync(awsDir)) {
      const { scopes: allowedProfiles, isScoped: filterProfiles } = extractToolScopes(tools, 'aws');
      const dest = stageDir('aws');
      const alwaysInclude = new Set(['default']);

      const origCreds = path.join(awsDir, 'credentials');
      if (fs.existsSync(origCreds)) {
        let content = fs.readFileSync(origCreds, 'utf-8');
        if (filterProfiles) content = filterConfigSections(content, allowedProfiles, { alwaysInclude });
        fs.writeFileSync(path.join(dest, 'credentials'), content, { mode: 0o600 });
      }
      const origConfig = path.join(awsDir, 'config');
      if (fs.existsSync(origConfig)) {
        let content = fs.readFileSync(origConfig, 'utf-8');
        if (filterProfiles) {
          // AWS config uses `[profile foo]` rather than `[foo]` — transform
          // to compare raw name against the allowlist.
          content = filterConfigSections(content, allowedProfiles, {
            headerTransform: (h) => h.replace(/^profile\s+/, ''),
            alwaysInclude,
          });
        }
        fs.writeFileSync(path.join(dest, 'config'), content, { mode: 0o600 });
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.aws', readonly: true });
    }
  }

  // ---- gcloud (~/.gcloud-keys/*.json) -------------------------------------
  if (isToolEnabled(tools, 'gcloud')) {
    const gcloudKeysDir = path.join(home, '.gcloud-keys');
    if (fs.existsSync(gcloudKeysDir)) {
      const { scopes: gcloudScopes, isScoped: gcloudScoped } = extractToolScopes(tools, 'gcloud');
      const dest = stageDir('gcloud-keys');

      if (gcloudScoped) {
        // v1 convention: GCLOUD_KEY_<SCOPE>=<filename.json> env var in the
        // host process env maps scope → key file. Keep the same contract.
        for (const s of gcloudScopes) {
          const envKey = `GCLOUD_KEY_${s.toUpperCase()}`;
          const keyFile = process.env[envKey];
          if (!keyFile) {
            log.warn('gcloud scope has no GCLOUD_KEY_<SCOPE> mapping in env', { scope: s, envKey });
            continue;
          }
          const srcPath = path.join(gcloudKeysDir, keyFile);
          if (!fs.existsSync(srcPath)) {
            log.warn('gcloud key file not found', { srcPath, scope: s });
            continue;
          }
          const destPath = path.join(dest, keyFile);
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      } else {
        // Unscoped: copy every .json under the keys dir.
        for (const entry of fs.readdirSync(gcloudKeysDir)) {
          if (!entry.endsWith('.json')) continue;
          const srcPath = path.join(gcloudKeysDir, entry);
          try {
            if (fs.statSync(srcPath).isFile()) {
              const destPath = path.join(dest, entry);
              fs.copyFileSync(srcPath, destPath);
              fs.chmodSync(destPath, 0o600);
            }
          } catch {
            continue;
          }
        }
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.gcloud-keys', readonly: true });
    }
  }

  // ---- dbt (~/.dbt/profiles.yml) ------------------------------------------
  if (isToolEnabled(tools, 'dbt')) {
    const dbtDir = path.join(home, '.dbt');
    const origProfiles = path.join(dbtDir, 'profiles.yml');
    if (fs.existsSync(origProfiles)) {
      const { scopes, isScoped } = extractToolScopes(tools, 'dbt');
      const dest = stageDir('dbt');
      try {
        let profiles = YAML.parse(fs.readFileSync(origProfiles, 'utf-8')) as Record<string, unknown>;
        if (isScoped) {
          const filtered: Record<string, unknown> = {};
          for (const name of scopes) {
            if (profiles[name] !== undefined) filtered[name] = profiles[name];
          }
          profiles = filtered;
        }
        fs.writeFileSync(path.join(dest, 'profiles.yml'), YAML.stringify(profiles), { mode: 0o600 });
        mounts.push({ hostPath: dest, containerPath: '/home/node/.dbt', readonly: true });
      } catch (err) {
        log.warn('dbt profiles stage failed — skipping mount (fail closed)', {
          agent: agentGroup.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  channelDefaults?: {
    channelDefaultModel: string | null;
    channelDefaultEffort: string | null;
    channelDefaultTone: string | null;
  },
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Read once up-front — used for GitHub token resolution, MCP server
  // registration, and image tag selection later in this function.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Environment
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `AGENT_PROVIDER=${provider}`);
  // Two-DB split: container reads inbound.db, writes outbound.db
  args.push('-e', 'SESSION_INBOUND_DB_PATH=/workspace/inbound.db');
  args.push('-e', 'SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db');
  args.push('-e', 'SESSION_HEARTBEAT_PATH=/workspace/.heartbeat');

  if (agentGroup.name) {
    args.push('-e', `NANOCLAW_ASSISTANT_NAME=${agentGroup.name}`);
  }
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`);
  args.push('-e', `NANOCLAW_AGENT_GROUP_NAME=${agentGroup.name}`);
  // Cap on how many pending messages reach one prompt. Accumulated context
  // (trigger=0 rows) rides along with wake-eligible rows up to this cap.
  args.push('-e', `NANOCLAW_MAX_MESSAGES_PER_PROMPT=${MAX_MESSAGES_PER_PROMPT}`);

  // Claude Code behavior locks — duplicated from settings.json env block so
  // the values are set regardless of the SDK's settings-loading order.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=0');
  args.push('-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80');

  // Default `opus` alias resolution and default effort — both
  // configurable via host env so the install can upgrade to a newer
  // model or change default effort without a code change. Per-session
  // flags (-m / -m1 / -e / -e1 in the agent-runner flag parser) still
  // override. Short aliases (opus46, opus4-7, etc.) are in the flag
  // parser's MODEL_ALIAS_MAP — independent of these defaults.
  //
  // Precedence (most specific wins):
  //   1. Per-session flag in chat (-m / -m1 / -e / -e1) — handled inside
  //      the agent-runner's flag parser, not here.
  //   2. Per-channel wiring (messaging_group_agents.default_model/effort)
  //      — passed via channelDefaults when session has a messaging_group.
  //   3. Per-agent container.json (defaultModel / defaultEffort) —
  //      applies to every channel wired to this agent unless (2) overrides.
  //   4. Host env (ANTHROPIC_DEFAULT_OPUS_MODEL / NANOCLAW_DEFAULT_EFFORT).
  //   5. Hardcoded fallback 'claude-opus-4-7[1m]' / 'medium'.
  //
  // ANTHROPIC_DEFAULT_OPUS_MODEL is the SDK's opus-alias resolver
  // short-circuit: whatever string is here gets sent to the API
  // verbatim when the agent or a subagent uses the bare `opus` alias.
  const defaultOpusModel =
    channelDefaults?.channelDefaultModel ??
    containerConfig.defaultModel ??
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    'claude-opus-4-7[1m]';
  args.push('-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${defaultOpusModel}`);
  // Sonnet alias pin — same short-circuit path as opus. Bare 4-6 id (no
  // [1m] extended-context suffix); extended context is opt-in per query.
  const defaultSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-4-6';
  args.push('-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${defaultSonnetModel}`);

  const defaultEffort =
    channelDefaults?.channelDefaultEffort ??
    containerConfig.defaultEffort ??
    process.env.NANOCLAW_DEFAULT_EFFORT ??
    'medium';
  args.push('-e', `CLAUDE_CODE_EFFORT_LEVEL=${defaultEffort}`);

  // Per-channel default tone profile — ports v1's "always-on tone" feature.
  // Precedence: per-channel wiring (messaging_group_agents.default_tone) →
  // per-agent container.json `tone` → unset (agent falls back to the
  // get_tone_profile MCP tool for on-demand selection). Profile content
  // injection happens container-side in agent-runner/src/index.ts.
  const defaultTone = channelDefaults?.channelDefaultTone ?? containerConfig.tone ?? null;
  if (defaultTone) {
    args.push('-e', `NANOCLAW_DEFAULT_TONE=${defaultTone}`);
  }
  // v1 settings.json env block (src/container-runner.ts:1703-1709): SDK
  // capabilities that need explicit opt-in. Porting as plain env since
  // v2's container reads env, not a settings.json mount point.
  args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  args.push('-e', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1');
  args.push('-e', 'ENABLE_TOOL_SEARCH=true');

  // Optional non-Anthropic routing: when ANTHROPIC_BASE_URL is set on the
  // host, forward it + ANTHROPIC_API_KEY + any ANTHROPIC_API_KEY_N
  // fallbacks to the container so the SDK talks to that endpoint instead
  // of going through the OneCLI proxy. The container's claude provider
  // rotates through the _N keys on retryable errors (429, rate_limit,
  // overloaded, upstream_error, External provider returned).
  //
  // Gated on ANTHROPIC_BASE_URL: without it, keys aren't forwarded and
  // OneCLI's HTTPS proxy injects credentials at request time (default path).
  if (process.env.ANTHROPIC_BASE_URL) {
    args.push('-e', `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    if (process.env.ANTHROPIC_API_KEY) {
      args.push('-e', `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    for (const [k, v] of Object.entries(process.env)) {
      if (/^ANTHROPIC_API_KEY_\d+$/.test(k) && v) {
        args.push('-e', `${k}=${v}`);
      }
    }
  }

  // OAuth path (Claude Max subscription). When CLAUDE_CODE_OAUTH_TOKEN is
  // set on the host we forward it + any CLAUDE_CODE_OAUTH_TOKEN_N fallbacks
  // so the provider can rotate through multiple Max accounts on retryable
  // errors (weekly cap, 429, rate_limit). The OneCLI proxy is still applied
  // below, but we add api.anthropic.com to NO_PROXY so Anthropic traffic
  // bypasses OneCLI's credential-injection layer — otherwise the proxy
  // overwrites whatever OAuth the SDK sent with the single vault entry,
  // defeating in-process rotation. Everything else (Gmail, GitHub, Exa,
  // Braintrust, etc.) still routes through OneCLI.
  const hostOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const oauthBypassAnthropic = Boolean(hostOauth);
  if (hostOauth) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
    for (const [k, v] of Object.entries(process.env)) {
      if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(k) && v) {
        args.push('-e', `${k}=${v}`);
      }
    }
  }

  // GitHub token for git-over-HTTPS + `gh` CLI. Per-agent-group: resolves
  // from container.json `githubTokenEnv`, then from
  // `GITHUB_TOKEN_<FOLDER_UPPER>`, then falls back to `GITHUB_TOKEN`.
  // OneCLI's proxy model doesn't fit git auth — we pass the real token.
  const ghToken = resolveGitHubToken(agentGroup.folder, containerConfig);
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
    // Optional URL-scoped credential allowlist. When set, entrypoint.sh
    // configures git's credential helper to only return the token for the
    // listed orgs (comma-separated), and skips the global `gh auth login`
    // so gh's own auth store can't bypass the URL scope. Without this,
    // a container with a broad GitHub token can clone/push to any org
    // the token grants. Per-agent-group via GITHUB_ALLOWED_ORGS_<FOLDER>.
    const ghOrgs = resolveScopedEnv('GITHUB_ALLOWED_ORGS', agentGroup.folder);
    if (ghOrgs) args.push('-e', `GITHUB_ALLOWED_ORGS=${ghOrgs}`);
  } else {
    log.warn('No GitHub token resolved for agent group — git push/PR will fail', {
      folder: agentGroup.folder,
    });
  }

  // Claude Code SDK reads this to discover plugins at
  // /workspace/plugins/<name>/ (mounted by buildMounts from ~/plugins/).
  args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');

  // Scoped credential env vars: each base resolves via
  // `<BASE>_<FOLDER_UPPER>` → `<BASE>` and is injected if found.
  for (const base of SCOPED_CREDENTIAL_VARS) {
    const v = resolveScopedEnv(base, agentGroup.folder);
    if (v) args.push('-e', `${base}=${v}`);
  }

  // Folder-scoped verbatim env vars: pass through env vars whose name starts
  // with a known prefix AND whose name includes the folder token. These are
  // raw connection strings (RENDER_PG_URL_ILLYSIUM_ILLYSE_MAIN, etc.) that
  // don't collapse to a base name — the agent uses the full name as-is.
  // Gate on folder to keep cross-group data access from leaking.
  const folderTok = agentGroup.folder.toUpperCase().replace(/-/g, '_');
  const verbatimPrefixes = ['RENDER_PG_', 'RENDER_REDIS_URL_'];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (!verbatimPrefixes.some((p) => k.startsWith(p))) continue;
    if (!k.includes(`_${folderTok}_`) && !k.endsWith(`_${folderTok}`)) continue;
    args.push('-e', `${k}=${v}`);
  }

  // Per-group opt-in flags from container.json.
  if (containerConfig.gitnexusInjectAgentsMd) {
    args.push('-e', 'GITNEXUS_INJECT_AGENTS_MD=true');
  }
  if (containerConfig.ollamaAdminTools) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Users allowed to run admin commands (e.g. /clear) inside this container.
  // Computed at wake time: owners + global admins + admins scoped to this
  // agent group. Role changes take effect on next container spawn.
  //
  // SQL inlined to keep core independent of the permissions module — we
  // guard on the `user_roles` table directly. If the permissions module
  // isn't installed, the table doesn't exist and the set stays empty; the
  // formatter treats an empty admin set as permissionless mode (every
  // sender is admin).
  const adminUserIds = new Set<string>();
  if (hasTable(getDb(), 'user_roles')) {
    const db = getDb();
    const owners = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL")
      .all() as Array<{ user_id: string }>;
    const globalAdmins = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id IS NULL")
      .all() as Array<{ user_id: string }>;
    const scopedAdmins = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' AND agent_group_id = ?")
      .all(agentGroup.id) as Array<{ user_id: string }>;
    for (const r of owners) adminUserIds.add(r.user_id);
    for (const r of globalAdmins) adminUserIds.add(r.user_id);
    for (const r of scopedAdmins) adminUserIds.add(r.user_id);
  }
  if (adminUserIds.size > 0) {
    args.push('-e', `NANOCLAW_ADMIN_USER_IDS=${Array.from(adminUserIds).join(',')}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
  //
  // Skipped entirely when the operator is running a non-Anthropic routing
  // proxy via ANTHROPIC_BASE_URL. The two paths are mutually exclusive:
  // OneCLI intercepts outbound HTTPS at the TCP layer, which would
  // interfere with openlimits / custom-proxy auth. In the BASE_URL path,
  // ANTHROPIC_API_KEY (+ _N fallbacks) forwarded directly by the
  // env-forwarding block above provide auth without OneCLI.
  if (process.env.ANTHROPIC_BASE_URL) {
    log.info('Skipping OneCLI gateway — ANTHROPIC_BASE_URL set, using direct proxy', { containerName });
  } else {
    try {
      if (agentIdentifier) {
        await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
      }
      const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
      if (onecliApplied) {
        log.info('OneCLI gateway applied', { containerName });
      } else {
        log.warn('OneCLI gateway not applied — container will have no credentials', { containerName });
      }
    } catch (err) {
      log.warn('OneCLI gateway error — container will have no credentials', { containerName, err });
    }

    // OAuth bypass: when a host OAuth token is forwarded, tell the
    // in-container HTTPS_PROXY (just configured by OneCLI) to skip
    // api.anthropic.com. Without this, OneCLI's proxy would intercept the
    // Anthropic request and substitute the single vault credential,
    // defeating the provider-level rotation across CLAUDE_CODE_OAUTH_TOKEN_N.
    // We merge with any existing NO_PROXY rather than overwrite so localhost /
    // onecli internal bypasses that OneCLI added stay intact.
    //
    // Also re-append the real OAuth token values AFTER OneCLI applied,
    // because OneCLI injects `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` to
    // make the SDK happy while relying on its proxy to substitute the real
    // token at request time. Under the bypass path the proxy never fires
    // for api.anthropic.com, so the placeholder would be sent verbatim and
    // the API would reject it as an invalid bearer. Docker's `-e` duplicate-
    // key semantics: last entry wins, so pushing our real values after
    // OneCLI's placeholder is all we need.
    if (oauthBypassAnthropic) {
      mergeNoProxy(args, 'api.anthropic.com');
      stripEnvEntry(args, 'CLAUDE_CODE_OAUTH_TOKEN');
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
      for (const [k, v] of Object.entries(process.env)) {
        if (/^CLAUDE_CODE_OAUTH_TOKEN_\d+$/.test(k) && v) {
          stripEnvEntry(args, k);
          args.push('-e', `${k}=${v}`);
        }
      }
    }
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Assemble additional MCP servers: container.json's mcpServers (stdio
  // subprocesses the group declares) plus tool-driven remote servers
  // wired here when the tool is enabled (container.json `tools` array).
  // Tool-driven HTTP MCP servers rely on the container's HTTPS_PROXY
  // pointing at OneCLI's gateway — the container never sees the token;
  // OneCLI injects the appropriate header per its registered secret
  // (e.g. `Authorization: Bearer <granola-token>` for mcp.granola.ai).
  // Universal HTTP/stdio MCPs (deepwiki, context7, granola, exa, pocket) are
  // ungated — always injected when the relevant key is present on the host.
  // Per-group mcpServers from container.json are merged on top so groups can
  // still override or add extras.
  const mcpServers: Record<string, unknown> = { ...(containerConfig.mcpServers ?? {}) };
  // Opt-out denylist. Default behavior: universal MCPs are injected in every
  // container. A group drops any of them by naming them here in container.json:
  //   "excludeMcpServers": ["pocket", "granola"]
  const mcpExcluded = new Set(containerConfig.excludeMcpServers ?? []);
  const canInject = (name: string): boolean => !mcpExcluded.has(name) && !mcpServers[name];

  if (canInject('granola')) {
    mcpServers.granola = { type: 'http', url: 'https://mcp.granola.ai/mcp' };
  }
  if (canInject('deepwiki')) {
    mcpServers.deepwiki = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };
  }
  if (canInject('context7')) {
    mcpServers.context7 = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: {},
    };
  }
  if (process.env.EXA_API_KEY && canInject('exa')) {
    mcpServers.exa = {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa,company_research_exa,people_search_exa,deep_researcher_start,deep_researcher_check,deep_search_exa',
      headers: { 'x-api-key': process.env.EXA_API_KEY },
    };
  }
  if (process.env.POCKET_API_KEY && canInject('pocket')) {
    mcpServers.pocket = {
      type: 'http',
      url: 'https://public.heypocketai.com/mcp',
      headers: { Authorization: `Bearer ${process.env.POCKET_API_KEY}` },
    };
  }
  if (Object.keys(mcpServers).length > 0) {
    args.push('-e', `NANOCLAW_MCP_SERVERS=${JSON.stringify(mcpServers)}`);
  }

  // Override entrypoint so we skip tini's stdin-read wait (host-spawned
  // sessions don't pipe stdin — all IO flows through the mounted session
  // DBs). Run the image's entrypoint.sh directly so our XDG / gws /
  // GitHub-auth / Render / GitNexus setup still fires before bun starts.
  args.push('--entrypoint', 'bash');

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec /app/entrypoint.sh');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const containerConfig = readContainerConfig(agentGroup.folder);
  const aptPackages = containerConfig.packages.apt;
  const npmPackages = containerConfig.packages.npm;

  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `nanoclaw-agent:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 300_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in groups/<folder>/container.json
  containerConfig.imageTag = imageTag;
  writeContainerConfig(agentGroup.folder, containerConfig);

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
