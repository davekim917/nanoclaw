/**
 * `create_agent` delivery-action handler.
 *
 * Spawns a new agent group on demand from the parent agent, wires bidirectional
 * agent_destinations rows, projects the new destination into the parent's
 * running container, and notifies the parent.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { readContainerConfig, updateContainerConfig } from '../../container-config.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';
import { bootstrapMemoryForGroup } from '../memory/bootstrap.js';

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
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Best-effort folder rollback. Returns true on clean removal, false when
 * fs.rmSync itself failed — in which case an orphan directory persists on
 * disk and the caller should surface that to the user via notifyAgent so
 * they know manual cleanup may be needed.
 */
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
  const requestId = content.requestId as string;
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

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    await notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return;
  }

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    await notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    await notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: provider ?? null,
    created_at: now,
  };

  // STEP 1: Create folder + baseline container.json + CLAUDE.local.md + skills
  //         symlinks. initGroupFilesystem is idempotent; writes an empty
  //         container.json via initContainerConfig.
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

  // STEP 2: Mutate container.json to set provider + providerConfig +
  //         agentGroupId. Persisting agentGroupId BEFORE the DB insert
  //         (rather than after) means a downstream failure can't leave us
  //         in the awkward state where the DB has the row but container.json
  //         lacks the ID — recovery from that state currently isn't supported
  //         by enable-memory.ts (Codex F9). Doing it before DB-insert keeps
  //         the rollback story clean: any failure here also rolls back the
  //         folder via safeRemoveFolder.
  try {
    updateContainerConfig(folder, (c) => {
      c.agentGroupId = agentGroupId;
      if (provider !== undefined) c.provider = provider;
      if (providerConfig !== undefined) c.providerConfig = providerConfig;
    });
  } catch (err) {
    log.error('create_agent: updateContainerConfig failed, rolling back folder', { err, folder });
    const cleaned = safeRemoveFolder(folder);
    await notifyAgent(
      session,
      `create_agent failed: could not write config for "${name}".${orphanSuffix(folder, cleaned)}`,
    );
    return;
  }

  // STEP 3: DB INSERT. On failure, rollback the folder from step 1
  //         (including the agentGroupId / provider config written in step 2).
  try {
    createAgentGroup(newGroup);
  } catch (err) {
    log.error('create_agent: createAgentGroup failed, rolling back folder', { err, folder });
    const cleaned = safeRemoveFolder(folder);
    await notifyAgent(
      session,
      `create_agent failed: database insert failed for "${name}".${orphanSuffix(folder, cleaned)}`,
    );
    return;
  }

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Memory bootstrap (Codex F5). New groups default to memory.enabled = true
  // via emptyConfig(); a child group born here without an explicit override
  // therefore gets the flag flipped on but never has its sources/ subdirs,
  // mnemon store, or synth task scaffolded — leaving the container with
  // MNEMON_STORE set but the daemon with nothing to write into. Run the
  // shared bootstrap here so default-on groups are fully functional from
  // first message. (agentGroupId was persisted into container.json in
  // step 2, so the daemon's discoverMemoryGroups can read it directly.)
  try {
    const cfg = readContainerConfig(folder);
    if (cfg.memory?.enabled === true) {
      const bs = await bootstrapMemoryForGroup(folder, agentGroupId);
      log.info('Memory bootstrap completed for new agent group', {
        agentGroupId,
        folder,
        sourcesDirs: bs.step1_sourcesDirsCreated,
        mnemonStore: bs.step2_mnemonStoreStatus,
        synthTask: bs.step3_synthTaskScheduled,
      });
    }
  } catch (err) {
    // Don't fail the agent creation — the group is fully created in the DB
    // and container.json already has agentGroupId, so enable-memory.ts CAN
    // retry recovery. Log loud so the gap is visible.
    log.error('create_agent: memory bootstrap failed (group still created, run enable-memory.ts to retry)', {
      err,
      agentGroupId,
      folder,
    });
  }

  // notifyAgent is async since the writeSessionMessage signature change.
  // Awaiting ensures the notification (and its recall_context, if any) commits
  // and the container wakes only after both rows are written.
  await notifyAgent(
    session,
    `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
  );
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
  // Note: requestId is unused — this is fire-and-forget, not request/response.
  void requestId;
}
