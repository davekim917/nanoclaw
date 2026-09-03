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
import './agents.js';
import { registerProviderSpecificSelfModTools } from './self-mod.js';
import './thread-search.js';
import './git-worktrees.js';
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
import { startMcpServer, mountSpawnTools } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

// MCP server runs in its own child process (spawned by the SDK over stdio),
// so the config cache populated by the agent-runner entry point isn't here.
// Tool handlers like backlog/thread-search read agentGroupId via getConfig(),
// which throws if loadConfig() hasn't been called — populate it before tools
// can be invoked.
loadConfig();
registerProviderSpecificSelfModTools();

// Boot the mailbox, then mount spawn tools bifurcated (orchestrator vs child)
// and start the server. This process is spawned by the provider over stdio and
// shares nothing with the runner's process, so it registers and starts the
// mailbox itself.
async function main(): Promise<void> {
  await getAgentMailbox().start(await readMailboxContext());
  await mountSpawnTools();
  await startMcpServer();
  // No stop(): startMcpServer resolves once the stdio transport is connected,
  // and the process then serves tool calls for the rest of the turn.
}

main().catch((err: unknown) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
