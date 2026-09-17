/**
 * Fleet-wide MCP defaults — the ONE place a tool is added for every group.
 *
 * `data/fleet-mcp-servers.json` holds `mcpServers` entries every container
 * inherits. Adding an MCP is a data edit (`ncl groups config add-mcp-server
 * --fleet …`), never a source edit: the spawn path merges this file into the
 * container's server map (`src/container-runner.ts`, `buildContainerArgs`)
 * and the capability snapshot describes whatever the merge produced
 * (`src/capabilities.ts`), so one write reaches both.
 *
 * Merge order, unchanged from the per-name blocks this replaced:
 *   1. the group's own `container.json` mcpServers — an operator-declared
 *      entry always wins, even for a name the fleet also defines;
 *   2. every fleet entry whose name the group neither declares itself nor
 *      lists in `excludeMcpServers`.
 * That is exactly the old `canInject` predicate (`!excluded.has(name) &&
 * !mcpServers[name]`), kept in one function so the spawn and the snapshot
 * cannot drift apart.
 *
 * `DATA_DIR` is never bind-mounted into a container, and the file carries no
 * credential: remote entries carry the `onecli-managed` placeholder and the
 * OneCLI gateway substitutes the real secret at the proxy boundary.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { validateMcpServers, type McpServerConfig } from './container-config.js';

export const FLEET_MCP_SERVERS_PATH = path.join(DATA_DIR, 'fleet-mcp-servers.json');

interface FleetMcpServersFile {
  version: 1;
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * What a fresh install gets before anyone edits the file: the servers that
 * used to be hardcoded, one `if (canInject('<name>'))` block each, in
 * `buildContainerArgs`. Their `description` is the exact capability text
 * `src/capabilities.ts` used to carry as a hand-written `useFor`, so the
 * snapshot reads identically through the derived path.
 *
 * This constant is the SEED, not the source of truth: `readFleetMcpServers`
 * prefers the file the moment one exists, and every `--fleet` mutation writes
 * the merged result back. Editing it is not how a tool is added — that is
 * `ncl groups config add-mcp-server --fleet`.
 */
export const DEFAULT_FLEET_MCP_SERVERS: Record<string, McpServerConfig> = {
  granola: {
    type: 'stdio',
    command: 'bun',
    args: ['/app/src/granola-mcp-server.ts'],
    displayName: 'Granola',
    // Local stdio MCP wrapping Granola's REST API. Replaces the hosted
    // mcp.granola.ai/mcp endpoint whose OAuth session tokens expired silently
    // every few hours and left agents stuck on "Session expired. Please sign
    // in again." OneCLI injects the static `grn_*` bearer token at the HTTPS
    // proxy based on the `public-api.granola.ai` host pattern — see the
    // `GranolaAPI` vault secret. No refresh worker needed.
    description:
      'Meeting transcripts + notes via Granola REST API. Auth injected by OneCLI on public-api.granola.ai; no token visible in-container. Tools: `mcp__granola__list_meetings`, `mcp__granola__get_meeting` (set include_transcript=true for raw transcript).',
  },
  deepwiki: {
    type: 'http',
    url: 'https://mcp.deepwiki.com/mcp',
    displayName: 'DeepWiki',
    description:
      'AI-powered documentation for any public GitHub repo. Use when the user asks "how does repo X work", for reading wiki structure, fetching wiki contents, or asking free-form questions about a repo. Tools: `mcp__deepwiki__read_wiki_structure`, `mcp__deepwiki__read_wiki_contents`, `mcp__deepwiki__ask_question`.',
  },
  context7: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: {},
    displayName: 'Context7',
    description:
      'Live library / framework / SDK / API docs — React, Next.js, Prisma, Tailwind, Claude SDKs, Stripe, etc. Prefer Context7 over training-memory for: library-specific debugging, API syntax, config options, version migrations, CLI usage. Do NOT use for refactoring, business logic, or general concepts.',
  },
  exa: {
    type: 'http',
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Exa-MCP" → mcp.exa.ai).
    url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run',
    displayName: 'Exa',
    description:
      'Web search, research, and code context. Prefer exa over ad-hoc WebSearch/WebFetch for: web search including code/docs lookups (`mcp__exa__web_search_exa`), reading specific URLs (`mcp__exa__web_fetch_exa`), filtered search — categories (company, people), domains, dates (`mcp__exa__web_search_advanced_exa`), multi-step research agent (`mcp__exa__agent_run`).',
  },
  pocket: {
    type: 'http',
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Pocket" → public.heypocketai.com).
    url: 'https://public.heypocketai.com/mcp',
    displayName: 'Pocket',
    description:
      'Personal knowledge / memory via https://public.heypocketai.com/mcp. Auth pre-injected (Authorization: Bearer). Use Pocket tools to save references, recall prior context, search personal knowledge.',
  },
  littlebird: {
    type: 'http',
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Littlebird" → mcp.littlebird.ai). The bearer is an OAuth
    // access token minted by `ncl integrations login` and kept fresh by the
    // sweep's `mcp-oauth-refresh` duty (`src/host-sweep.ts:768`) — a 401 from
    // this server means the grant needs a fresh login, not a retry.
    url: 'https://mcp.littlebird.ai/mcp',
    displayName: 'Littlebird',
    description:
      'Littlebird workspace: meetings, transcripts, routines, conversations, search. Auth injected by the OneCLI gateway (vault secret Littlebird).',
  },
};

