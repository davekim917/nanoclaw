/**
 * Capability self-awareness MCP tool (Phase 5.3).
 *
 * Reads a host-written JSON snapshot at /workspace/capabilities.json.
 * Container-runner refreshes this file on every spawn, so the data
 * is always current for the session (channels wired, credentials
 * present, plugins loaded, per-group feature flags, etc.).
 *
 * Agent-facing use case: answering "can this install do X?" without
 * the agent having to trial-and-error various integrations. Also
 * useful for self-mod scenarios ("what plugins am I running?").
 */
import fs from 'fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const CAPABILITIES_PATH = '/workspace/capabilities.json';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const getCapabilitiesTool: McpToolDefinition = {
  tool: {
    name: 'get_capabilities',
    description:
      'Live snapshot of what THIS session can actually do — what credentials and CLIs are wired in, and how to activate each one. Section `session.services` is the one that matters most for answering "do I have access?": lists per-service scoped accounts (gws accounts, snowflake connections, aws profiles, …) and the exact activation step (which env var to export) for CLIs whose own auth-status reports are blind without it. Call before saying a service is unavailable — the CLI may report `auth_method: none` even when the accounts are sitting right there on disk. Filter with `section: "session"` for the most relevant slice; omit `section` for the full install + session snapshot.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        section: {
          type: 'string',
          description: 'Optional: limit output to one section (channels, credentials, plugins, agentGroups, messagingGroupsByChannel, credentialEnvSet). Omit for all.',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>) => {
    if (!fs.existsSync(CAPABILITIES_PATH)) {
      return err(
        'Capabilities snapshot not found. Either this container was spawned by an older host, or the snapshot failed to write. Ask host to spawn a fresh container.',
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(fs.readFileSync(CAPABILITIES_PATH, 'utf-8'));
    } catch (e) {
      return err(`Failed to parse capabilities.json: ${e instanceof Error ? e.message : String(e)}`);
    }

    const section = typeof args.section === 'string' ? args.section : undefined;
    const payload = section ? (data as Record<string, unknown>)[section] : data;
    if (section && payload === undefined) {
      return err(`Unknown section: ${section}. Available: ${Object.keys(data).join(', ')}`);
    }

    return ok(JSON.stringify(payload, null, 2));
  },
};

export const capabilitiesTools: McpToolDefinition[] = [getCapabilitiesTool];

registerTools(capabilitiesTools);
