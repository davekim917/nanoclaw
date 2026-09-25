/**
 * MCP server names NanoClaw once registered itself and has since removed.
 *
 * `slack-user-token` was the korotovsky Slack MCP. Its binary is gone from the
 * image, so a stale entry left in a group's `container.json` — or re-added by
 * `add_mcp_server` — would make the SDK report `failedMcpServers:
 * slack-user-token` on every spawn: the exact notice that once led an agent to
 * conclude Slack was down when `curl https://slack.com/api/*` worked. Slack
 * access is the proxy-injected token, withheld per session by the host
 * (docs/slack-user-token.md), so dropping the
 * name here removes no capability.
 */
const RETIRED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['slack-user-token']);

/**
 * Remove every retired name from the merged server map, in place, logging each
 * one. Applied once (container/agent-runner/src/index.ts), after
 * `container.json` and `NANOCLAW_MCP_SERVERS` are merged, so no source of MCP
 * config can bring a retired server back.
 */
export function dropRetiredMcpServers(servers: Record<string, unknown>, log: (message: string) => void): void {
  for (const name of Object.keys(servers)) {
    if (!RETIRED_MCP_SERVER_NAMES.has(name)) continue;
    delete servers[name];
    log(`Ignored MCP server ${name}: retired (see docs/slack-user-token.md); remove it from container.json`);
  }
}