function fail(message: string): never {
  throw new Error(`Invalid fleet MCP defaults at ${FLEET_MCP_SERVERS_PATH}: ${message}`);
}

function parseFile(contents: string): Record<string, McpServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    fail(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('top level must be an object');
  const file = raw as Record<string, unknown>;
  if (file.version !== 1) fail('version must be 1');
  if (Object.keys(file).some((key) => key !== 'version' && key !== 'mcpServers')) {
    fail('only version and mcpServers are allowed at the top level');
  }
  const servers = file.mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    fail('mcpServers must be an object keyed by server name');
  }
  // Same validator the per-group file goes through, so an SSE entry or a
  // provenance-less `cwd` is refused/stripped identically in both places.
  return validateMcpServers(servers as Record<string, McpServerConfig>);
}

/**
 * The fleet defaults in force right now. A missing file is the documented
 * fresh-install state, not an error: it yields `DEFAULT_FLEET_MCP_SERVERS`, so
 * an install that has never run a `--fleet` command behaves exactly as it did
 * when these servers were hardcoded. A malformed file throws — dropping every
 * group's tools silently is the failure mode this repo keeps paying for.
 */
export function readFleetMcpServers(): Record<string, McpServerConfig> {
  let contents: string;
  try {
    contents = fs.readFileSync(FLEET_MCP_SERVERS_PATH, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_FLEET_MCP_SERVERS };
    throw error;
  }
  return parseFile(contents);
}

/** Read-modify-write the fleet file, seeding it from the defaults on first use. */
export function updateFleetMcpServers(
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Record<string, McpServerConfig> {
  const servers = readFleetMcpServers();
  mutate(servers);
  const file: FleetMcpServersFile = { version: 1, mcpServers: validateMcpServers(servers) };
  fs.mkdirSync(path.dirname(FLEET_MCP_SERVERS_PATH), { recursive: true });
  const tmp = `${FLEET_MCP_SERVERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  fs.renameSync(tmp, FLEET_MCP_SERVERS_PATH);
  return servers;
}

/**
 * Every MCP server this group's container ends up with from config alone:
 * its own `container.json` entries, plus the fleet defaults it neither
 * declares itself nor excludes.
 *
 * Deliberately NOT included are the tool-gated, host-credential-derived
 * servers `buildContainerArgs` still assembles itself (linear, datafold,
 * atlassian, looker, dbt-mcp): those depend on scoped host env this function
 * has no business reading, and each already carries a hand-written capability
 * entry.
 */
export function effectiveMcpServers(
  config: { mcpServers?: Record<string, McpServerConfig>; excludeMcpServers?: string[] } | undefined,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = { ...(config?.mcpServers ?? {}) };
  const excluded = new Set(config?.excludeMcpServers ?? []);
  for (const [name, entry] of Object.entries(readFleetMcpServers())) {
    if (excluded.has(name) || servers[name]) continue;
    servers[name] = entry;
  }
  return servers;
}
