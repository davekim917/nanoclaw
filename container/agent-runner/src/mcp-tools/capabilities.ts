/**
 * Capability self-awareness MCP tool (Phase 5.3).
 *
 * Reads a host-written JSON snapshot at /workspace/capabilities.json.
 * Container-runner refreshes this file on every spawn, so the data
 * is always current for the session (channels wired, credentials
 * present, plugins loaded, per-group feature flags, etc.).
 *
 * This file is the DETAIL half of a two-part surface. The pre-turn context
 * block carries only a roster — one line per wired service, so no service is
 * ever dropped for budget and the agent always knows what it has
 * (`boundedCapabilities`, src/modules/memory/pre-turn-context.ts). The full
 * `useFor` / `activation` prose for a service — auth, exact tool names, known
 * failure shapes — is served from here, verbatim, by name.
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

interface SnapshotService extends Record<string, unknown> {
  name?: unknown;
  cli?: unknown;
  mcpNamespace?: unknown;
}

function sessionServices(data: Record<string, unknown>): SnapshotService[] {
  const session = data.session;
  if (!session || typeof session !== 'object') return [];
  const services = (session as Record<string, unknown>).services;
  return Array.isArray(services) ? (services.filter((s) => !!s && typeof s === 'object') as SnapshotService[]) : [];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Every handle a service answers to, so the roster line the agent just read is
 * always enough to look the service up: its display name, its CLI binary, its
 * MCP namespace, and the bare server name inside that namespace
 * (`mcp__dbt-mcp__*` -> `dbt-mcp`, which is also what `container.json` calls
 * it). Matching is case-insensitive.
 */
function handlesFor(service: SnapshotService): string[] {
  const handles: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') handles.push(normalize(value));
  };
  push(service.name);
  push(service.cli);
  push(service.mcpNamespace);
  if (typeof service.mcpNamespace === 'string') {
    push(service.mcpNamespace.replace(/^mcp__/, '').replace(/__\*$/, ''));
  }
  return handles;
}

/**
 * Resolve `service` to one entry. Exact handle match wins outright; a prefix
 * match is the fallback so "Google Workspace" and "google" both land, and
 * "curl" — which several REST-only services share as their `cli` — resolves
 * only when it is unambiguous, rather than silently handing back whichever
 * entry was authored first.
 */
export function findCapabilityService(
  services: SnapshotService[],
  query: string,
): { match: SnapshotService } | { ambiguous: string[] } | { missing: true } {
  const wanted = normalize(query);
  if (wanted === '') return { missing: true };
  const exact = services.filter((service) => handlesFor(service).includes(wanted));
  if (exact.length === 1) return { match: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact.map((s) => String(s.name ?? '(unnamed)')) };
  const prefixed = services.filter((service) => handlesFor(service).some((handle) => handle.startsWith(wanted)));
  if (prefixed.length === 1) return { match: prefixed[0]! };
  if (prefixed.length > 1) return { ambiguous: prefixed.map((s) => String(s.name ?? '(unnamed)')) };
  return { missing: true };
}

const getCapabilitiesTool: McpToolDefinition = {
  tool: {
    name: 'get_capabilities',
    description:
      'Full usage notes for a service wired into THIS session, plus the live install snapshot. Your pre-turn context lists every service you have as a one-line roster; this tool is where that line\'s detail lives. Pass `service: "<name>"` (the roster name, the CLI, or the MCP namespace — case-insensitive) BEFORE your first use of that service in a session: you get its auth setup, the exact activation step, the real tool/endpoint names, and its known failure shapes (e.g. a CLI that reports `auth_method: none` while its credentials sit on disk). `section: "session"` returns every wired service in full; other sections (channels, credentials, plugins, agentGroups, messagingGroupsByChannel, credentialEnvSet) describe the install; omit both for everything. Never tell a user a service is unavailable without reading its entry here first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        service: {
          type: 'string',
          description:
            'Optional: one service from your capability roster, by name, CLI, or MCP namespace (case-insensitive) — e.g. "Looker", "hex", "mcp__dbt-mcp__*". Returns that service\'s complete entry.',
        },
        section: {
          type: 'string',
          description:
            'Optional: limit output to one section (session, channels, credentials, plugins, agentGroups, messagingGroupsByChannel, credentialEnvSet). Omit for all.',
        },
      },
    },
  },
  handler: async (args: Record<string, unknown>) => readCapabilities(args, CAPABILITIES_PATH),
};

/**
 * The tool body, with the snapshot path passed in so tests drive the real
 * code rather than a paraphrase of it.
 */
export function readCapabilities(args: Record<string, unknown>, snapshotPath: string) {
  if (!fs.existsSync(snapshotPath)) {
    return err(
      'Capabilities snapshot not found. Either this container was spawned by an older host, or the snapshot failed to write. Ask host to spawn a fresh container.',
    );
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  } catch (e) {
    return err(`Failed to parse capabilities.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const service = typeof args.service === 'string' ? args.service : undefined;
  if (service !== undefined) {
    const services = sessionServices(data);
    if (services.length === 0) {
      return err(
        'This snapshot carries no per-session service list, so there is nothing to look up by name. Omit `service` for the install-wide snapshot.',
      );
    }
    const found = findCapabilityService(services, service);
    if ('match' in found) {
      // Verbatim. The roster the agent read is a reduction of this entry;
      // this is the text that reduction was made from, unchanged.
      return ok(JSON.stringify(found.match, null, 2));
    }
    if ('ambiguous' in found) {
      return err(`"${service}" matches more than one service: ${found.ambiguous.join(', ')}. Ask for one by name.`);
    }
    const names = services.map((s) => String(s.name ?? '(unnamed)'));
    return err(`No wired service matches "${service}". Wired in this session: ${names.join(', ')}.`);
  }

  const section = typeof args.section === 'string' ? args.section : undefined;
  const payload = section ? data[section] : data;
  if (section && payload === undefined) {
    return err(`Unknown section: ${section}. Available: ${Object.keys(data).join(', ')}`);
  }

  return ok(JSON.stringify(payload, null, 2));
}

const capabilitiesTools: McpToolDefinition[] = [getCapabilitiesTool];

registerTools(capabilitiesTools);
