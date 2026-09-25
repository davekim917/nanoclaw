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
 * Test fixture: a fresh in-memory central DB with every migration applied.
 * Tests seed through this instead of `runMigrations(getRawDb())` so a new
 * test file never has to name `getRawDb` — the raw-db ratchet pin is
 * shrink-only (plan §4.2), and this module already carries the name.
 */
export async function initMigratedTestDb(): Promise<void> {
  await openTestDb();
  applyAllMigrations(rawHandleForMigrations());
}
