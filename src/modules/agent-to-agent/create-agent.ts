/**
 * `create_agent` delivery-action bodies.
 *
 * SECURITY: any tenant agent can call create_agent, so creation runs only after
 * owner/admin approval (`applyCreateAgent`); otherwise prompt injection in any
 * chat could fan out child groups, each with its own credentials and tasks.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { assertValidGroupFolder, groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { updateContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { requestApproval, type ApprovalHandler } from '../approvals/index.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

export interface CreateAgentFollowUpContext {
  session: Session;
  group: AgentGroup;
  notify: (text: string) => Promise<void>;
}
const createAgentFollowUps = new Set<(context: CreateAgentFollowUpContext) => Promise<void>>();

/** Optional channel setup runs only after approved creation has committed. */
export function registerCreateAgentFollowUp(
  followUp: (context: CreateAgentFollowUpContext) => Promise<void>,
): () => void {
  createAgentFollowUps.add(followUp);
  return () => {
    createAgentFollowUps.delete(followUp);
  };
}

async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) {
    requestWake(fresh, 'agent-created').catch((err) =>
      log.error('Failed to wake container after notification', { err }),
    );
  }
}

/**
 * Folder allocation is lookup-then-insert across awaits: two approved requests
 * with the same or a prefix-colliding name could both validate, and the loser's
 * rollback would delete the winner's configuration. One in-process lock
 * serializes derivation → validation → filesystem → insert.
 */
let folderAllocationChain: Promise<void> = Promise.resolve();
function acquireFolderAllocationLock(): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = folderAllocationChain;
  folderAllocationChain = prior.then(() => gate);
  return prior.then(() => release);
}

function safeRemoveFolder(folder: string): boolean {
  const groupPath = path.resolve(GROUPS_DIR, folder);
  try {
    fs.rmSync(groupPath, { recursive: true, force: true });
    return true;
  } catch (rollbackErr) {
    log.error('create_agent: rollback fs.rmSync failed — orphan folder', {
      folder,
      groupPath,
      err: rollbackErr,
    });
    return false;
  }
}

function orphanSuffix(folder: string, cleaned: boolean): string {
  return cleaned ? '' : ` (orphan folder at groups/${folder} — manual cleanup may be needed)`;
}

export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = (content.requestId as string) || '';
  const name = content.name as string;
  const instructions = content.instructions as string | null;
  const provider = content.provider as string | undefined;
  const providerConfig = content.provider_config as Record<string, unknown> | undefined;

  // Envelope guard — defense in depth; full per-provider validation already
  // happened in the container-side MCP handler.
  if (provider !== undefined && (typeof provider !== 'string' || provider.trim() === '')) {
    await notifyAgent(session, 'create_agent failed: provider must be a non-empty string.');
    return;
  }
  if (
    providerConfig !== undefined &&
    (typeof providerConfig !== 'object' || providerConfig === null || Array.isArray(providerConfig))
  ) {
    await notifyAgent(session, 'create_agent failed: provider_config must be a plain object.');
    return;
  }
  if (typeof name !== 'string' || name.trim() === '') {
    await notifyAgent(session, 'create_agent failed: name must be a non-empty string.');
    return;
  }

  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    await notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  // SECURITY GATE: the create runs in `applyCreateAgent` only after approval.
  const localPreview = normalizeName(name);
  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: {
      name,
      localPreview,
      instructions: instructions ?? null,
      provider: provider ?? null,
      providerConfig: providerConfig ?? null,
      requestId,
    },
    title: 'Create New Agent',
    question:
      `Agent "${sourceGroup.name}" is requesting to create a new agent group "${name}". ` +
      `This creates a new groups/ directory, inserts an agent_groups DB row, opens bidirectional ` +
      `agent_destinations grants, and schedules memory tasks for the child. ` +
      `Approve only if you initiated this — prompt injection in chat can otherwise spawn unbounded child groups.`,
  });
}

