import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote Streamable HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/**
 * Map NanoClaw v2 MCP definitions into OpenCode config `mcp` field.
 * stdio (explicit or implicit) → local, Streamable HTTP → remote.
 * Legacy SSE is intentionally rejected instead of silently preserving a
 * transport that is not part of the cross-harness native baseline.
 */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === 'sse') {
      throw new Error(`MCP server "${name}" uses deprecated SSE transport. Use type: "http" instead.`);
    }
    if (cfg.type === 'http') {
      out[name] = {
        type: 'remote',
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        enabled: true,
      };
      continue;
    }
    const command = [cfg.command, ...(cfg.args ?? [])];
    const env = cfg.env;
    out[name] = {
      type: 'local',
      command,
      ...(env && Object.keys(env).length > 0 ? { environment: env } : {}),
      enabled: true,
    };
  }
  return out;
}
