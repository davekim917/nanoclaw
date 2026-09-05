/**
 * `create_agent` delivery-action bodies.
 *
 * SECURITY: spawning a new agent group is a host-level state change (creates
 * a directory under groups/, inserts an agent_groups row, and opens bidirectional
 * agent_destinations grants). Any tenant agent can
 * call this — but allowing direct execution lets prompt injection in any
 * tenant chat fan out unbounded child groups, each with its own credentials
 * and recurring tasks. This handler now requests an owner/admin approval and
 * the actual creation runs only on click via `applyCreateAgent`.
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
 * Best-effort folder rollback. Returns true on clean removal, false when
 * fs.rmSync itself failed — in which case an orphan directory persists on
 * disk and the caller should surface that to the user via notifyAgent so
 * they know manual cleanup may be needed.
 */
/**
 * Folder allocation is lookup-then-insert, and every lookup now yields (async
 * driver): two approved create_agent requests with the same or a
 * prefix-colliding name could both validate against the same pre-insert
 * snapshot, both touch one directory, and the loser's rollback would delete
 * the winner's configuration. One in-process lock serializes the whole
 * derivation → validation → filesystem → insert sequence; the host is a
 * single process, and create_agent is operator-approved and rare.
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

  // SECURITY GATE: route through approval. The actual create runs in
  // `applyCreateAgent` only after an owner/admin clicks Approve. Without
  // this gate, prompt injection in any tenant chat could spawn unbounded
  // child agent groups, each with its own credentials and recurring tasks.
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
    // Collision in the creator's destination namespace
    if (await getDestinationByName(sourceGroup.id, localName)) {
      await notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
      return;
    }

    // SECURITY (cross-tenant audit 2026-05-03): cap children per parent. Even
    // with admin approval, an attacker can social-engineer one approval per
    // request — bounding total children per parent prevents resource
    // exhaustion + persistent-foothold accumulation.
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

    // Derive a safe folder name, deduplicated globally across
    // agent_groups.folder AND the on-disk groups/ dir: a folder present on
    // disk with no claiming DB row is deleted-group residue, and adopting it
    // would silently re-scope the old group's data under the new agent's
    // identity — skip to the next suffix instead. Name-squatting is
    // mitigated by the approval gate (operator sees the requested name in
    // the card) rather than by mandatory parent prefix — forcing a
    // parent-folder prefix breaks scoped-env token boundaries (e.g.
    // PARENT_FOLDER__CHILD's tokens overlap with PARENT_FOLDER_*).
    let folder = localName;
    let suffix = 2;
    while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
      folder = `${localName}-${suffix}`;
      suffix++;
    }
    // The suffix can push a 63/64-char name past the folder grammar. A DB-row
    // collision is caught by the prefix guard below (the row's token is a
    // prefix of ours), but disk-only residue has no row, so validate the
    // generated name explicitly rather than persist a folder every provider
    // spawn will refuse (assertValidGroupFolder, src/group-folder.ts).
    assertValidGroupFolder(folder);

    // SECURITY (cross-tenant audit 2026-05-03): folder-name prefix collision
    // would let scoped-env env-var matching cross-leak (e.g. folder=example-agent
    // inheriting EXAMPLE_DEV_* vars from folder=example-dev). Normalize tokens and
    // refuse if any existing folder's token is a prefix of this one or vice
    // versa.
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

    // The child joins the PARENT's workgroup, not a workgroup of its own.
    //
    // Before this, `createAgentGroup` left `workgroup_id` NULL and nothing
    // ever filled it in, so a chat-created child sat outside every workgroup:
    // no shared chat archive, no shared files, and — the one that bites —
    // none of the workgroup's OneCLI secret union, which surfaces as a 401
    // from an API whose credential is demonstrably in the vault. Inheriting
    // is also what makes the child a sibling of its parent rather than a
    // stranger that happens to have a destination grant.
    //
    // A parent with no workgroup (a pre-036 row that never got backfilled)
    // still yields NULL — the same value as before — rather than inventing a
    // workgroup id, because `workgroup_id` is a foreign key into `workgroups`
    // and a fabricated id would fail the insert.
    const workgroupId = sourceGroup.workgroup_id ?? null;

    const newGroup: AgentGroup = {
      id: agentGroupId,
      name,
      folder,
      agent_provider: provider ?? null,
      created_at: now,
      workgroup_id: workgroupId,
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
        // Written HERE, before the DB insert and therefore before any spawn:
        // the spawn path reads container.json, not the DB row, so a child
        // whose workgroup only ever reached the database would boot its first
        // container outside the workgroup's data pool and secret union.
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

    // STEP 3: DB INSERT. On failure, rollback the folder from step 1
    //         (including the agentGroupId / provider config written in step 2).
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

    // Insert bidirectional destination rows (= ACL grants).
    // Creator refers to child by the name it chose; child refers to creator as "parent".
    await createDestination({
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
    // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
    // — forgetting this causes "dropped: unknown destination" when the parent
    // tries to send to the newly-created child.
    await writeDestinations(session.agent_group_id, session.id);

    // notifyAgent is async since the writeSessionMessage signature change.
    // Awaiting ensures the notification commits before the container wakes.
    await notifyAgent(
      session,
      `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
    );
    log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
  } finally {
    // Held through the grants and the destination projection as well: a
    // sibling request must see the finished agent, not a half-built one.
    releaseAllocation();
  }
};
