import { cwdWrappedArgv } from './cwd-shim.js';
import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote Streamable HTTP server). */
type OpenCodeMcpRemote = {
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
    // OpenCode's local MCP entry is a bare argv array with no cwd field, so a
    // plugin server that declares one is wrapped through /bin/sh the same way
    // cwd-shim.ts does for Claude — never launched silently in the wrong
    // directory.
    const command = cfg.cwd
      ? cwdWrappedArgv(cfg.cwd, cfg.command, cfg.args ?? [])
      : [cfg.command, ...(cfg.args ?? [])];
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
