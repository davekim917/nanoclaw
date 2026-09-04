/**
 * Guarded handler bodies for self-modification actions.
 *
 * The delivery registry's guard wrapper runs these only on `allow` — which,
 * for self-mod, means an approved replay carrying a valid grant (the
 * decision holds unconditionally from the container path; see ./guard.ts).
 * Each body mutates the container config in the DB, rebuilds/kills the
 * container as needed, and writes an on_wake message so the fresh container
 * picks up where the old one left off.
 *
 * install_packages: update DB + rebuild image + kill container + on_wake.
 * add_mcp_server: update DB + kill container + on_wake.
 *
 * getContainerConfig/updateContainerConfigJson/updateContainerConfigScalars
 * (../../db/container-configs.js) below are generic DB persistence CRUD,
 * shared by every operationally-mutated container-config field (provider,
 * model, packages, mcp_servers, timezone, …) — they hold no MCP-specific
 * validation. The credential/URL/header/name invariants for a remote MCP
 * server all live one layer down, in `parseMcpServerConfig`,
 * `validateMcpServerName`, `isKnownRawSecret`, and `normalizeMcpHeaders`
 * (../../container-config.js) — the single primitive every one of those
 * rules is enforced in, called before any of the DB writes below ever run.
 * A server that reaches these DB writes has already had every header
 * validated as ByteString, deduplicated case-insensitively, and checked
 * against the OneCLI placeholder — this file only persists what
 * normalizeMcpHeaders already approved, and claims nothing about whether the
 * placeholder's underlying secret is actually assigned to this group.
 */
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { getDeniedModel } from '../../db/denied-models.js';
import { getSession } from '../../db/sessions.js';
import { isOpenCodeModelSlug } from '../../flag-parser.js';
import {
  isOneCliPlaceholder,
  parseMcpServerConfig,
  updateContainerConfig,
  validateMcpServerName,
  type ParsedMcpServerConfig,
} from '../../container-config.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent, type ApprovalHandler } from '../approvals/index.js';

export async function applyInstallPackages(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'install_packages approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    await notifyAgent(session, 'install_packages approved but container config missing.');
    return;
  }

  // Append new packages to existing lists in the DB (deduplicated)
  if (payload.apt) {
    const existing = JSON.parse(configRow.packages_apt) as string[];
    for (const pkg of payload.apt as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_apt', existing);
  }
  if (payload.npm) {
    const existing = JSON.parse(configRow.packages_npm) as string[];
    for (const pkg of payload.npm as string[]) {
      if (!existing.includes(pkg)) existing.push(pkg);
    }
    updateContainerConfigJson(agentGroup.id, 'packages_npm', existing);
  }

  const pkgs = [
    ...((payload.apt as string[] | undefined) || []),
    ...((payload.npm as string[] | undefined) || []),
  ].join(', ');
  log.info('Package install approved', { agentGroupId: session.agent_group_id });
  try {
    await buildAgentGroupImage(session.agent_group_id);
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
        sender: 'system',
        senderId: 'system',
      }),
      onWake: 1,
    });
    killContainer(session.id, 'rebuild applied', () => {
      const s = getSession(session.id);
      if (s) {
        void wakeContainer(s).catch((err) =>
          log.error('Failed to wake container after install_packages rebuild', { err, sessionId: session.id }),
        );
      }
    });
    log.info('Container rebuild completed (bundled with install)', { agentGroupId: session.agent_group_id });
  } catch (e) {
    // Best-effort: updateContainerConfigJson above (before this try block)
    // already committed the package list. This handler is reached almost
    // exclusively via approval-replay (reenterGuardedDeliveryAction) — an
    // awaited rejection here would propagate to response-handler.ts's catch,
    // which attempts its own fallback notify; if that ALSO fails, the
    // approval row is never deleted and stays clickable, risking a second
    // buildAgentGroupImage + killContainer for an already-updated config.
    void Promise.resolve(
      notifyAgent(
        session,
        `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Tell the user — an admin will need to retry the install_packages request or inspect the build logs.`,
      ),
    ).catch((err) =>
      log.warn('install_packages failure notification failed', { err, agentGroupId: session.agent_group_id }),
    );
    log.error('Bundled rebuild failed after install approval', { agentGroupId: session.agent_group_id, err: e });
  }
}

