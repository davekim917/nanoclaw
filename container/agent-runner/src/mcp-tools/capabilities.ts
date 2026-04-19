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
      'Return a structured snapshot of what this NanoClaw install can do right now: registered channels, mounted credential dirs (Gmail/Calendar/Snowflake/dbt/AWS/gcloud/codex), loaded plugins, per-group feature flags (gitnexus AGENTS.md injection, Ollama admin, exclude-plugins, GitHub token env override), and counts of messaging groups per channel type. Use before declaring an integration "not available" — you may have the creds.',
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
