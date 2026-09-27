/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import { loadConfig } from '../config.js';
// Module barrel — loads registration modules, including the singular mailbox slot.
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import './core.js';
import './interactive.js';
import './request-choice.js';
import './agents.js';
import { registerProviderSpecificSelfModTools } from './self-mod.js';
import './thread-search.js';
import './git-worktrees.js';
import './wiki-admission.js';
import './tone-profiles.js';
import './remote-control.js';
import './capabilities.js';
import './permissions.js';
import './channel-config.js';
import './design-review/index.js';
import './backlog.js';
import './support.js';
import './memory-write.js';
import './work-continuation.js';
import './wait.js';
import './escalate.js';
import './task-list.js';
import { startMcpServer, mountSpawnTools } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// This child process doesn't share the runner's config cache, and tool handlers call getConfig(): load it first.
loadConfig();
registerProviderSpecificSelfModTools();

// Spawned by the provider over stdio, sharing nothing with the runner process, so it starts the mailbox itself.
async function main(): Promise<void> {
  await getAgentMailbox().start(await readMailboxContext());
  await mountSpawnTools();
  await startMcpServer();
}

main().catch((err: unknown) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
