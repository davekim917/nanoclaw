export { initDb, initTestDb, getDb, getRawDb, closeDb, hasTable, hasTableRaw } from './connection.js';
export type { DbConfig, DbDriver, DbInitOptions, RunResult } from './driver.js';
export { runMigrations } from './migrations/index.js';
export {
  createAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
  updateAgentGroup,
  deleteAgentGroup,
} from './agent-groups.js';
export {
  createMessagingGroup,
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getAllMessagingGroups,
  getMessagingGroupsByChannel,
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
} from './messaging-groups.js';
export {
  createSession,
  getSession,
  findSession,
  findSessionByAgentGroup,
  getSessionsByAgentGroup,
  getActiveSessions,
  getRunningSessions,
  updateSession,
  deleteSession,
  resetPhantomContainerStatus,
  createPendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
  createPendingApproval,
  getPendingApproval,
  updatePendingApprovalStatus,
  deletePendingApproval,
  getPendingApprovalsByAction,
} from './sessions.js';
export {
  addShipLogEntry,
  getShipLog,
  getShipLogPaginated,
  getShipLogSince,
  getBacklogItemById,
  addBacklogItem,
  updateBacklogItem,
  deleteBacklogItem,
  getBacklog,
  getBacklogPaginated,
  getBacklogResolvedSince,
  getCommitDigestState,
  upsertCommitDigestState,
  type ShipLogEntry,
  type BacklogItem,
  type CommitDigestState,
} from './backlog.js';
export {
  getContainerConfig,
  getAllContainerConfigs,
  createContainerConfig,
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
  deleteContainerConfig,
} from './container-configs.js';
export { recordChoiceReceipt, getChoiceReceipt, type ChoiceReceipt, type ChoiceReceiptRow } from './choice-receipts.js';
export {
  listDeniedModels,
  getDeniedModel,
  isDeniedModel,
  addDeniedModel,
  removeDeniedModel,
  type DeniedModel,
} from './denied-models.js';

import { getRawDb as rawHandleForMigrations, initTestDb as openTestDb } from './connection.js';
import { runMigrations as applyAllMigrations } from './migrations/index.js';

/**
 * Test fixture: a fresh in-memory central DB with every migration applied.
 * Tests seed through this instead of `runMigrations(getRawDb())` so a new
 * test file never has to name `getRawDb` — the raw-db ratchet pin is
 * shrink-only (plan §4.2), and this module already carries the name.
 */
export async function initMigratedTestDb(): Promise<void> {
  await openTestDb();
  applyAllMigrations(rawHandleForMigrations());
}
