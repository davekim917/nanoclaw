/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each one validates input
 * and queues an approval request. The admin's approval triggers the
 * matching approval handler in ./apply.ts, which also performs the
 * required follow-up (rebuild+restart for install_packages, restart-only
 * for add_mcp_server).
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  const apt = (content.apt as string[]) || [];
  const npm = (content.npm as string[]) || [];
  const reason = (content.reason as string) || '';

  const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
  const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  const MAX_PACKAGES = 20;
  if (apt.length + npm.length === 0) {
    notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
    return;
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
    return;
  }
  const invalidApt = apt.find((p) => !APT_RE.test(p));
  if (invalidApt) {
    notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
    log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
    return;
  }
  const invalidNpm = npm.find((p) => !NPM_RE.test(p));
  if (invalidNpm) {
    notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
    log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
    return;
  }

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name as string;
  const command = content.command as string;
  if (!serverName || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload: {
      name: serverName,
      command,
      args: (content.args as string[]) || [],
      env: (content.env as Record<string, string>) || {},
    },
    title: 'Add MCP Request',
    question: `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
  });
}

export async function handleChangeModel(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'change_model failed: agent group not found.');
    return;
  }
  const { getContainerConfig } = await import('../../db/container-configs.js');
  const config = getContainerConfig(agentGroup.id);
  if (!config) {
    notifyAgent(session, 'change_model failed: container config not found.');
    return;
  }
  if (!config.provider) {
    notifyAgent(session, 'change_model failed: group has no provider set; cannot validate model.');
    return;
  }

  const slug = content.slug as string;
  const effort = content.effort as string | undefined;
  if (!slug) {
    notifyAgent(session, 'change_model failed: --slug (the model identifier) is required.');
    return;
  }
  if (effort && !['low', 'medium', 'high'].includes(effort)) {
    notifyAgent(session, 'change_model failed: --effort must be one of: low, medium, high.');
    return;
  }

  // Host-side check is only the deny list. The container's list_models tool
  // is the source of truth for "is this slug reachable" — but that runs in
  // the container, not here. We just enforce the operator hard-no.
  const { getDeniedModel } = await import('../../db/denied-models.js');
  const denied = getDeniedModel(config.provider, slug);
  if (denied) {
    notifyAgent(
      session,
      `change_model failed: "${slug}" is in the ${config.provider} deny list${
        denied.reason ? ` (${denied.reason})` : ''
      }.`,
    );
    return;
  }

  const reason = (content.reason as string) || '';
  const question =
    `Agent "${agentGroup.name}" requests model change to:\n` +
    `${slug}` +
    (effort ? `\nEffort: ${effort}` : '') +
    `\nProvider: ${config.provider}` +
    `\nCurrent: ${config.model || '(none)'}${config.effort ? ` / ${config.effort}` : ''}` +
    (reason ? `\nReason: ${reason}` : '') +
    `\n\nThis will restart the container.`;

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'change_model',
    payload: { slug, effort: effort ?? null, reason },
    title: 'Change Model Request',
    question,
  });
}
