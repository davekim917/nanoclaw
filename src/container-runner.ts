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

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, ONECLI_URL, TIMEZONE } from './config.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from './db/user-roles.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './delivery.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  markContainerIdle,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeDestinations,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

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
  // changes take effect on wake.
  writeDestinations(agentGroup.id, session.id);
  writeSessionRouting(agentGroup.id, session.id);

  const mounts = buildMounts(agentGroup, session);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(mounts, containerName, session, agentGroup, agentIdentifier);

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

  // Idle timeout: kill container after IDLE_TIMEOUT of no activity
  let idleTimer = setTimeout(() => killContainer(session.id, 'idle timeout'), IDLE_TIMEOUT);

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killContainer(session.id, 'idle timeout'), IDLE_TIMEOUT);
  };

  // Reset idle timer when the host detects new messages_out (called by delivery.ts)
  const entry = activeContainers.get(session.id);
  if (entry) {
    (entry as { resetIdle?: () => void }).resetIdle = resetIdle;
  }

  container.on('close', (code) => {
    clearTimeout(idleTimer);
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    clearTimeout(idleTimer);
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Reset the idle timer for a session's container (called when messages_out are delivered). */
export function resetContainerIdleTimer(sessionId: string): void {
  const entry = activeContainers.get(sessionId) as { resetIdle?: () => void } | undefined;
  entry?.resetIdle?.();
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
 * Resolve the host env var that holds this group's GitHub token.
 * Precedence: container.json `githubTokenEnv` override →
 * `GITHUB_TOKEN_<FOLDER_UPPER>` (dashes→underscores) →
 * `GITHUB_TOKEN` (personal default).
 * Returns `undefined` if none set — caller logs a warning and git push
 * / PR tools will fail cleanly.
 */
function resolveGitHubToken(folder: string, cfg: ContainerConfig): string | undefined {
  if (cfg.githubTokenEnv) {
    const v = process.env[cfg.githubTokenEnv];
    if (v) return v;
  }
  const conventionEnv = `GITHUB_TOKEN_${folder.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[conventionEnv]) return process.env[conventionEnv];
  return process.env.GITHUB_TOKEN;
}

function buildMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {
  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Pulling in upstream
  // built-in skill or agent-runner source updates is an explicit operation
  // (host-mediated tools), not something the spawn path does silently.
  initGroupFilesystem(agentGroup);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Global memory directory — always read-only. Edits to global config
  // happen through the approval flow, not by handing one workspace RW.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skills — initialized once at group creation, persistent thereafter)
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Central message archive at /workspace/archive.db (read-only). Powers
  // the search_threads + resolve_thread_link MCP tools (Phase 2.9/2.10).
  // Separate file from v2.db so only message history is exposed — not
  // privileged central state (pending_approvals, user_roles, etc.).
  const archivePath = path.join(DATA_DIR, 'archive.db');
  if (fs.existsSync(archivePath)) {
    mounts.push({ hostPath: archivePath, containerPath: '/workspace/archive.db', readonly: true });
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
  const projectRoot = path.resolve(GROUPS_DIR, '..');
  const sourceEntries = [
    'src',
    'container',
    'docs',
    'scripts',
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

  // Host-side credential dirs — mount RO when present. v2's model differs
  // from v1's: we don't gate these behind a per-group `tools` array because
  // v2 already trusts the container with its OneCLI agent token (which
  // unlocks everything that agent has access to anyway). If a group needs
  // to exclude a CLI surface, do it via container image customization or
  // explicit deny-mounting, not via implicit tool-list scoping.
  const home = os.homedir();
  const credentialMounts: Array<{ host: string; container: string }> = [
    // Google Workspace — consolidated gws-style (one authorized_user per account)
    { host: path.join(home, '.config', 'gws', 'accounts'), container: '/home/node/.config/gws/accounts' },
    // Legacy Gmail MCP creds (primary)
    { host: path.join(home, '.gmail-mcp'), container: '/home/node/.gmail-mcp' },
    // Google Calendar MCP
    { host: path.join(home, '.config', 'google-calendar-mcp'), container: '/home/node/.config/google-calendar-mcp' },
    // Google Workspace MCP alt path
    {
      host: path.join(home, '.google_workspace_mcp', 'credentials'),
      container: '/home/node/.google_workspace_mcp/credentials',
    },
    // Snowflake connections + keys
    { host: path.join(home, '.snowflake'), container: '/home/node/.snowflake' },
    // AWS creds
    { host: path.join(home, '.aws'), container: '/home/node/.aws' },
    // gcloud service-account JSON keys
    { host: path.join(home, '.gcloud-keys'), container: '/home/node/.gcloud-keys' },
    // dbt profiles + secrets
    { host: path.join(home, '.dbt'), container: '/home/node/.dbt' },
  ];
  for (const m of credentialMounts) {
    if (fs.existsSync(m.host)) {
      mounts.push({ hostPath: m.host, containerPath: m.container, readonly: true });
    }
  }

  // Additional multi-account Gmail MCP dirs (.gmail-mcp-<account>/) —
  // v1 supported per-account setups. Mount each as-is.
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
    // home may not be readable — fine, skip
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  session: Session,
  agentGroup: AgentGroup,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Read once up-front — used for GitHub token resolution, MCP server
  // registration, and image tag selection later in this function.
  const containerConfig = readContainerConfig(agentGroup.folder);

  // Environment
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `AGENT_PROVIDER=${session.agent_provider || agentGroup.agent_provider || 'claude'}`);
  // Two-DB split: container reads inbound.db, writes outbound.db
  args.push('-e', 'SESSION_INBOUND_DB_PATH=/workspace/inbound.db');
  args.push('-e', 'SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db');
  args.push('-e', 'SESSION_HEARTBEAT_PATH=/workspace/.heartbeat');

  if (agentGroup.name) {
    args.push('-e', `NANOCLAW_ASSISTANT_NAME=${agentGroup.name}`);
  }
  args.push('-e', `NANOCLAW_AGENT_GROUP_ID=${agentGroup.id}`);
  args.push('-e', `NANOCLAW_AGENT_GROUP_NAME=${agentGroup.name}`);

  // Claude Code behavior locks — duplicated from settings.json env block so
  // the values are set in the container's process env regardless of the
  // SDK's settings-loading order. Auto-memory is our cross-thread context
  // backbone (Phase 2.8); the compact override keeps us below the hard
  // context limit to avoid silent model-fallback on upstream 400 errors.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=0');
  args.push('-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80');

  // GitHub token for git-over-HTTPS + `gh` CLI. Per-agent-group: resolves
  // from container.json `githubTokenEnv`, then from
  // `GITHUB_TOKEN_<FOLDER_UPPER>` (dashes → underscores), then falls back
  // to `GITHUB_TOKEN`. OneCLI's proxy model doesn't actually fit git
  // auth (see docs/PHASE_2_11_GIT_WORKTREES.md "Credentials — revised"),
  // so we pass the real token into the session's container env like v1
  // did into the host shell. Scope matches v1's per-group tokens.
  const ghToken = resolveGitHubToken(agentGroup.folder, containerConfig);
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
  } else {
    log.warn('No GitHub token resolved for agent group — git push/PR will fail', {
      folder: agentGroup.folder,
    });
  }

  // Claude Code SDK reads this to discover plugins at
  // /workspace/plugins/<name>/ (mounted by buildMounts from ~/plugins/).
  args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');

  // Users allowed to run admin commands (e.g. /clear) inside this container.
  // Computed at wake time: owners + global admins + admins scoped to this
  // agent group. Role changes take effect on next container spawn.
  const adminUserIds = new Set<string>();
  for (const r of getOwners()) adminUserIds.add(r.user_id);
  for (const r of getGlobalAdmins()) adminUserIds.add(r.user_id);
  for (const r of getAdminsOfAgentGroup(agentGroup.id)) adminUserIds.add(r.user_id);
  if (adminUserIds.size > 0) {
    args.push('-e', `NANOCLAW_ADMIN_USER_IDS=${Array.from(adminUserIds).join(',')}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
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

  // Pass additional MCP servers from container config (groups/<folder>/container.json)
  if (containerConfig.mcpServers && Object.keys(containerConfig.mcpServers).length > 0) {
    args.push('-e', `NANOCLAW_MCP_SERVERS=${JSON.stringify(containerConfig.mcpServers)}`);
  }

  // Override entrypoint: compile agent-runner source, run v2 entry point (no stdin)
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  // gh auth setup-git configures git's credential helper to use $GH_TOKEN
  // for github.com. Idempotent. Best-effort (no-op if gh is missing or
  // GH_TOKEN is unset). Runs before node so git-based MCP tools authenticate
  // natively — OneCLI's proxy doesn't cover the github.com host.
  args.push(
    '-c',
    'cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2 && ln -sf /app/node_modules /tmp/dist/node_modules && gh auth setup-git 2>/dev/null; node /tmp/dist/index.js',
  );

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
    dockerfile += `RUN npm install -g ${npmPackages.join(' ')}\n`;
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
