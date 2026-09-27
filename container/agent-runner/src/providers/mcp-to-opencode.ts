import { cwdWrappedArgv } from './cwd-shim.js';
import type { McpServerConfig } from './types.js';

type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/** Legacy SSE is rejected rather than preserved: it is outside the cross-harness native baseline. */
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
    // OpenCode's local entry has no cwd field, so a declared cwd is wrapped through /bin/sh rather than ignored.
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