export async function applyAddMcpServer(payload: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'add_mcp_server approved but agent group missing.');
    return;
  }

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) {
    await notifyAgent(session, 'add_mcp_server approved but container config missing.');
    return;
  }

  // Re-validate the approved payload before it reaches container.json. The
  // request path already parsed it, but this is the last gate before a config
  // the container will actually load, so it fails closed on its own.
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (!name) {
    void notifyAgent(session, 'add_mcp_server approved but server name is missing.');
    return;
  }
  let serverConfig: ParsedMcpServerConfig;
  try {
    validateMcpServerName(name);
    serverConfig = parseMcpServerConfig(payload);
    // eslint-disable-next-line no-catch-all/no-catch-all -- approval payload validation must fail closed
  } catch (err) {
    void notifyAgent(
      session,
      `add_mcp_server approved but config is invalid: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }

  // Dual-write, exactly as `ncl groups config add-mcp-server` does: the FILE
  // is what the spawn path reads (`readContainerConfig`), the DB column is the
  // projection `groups config get` reports and the next file-to-DB backfill
  // would otherwise overwrite. Writing only the DB restarted the container
  // without the server the admin just approved.
  const fileConfig = updateContainerConfig(agentGroup.folder, (config) => {
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers[name] = serverConfig;
  });
  updateContainerConfigJson(agentGroup.id, 'mcp_servers', fileConfig.mcpServers ?? {});

  // Declaring the placeholder wires the header; it does not grant the secret.
  // Keyed on the placeholder VALUE, not on headers being present at all — a
  // server carrying only `Content-Type` authenticates with nothing, and
  // telling its operator to go assign a vault secret would send them after a
  // credential that does not exist.
  const needsCredential =
    serverConfig.type === 'http' && Object.values(serverConfig.headers ?? {}).some(isOneCliPlaceholder);

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      // A remote server declared with a placeholder header still needs the
      // matching vault secret ASSIGNED to this group before the gateway can
      // substitute it. Auto-created agents default to `selective` mode with
      // nothing assigned, so the symptom is a 401 from an API whose
      // credential is in the vault — name the remedy here rather than leave
      // the agent to rediscover it (CLAUDE.md, Secrets / Credentials / OneCLI).
      text:
        `MCP server "${name}" added. Verify it's available (e.g. list your tools) and report the result to the user.` +
        (needsCredential
          ? " It authenticates through the OneCLI gateway: if calls come back 401, one likely cause is that the credential exists but is not assigned to this agent group — an operator adds it to `onecliSecrets` in the group's container.json, or runs `onecli agents set-secrets`. A 401 can also mean an expired or incorrect secret, a missing gateway rule, or an authentication scheme the server doesn't accept."
          : ''),
      sender: 'system',
      senderId: 'system',
    }),
    onWake: 1,
  });
  killContainer(session.id, 'mcp server added', () => {
    const s = getSession(session.id);
    if (s) {
      void wakeContainer(s).catch((err) =>
        log.error('Failed to wake container after add_mcp_server', { err, sessionId: session.id }),
      );
    }
  });
  log.info('MCP server add approved', { agentGroupId: session.agent_group_id });
}

/**
 * Apply a model (+ optional effort) change to an agent group's container config
 * and restart the container. Model changes do NOT require admin approval — the
 * agent's `change_model` tool calls this DIRECTLY (see request.ts); the
 * operator deny list is the only guardrail (re-checked here as defense-in-depth,
 * since a denial may land between an in-flight request and apply). Mirrors how
 * a user changes models with the no-approval `-m` flag. `notify` surfaces
 * failures to the caller's audience (the agent for the direct path).
 */
export async function performModelChange(
  session: Session,
  slug: string,
  effort: string | null,
  notify: (message: string) => void | Promise<void>,
  logContext: Record<string, unknown> = {},
): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notify('change_model failed: agent group missing.');
    return;
  }
  const config = getContainerConfig(agentGroup.id);
  if (!config) {
    await notify('change_model failed: container config missing.');
    return;
  }
  if (!config.provider) {
    await notify('change_model failed: group has no provider — cannot revalidate model.');
    return;
  }

  // Opencode slugs MUST be provider-prefixed (`<provider>/<id>`) — the host
  // derives the routing provider from the prefix. A bare slug (e.g.
  // `kimi-k2.7-code`) would persist and restart into a container that can't
  // resolve the model. The `-m` flag path validates this; mirror it here since
  // change_model now applies with no approval checkpoint. Same check, one source.
  if (config.provider === 'opencode' && !isOpenCodeModelSlug(slug)) {
    await notify(
      `change_model failed: "${slug}" is not a valid opencode slug — it must be provider-prefixed ` +
        `(e.g. opencode-go/kimi-k2.7-code, nvidia/meta/llama-3.3-70b-instruct). Run list_models for exact ids.`,
    );
    return;
  }

  const denied = getDeniedModel(config.provider, slug);
  if (denied) {
    await notify(
      `change_model failed: "${slug}" is in the ${config.provider} deny list${
        denied.reason ? ` (${denied.reason})` : ''
      }. Aborted.`,
    );
    return;
  }

  // Update both model and (optionally) effort scalars in container_configs.
  // Effort is applied alongside so the agent gets a coherent next-spawn state.
  const updates: Parameters<typeof updateContainerConfigScalars>[1] = { model: slug };
  if (effort) updates.effort = effort;
  updateContainerConfigScalars(agentGroup.id, updates);

  log.info('Model change applied', {
    agentGroupId: session.agent_group_id,
    ...logContext,
    previousModel: config.model,
    newModel: slug,
    effort,
  });

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text:
        `Model changed to "${slug}"${effort ? ` (effort: ${effort})` : ''}. Container has restarted on the new model. ` +
        `Briefly confirm what model you're now running, then continue the work.`,
      sender: 'system',
      senderId: 'system',
    }),
    onWake: 1,
  });

  killContainer(session.id, 'model changed', () => {
    const s = getSession(session.id);
    if (s) {
      void wakeContainer(s).catch((err) =>
        log.error('Failed to wake container after model change', { err, sessionId: session.id }),
      );
    }
  });
}

/**
 * Legacy approval-path wrapper, retained so any change_model approval record
 * still in flight at deploy time applies cleanly. New requests no longer create
 * approvals (request.ts calls performModelChange directly).
 */
export const applyChangeModel: ApprovalHandler = async ({ session, payload, userId, notify }) => {
  await performModelChange(session, payload.slug as string, payload.effort as string | null, notify, { userId });
};
