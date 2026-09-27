/** MCP server names NanoClaw has removed; a stale entry would make the SDK report a failed server on every spawn. */
const RETIRED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['slack-user-token']);

/** Applied once, after container.json and NANOCLAW_MCP_SERVERS are merged, so no config source can bring one back. */
export function dropRetiredMcpServers(servers: Record<string, unknown>, log: (message: string) => void): void {
  for (const name of Object.keys(servers)) {
    if (!RETIRED_MCP_SERVER_NAMES.has(name)) continue;
    delete servers[name];
    log(`Ignored MCP server ${name}: retired (see docs/slack-user-token.md); remove it from container.json`);
  }
}
