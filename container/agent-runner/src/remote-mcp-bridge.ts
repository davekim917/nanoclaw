#!/usr/bin/env bun
/**
 * Generic stdio-to-Streamable-HTTP MCP bridge.
 *
 * Some runtimes only accept stdio MCP servers, while NanoClaw commonly wires
 * hosted HTTP MCPs through OneCLI so credentials are injected at the proxy
 * boundary. This bridge exposes the remote HTTP MCP as a local stdio server
 * without placing real credentials in container.json or process env.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_VERSION = '1.0.0';

function log(msg: string): void {
  // MCP protocol uses stdout; logs go to stderr.
  console.error(`[remote-mcp-bridge] ${msg}`);
}

function remoteName(): string {
  return process.env.REMOTE_MCP_NAME || 'remote';
}

function remoteUrl(): string {
  const url = process.argv[2] || process.env.REMOTE_MCP_URL;
  if (!url) {
    throw new Error('remote MCP URL required as argv[2] or REMOTE_MCP_URL');
  }
  return url;
}

/**
 * The full header map the host/container parser already validated
 * (src/container-config.ts / self-mod.ts's `normalizeMcpHeaders`), passed
 * through as JSON — not just Authorization. A server declared with
 * X-Api-Version or a custom OneCLI-managed placeholder header had every
 * header past Authorization silently dropped here, a narrower set than the
 * one the CLI/template/approval flow validated and reported success on.
 */
export function requestHeaders(): HeadersInit | undefined {
  const raw = process.env.REMOTE_MCP_HEADERS;
  if (!raw) return undefined;
  let headers: unknown;
  try {
    headers = JSON.parse(raw);
  } catch (err) {
    throw new Error(`REMOTE_MCP_HEADERS is not valid JSON: ${errorText(err)}`);
  }
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error('REMOTE_MCP_HEADERS must be a JSON object with string values');
  }
  return Object.keys(headers).length > 0 ? (headers as Record<string, string>) : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const name = remoteName();
  const url = remoteUrl();
  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: requestHeaders(),
    },
  });
  const client = new Client({ name: `${name}-stdio-bridge`, version: DEFAULT_VERSION });

  await client.connect(httpTransport);
  const caps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name, version: client.getServerVersion()?.version ?? DEFAULT_VERSION },
    {
      capabilities: {
        ...(caps.tools ? { tools: {} } : {}),
        ...(caps.resources
          ? { resources: { subscribe: false, listChanged: Boolean(caps.resources.listChanged) } }
          : {}),
        ...(caps.prompts ? { prompts: { listChanged: Boolean(caps.prompts.listChanged) } } : {}),
        ...(caps.completions ? { completions: {} } : {}),
      },
    },
  );

  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => client.listTools(request.params));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await client.callTool(request.params);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Remote MCP error: ${errorText(err)}` }],
          isError: true,
        };
      }
    });
  }

  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => client.listResources(request.params));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
      client.listResourceTemplates(request.params),
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => client.readResource(request.params));
  }

  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => client.listPrompts(request.params));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => client.getPrompt(request.params));
  }

  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => client.complete(request.params));
  }

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);

  process.once('SIGTERM', () => {
    void httpTransport.close().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void httpTransport.close().finally(() => process.exit(0));
  });

  if (!process.env.HTTPS_PROXY) {
    log('WARN: HTTPS_PROXY not set — remote MCP calls may go out unauthenticated');
  }
  log(`${name} bridge ready (${url})`);
}

if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
