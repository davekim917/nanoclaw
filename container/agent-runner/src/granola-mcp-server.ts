#!/usr/bin/env bun
/**
 * Granola MCP server (stdio). Thin wrapper around the Granola REST API.
 *
 * Replaces the hosted MCP at mcp.granola.ai/mcp — that one uses OAuth session
 * tokens which silently expire (~hours/days). This server uses the static
 * `grn_*` API key vended by Granola's REST API, auto-injected at request time
 * by the OneCLI gateway based on the `public-api.granola.ai` host pattern. No token
 * rotation, no refresh worker, no in-container secret handling.
 *
 * Runs as a standalone process (not folded into the `nanoclaw` MCP) so tools
 * expose to the agent as `mcp__granola__*` — matching the legacy namespace
 * the hosted MCP used, so existing agent CLAUDE.md references keep working.
 *
 * Docs: https://docs.granola.ai/introduction.md
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

const BASE = 'https://public-api.granola.ai/v1';

function log(msg: string): void {
  // MCP protocol uses stdout; logs go to stderr.
  console.error(`[granola-mcp] ${msg}`);
}

async function granolaGet(path: string): Promise<unknown> {
  const url = `${BASE}${path}`;
  // OneCLI's HTTPS proxy intercepts requests to public-api.granola.ai and injects
  // `Authorization: Bearer grn_...` from the vault. We never see the key.
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Granola API ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errResult(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const tools: Tool[] = [
  {
    name: 'list_meetings',
    description:
      'List Granola meeting notes the calling user owns or has received, newest first. Returns a compact summary — call get_meeting for full notes or transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO-8601 timestamp (e.g. "2026-04-01T00:00:00Z"). Only notes created after this are returned.',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from a previous response.',
        },
      },
    },
  },
  {
    name: 'get_meeting',
    description:
      'Fetch a single Granola meeting note by id. Set include_transcript=true to include the raw transcript (can be large — prefer the default summary-only shape when transcripts are not needed).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Granola note id from list_meetings.' },
        include_transcript: {
          type: 'boolean',
          description: 'When true, include the raw transcript in the response.',
          default: false,
        },
      },
      required: ['id'],
    },
  },
];

async function handleCall(name: string, args: Record<string, unknown>) {
  try {
    if (name === 'list_meetings') {
      const params = new URLSearchParams();
      if (typeof args.since === 'string' && args.since) params.set('created_after', args.since);
      if (typeof args.cursor === 'string' && args.cursor) params.set('cursor', args.cursor);
      const query = params.toString() ? `?${params}` : '';
      const data = await granolaGet(`/notes${query}`);
      return ok(JSON.stringify(data, null, 2));
    }
    if (name === 'get_meeting') {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!id) return errResult('id is required');
      const includeTranscript = args.include_transcript === true;
      const path = `/notes/${encodeURIComponent(id)}${includeTranscript ? '?include=transcript' : ''}`;
      const data = await granolaGet(path);
      return ok(JSON.stringify(data, null, 2));
    }
    return errResult(`Unknown tool: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult(msg);
  }
}

async function main(): Promise<void> {
  const server = new Server({ name: 'granola', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleCall(name, args ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`granola MCP ready (${tools.length} tools: ${tools.map((t) => t.name).join(', ')})`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
