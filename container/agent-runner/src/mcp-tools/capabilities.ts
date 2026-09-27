/**
 * get_capabilities: the DETAIL half of the capability surface. The pre-turn block carries only a one-line
 * roster; this serves a service's full prose verbatim from the host-written /workspace/capabilities.json.
 */
import fs from 'fs';

import { registerTools } from './server.js';
import { err, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

const CAPABILITIES_PATH = '/workspace/capabilities.json';

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

/** Every handle a service answers to (display name, CLI binary, MCP namespace, bare server name), case-insensitive. */
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

/** Exact handle match wins; a prefix match is the fallback and resolves only when unambiguous (several services share `curl`). */
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
