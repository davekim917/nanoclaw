/**
 * Backlog + ship-log module.
 *
 * Registers delivery action handlers for backlog and ship-log mutations:
 *   - add_ship_log
 *   - add_backlog_item
 *   - update_backlog_item
 *   - delete_backlog_item
 *
 * The container writes these as system-kind outbound messages; the host reads
 * them during delivery and applies the change to the central DB here.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { addShipLogEntry, addBacklogItem, updateBacklogItem, deleteBacklogItem } from '../../db/backlog.js';

function resolveAgentGroupId(session: Session): string | null {
  return session.agent_group_id;
}

async function handleAddShipLog(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroupId = resolveAgentGroupId(session);
  if (!agentGroupId) return;

  const title = content.title as string;
  if (!title) {
    log.warn('add_ship_log missing title');
    return;
  }

  const id = (content.id as string) || `ship-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  addShipLogEntry({
    id,
    agent_group_id: agentGroupId,
    title,
    description: (content.description as string) || null,
    pr_url: (content.pr_url as string) || null,
    branch: (content.branch as string) || null,
    tags: (content.tags as string) || null,
    shipped_at: (content.shipped_at as string) || new Date().toISOString(),
  });

  log.info('Ship log entry added', { id, title, agentGroupId });
}

async function handleAddBacklogItem(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroupId = resolveAgentGroupId(session);
  if (!agentGroupId) return;

  const title = content.title as string;
  if (!title) {
    log.warn('add_backlog_item missing title');
    return;
  }

  const id = (content.id as string) || `backlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  addBacklogItem({
    id,
    agent_group_id: agentGroupId,
    title,
    description: (content.description as string) || null,
    status: (content.status as 'open' | 'in_progress' | 'resolved' | 'wont_fix') || 'open',
    priority: (content.priority as 'low' | 'medium' | 'high') || 'medium',
    tags: (content.tags as string) || null,
    notes: (content.notes as string) || null,
    created_at: now,
    updated_at: now,
    resolved_at: null,
  });

  log.info('Backlog item added', { id, title, agentGroupId });
}

async function handleUpdateBacklogItem(content: Record<string, unknown>, session: Session): Promise<void> {
  const itemId = content.itemId as string;
  if (!itemId) {
    log.warn('update_backlog_item missing itemId');
    return;
  }

  const agentGroupId = resolveAgentGroupId(session);

  const updates: Parameters<typeof updateBacklogItem>[1] = {};
  if (content.title !== undefined) updates.title = content.title as string;
  if (content.description !== undefined) updates.description = content.description as string;
  if (content.status !== undefined) {
    updates.status = content.status as 'open' | 'in_progress' | 'resolved' | 'wont_fix';
    if (content.status === 'resolved' || content.status === 'wont_fix') {
      updates.resolved_at = new Date().toISOString();
    }
  }
  if (content.priority !== undefined) {
    updates.priority = content.priority as 'low' | 'medium' | 'high';
  }
  if (content.tags !== undefined) updates.tags = content.tags as string;
  if (content.notes !== undefined) updates.notes = content.notes as string;

  const updated = updateBacklogItem(itemId, updates, agentGroupId ?? undefined);
  if (updated) {
    log.info('Backlog item updated', { itemId, updates });
  } else {
    log.warn('update_backlog_item: item not found or unauthorized', { itemId, agentGroupId });
  }
}

async function handleDeleteBacklogItem(content: Record<string, unknown>, session: Session): Promise<void> {
  const itemId = content.itemId as string;
  if (!itemId) {
    log.warn('delete_backlog_item missing itemId');
    return;
  }

  const agentGroupId = resolveAgentGroupId(session);
  if (!agentGroupId) {
    log.warn('delete_backlog_item: no agent group id');
    return;
  }

  const deleted = deleteBacklogItem(itemId, agentGroupId);
  if (deleted) {
    log.info('Backlog item deleted', { itemId, agentGroupId });
  } else {
    log.warn('delete_backlog_item: item not found or unauthorized', { itemId, agentGroupId });
  }
}

registerDeliveryAction('add_ship_log', async (content, session) => {
  await handleAddShipLog(content, session);
});

registerDeliveryAction('add_backlog_item', async (content, session) => {
  await handleAddBacklogItem(content, session);
});

registerDeliveryAction('update_backlog_item', async (content, session) => {
  await handleUpdateBacklogItem(content, session);
});

registerDeliveryAction('delete_backlog_item', async (content, session) => {
  await handleDeleteBacklogItem(content, session);
});