export const applyCreateAgent: ApprovalHandler = async ({ session, payload, notify }) => {
  const name = payload.name as string;
  const instructions = (payload.instructions as string | null) ?? null;
  const provider = (payload.provider as string | null) ?? undefined;
  const providerConfig = (payload.providerConfig as Record<string, unknown> | null) ?? undefined;

  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    await notify('create_agent approved but source agent group not found.');
    return;
  }

  const localName = normalizeName(name);

  // The lock covers the PARENT invariants too: two approved requests for one
  // parent could otherwise both pass the destination-name and child-cap
  // checks before either inserts (an orphaned agent group whose grant then
  // hits the parent's primary key, or eleven children under a cap of ten).
  const releaseAllocation = await acquireFolderAllocationLock();
  try {
    if (await getDestinationByName(sourceGroup.id, localName)) {
      await notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
      return;
    }

    // SECURITY: cap children per parent; approval can be social-engineered once per request.
    const CHILDREN_PER_PARENT_CAP = 10;
    const childCount =
      (
        await getDb().get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'agent'",
          sourceGroup.id,
        )
      )?.c ?? 0;
    if (childCount >= CHILDREN_PER_PARENT_CAP) {
      await notifyAgent(
        session,
        `Cannot create agent "${name}": parent agent "${sourceGroup.name}" has reached the child-agent cap (${CHILDREN_PER_PARENT_CAP}). Manually delete unused children before creating more.`,
      );
      log.warn('create_agent: child cap reached', { parent: sourceGroup.id, childCount });
      return;
    }

    // Deduplicated across agent_groups.folder AND on-disk groups/: a folder on
    // disk with no DB row is deleted-group residue, and adopting it would
    // re-scope the old group's data under the new agent. No mandatory parent
    // prefix: it would break scoped-env token boundaries.
    let folder = localName;
    let suffix = 2;
    while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
      folder = `${localName}-${suffix}`;
      suffix++;
    }
    // The suffix can push a name past the folder grammar, and disk-only residue
    // has no row for the prefix guard to catch, so validate explicitly.
    assertValidGroupFolder(folder);

    // SECURITY: a folder-token prefix collision would cross-leak scoped-env vars
    // (folder=example inheriting EXAMPLE_DEV_* from folder=example-dev).
    const newTok = folder.toUpperCase().replace(/-/g, '_');
    for (const existing of await getAllAgentGroups()) {
      if (existing.folder === folder) continue;
      const existTok = existing.folder.toUpperCase().replace(/-/g, '_');
      if (newTok === existTok || newTok.startsWith(existTok + '_') || existTok.startsWith(newTok + '_')) {
        await notifyAgent(
          session,
          `Cannot create agent "${name}": folder "${folder}" collides with existing folder "${existing.folder}" under scoped-env token boundaries. Pick a different name.`,
        );
        log.warn('create_agent: folder token collision', { newFolder: folder, existing: existing.folder });
        return;
      }
    }

    const groupPath = path.join(GROUPS_DIR, folder);
    // Rollback may only remove a directory THIS attempt created.
    const folderPreExisted = fs.existsSync(groupPath);
    const resolvedPath = path.resolve(groupPath);
    const resolvedGroupsDir = path.resolve(GROUPS_DIR);
    if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
      await notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
      log.error('create_agent path traversal attempt', { folder, resolvedPath });
      return;
    }

    const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // The child joins the PARENT's workgroup; without it the child gets none of
    // the workgroup's OneCLI secret union (a 401 from a vaulted API). A parent
    // with no workgroup yields NULL, not an invented id (it is a foreign key).
    const workgroupId = sourceGroup.workgroup_id ?? null;

    const newGroup: AgentGroup = {
      id: agentGroupId,
      name,
      folder,
      agent_provider: provider ?? null,
      created_at: now,
      workgroup_id: workgroupId,
    };

    initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

    // container.json BEFORE the DB insert, so a failure here needs only the
    // folder rolled back.
    try {
      await updateContainerConfig(folder, (c) => {
        c.agentGroupId = agentGroupId;
        // Before any spawn: the spawn path reads container.json, not the DB row,
        // so the first container would otherwise boot outside the workgroup.
        if (workgroupId !== null) c.workgroup_id = workgroupId;
        if (provider !== undefined) c.provider = provider;
        if (providerConfig !== undefined) c.providerConfig = providerConfig;
      });
    } catch (err) {
      log.error('create_agent: updateContainerConfig failed, rolling back folder', { err, folder });
      const cleaned = folderPreExisted ? false : safeRemoveFolder(folder);
      await notifyAgent(
        session,
        `create_agent failed: could not write config for "${name}".${orphanSuffix(folder, cleaned)}`,
      );
      return;
    }

    // On failure, roll back the folder.
    try {
      await createAgentGroup(newGroup);
    } catch (err) {
      log.error('create_agent: createAgentGroup failed, rolling back folder', { err, folder });
      const cleaned = folderPreExisted ? false : safeRemoveFolder(folder);
      await notifyAgent(
        session,
        `create_agent failed: database insert failed for "${name}".${orphanSuffix(folder, cleaned)}`,
      );
      return;
    }

    // Bidirectional destination rows (= ACL grants); the child calls its creator "parent".
    await createDestination({
      agent_group_id: sourceGroup.id,
      local_name: localName,
      target_type: 'agent',
      target_id: agentGroupId,
      created_at: now,
    });
    let parentName = 'parent';
    let parentSuffix = 2;
    while (await getDestinationByName(agentGroupId, parentName)) {
      parentName = `parent-${parentSuffix}`;
      parentSuffix++;
    }
    await createDestination({
      agent_group_id: agentGroupId,
      local_name: parentName,
      target_type: 'agent',
      target_id: sourceGroup.id,
      created_at: now,
    });

    // REQUIRED: project the new destination into the running container's
    // inbound.db, or the parent's first send is "dropped: unknown destination".
    await writeDestinations(session.agent_group_id, session.id);

    // Awaited so the notification commits before the container wakes.
    await notifyAgent(
      session,
      `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
    );
    log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
    for (const followUp of createAgentFollowUps) {
      try {
        await followUp({ session, group: newGroup, notify: (text) => notifyAgent(session, text) });
      } catch (error) {
        // The group and grants are already committed; optional channel setup
        // must not roll them back.
        log.warn('Agent created; optional channel follow-up failed', { agentGroupId, err: error });
      }
    }
  } finally {
    // Held through the grants and the destination projection as well: a
    // sibling request must see the finished agent, not a half-built one.
    releaseAllocation();
  }
};
