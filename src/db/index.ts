export { initDb, initTestDb, getDb, getRawDb, closeDb } from './connection.js';
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
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
} from './messaging-groups.js';
export {
  createSession,
  getSession,
  findSession,
  getSessionsByAgentGroup,
  getActiveSessions,
  getRunningSessions,
  updateSession,
  deleteSession,
  resetPhantomContainerStatus,
  createPendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
} from './sessions.js';
export { getContainerConfig, ensureContainerConfig } from './container-configs.js';
import { getRawDb as rawHandleForMigrations, initTestDb as openTestDb } from './connection.js';
import { runMigrations as applyAllMigrations } from './migrations/index.js';

/**
 * Test fixture: a fresh in-memory central DB with every migration applied, so test files never name `getRawDb` (the
 * raw-db ratchet is shrink-only).
 */
export async function initMigratedTestDb(): Promise<void> {
  await openTestDb();
  applyAllMigrations(rawHandleForMigrations());
}
