import fs from 'fs';

import { formatRecallContext } from '../formatter.js';

const CAPABILITIES_PATH = '/workspace/capabilities.json';
const INDEX_PATH = '/workspace/workgroup/memory/index.md';
const MAX_CAPABILITY_SERVICES = 32;
const MAX_CAPABILITY_STRING_CHARS = 600;
/**
 * Must cover the LARGEST roster the host itself would emit, or this fallback
 * drops services the host kept and capabilities vanish specifically after a
 * cold-context recovery — the one path the agent cannot see happening.
 *
 * The host bounds `JSON.stringify(services)` at `PRE_TURN_BOUNDS
 * .capabilityTotalChars` = 10,000 (src/modules/memory/pre-turn-context.ts,
 * `boundedCapabilities`); this bound is measured over the whole snapshot
 * object, which adds `agentGroupId` and the ~360-char `howToUse`. 11,000
 * clears that with margin. At 5,000 — the pre-roster value, sized when the
 * block carried five or six full manuals — a host-accepted shape (32 services,
 * 160-char hints, ~7KB) lost entries here alone.
 *
 * This can leave less room under `NORMAL_RECALL_CHARS` for evidence blocks,
 * and that ordering is deliberate: `enforceFinalBound` on the host sheds
 * conversation and memory excerpts BEFORE capability entries, so the fallback
 * shedding evidence to keep the roster matches it. Real rosters measure ~3.3k,
 * so this only bites on pathological input.
 */
const MAX_CAPABILITY_JSON_CHARS = 11_000;
/** Roster hint cap. Mirrors PRE_TURN_BOUNDS.capabilityRosterUseChars on the host. */
const MAX_CAPABILITY_USE_CHARS = 160;
/**
 * Used only when the mounted snapshot predates the roster and so carries no
 * `session.howToUse`. The host writes that field
 * (`CAPABILITY_ROSTER_PREAMBLE`, src/capabilities.ts), so the live text has
 * one source; this is the older-host fallback, not a second copy to keep in
 * sync.
 */
const FALLBACK_HOW_TO_USE =
  'EVERY service listed here is wired into THIS session right now — never tell the user you lack one of them, and never ask for its credentials. ' +
  'These are one-line reminders, not instructions: before you first use a service in a session, call `get_capabilities` with `{"service":"<name>"}` for its full usage notes (auth, exact tool names, known failure shapes).';
const MAX_INDEX_BYTES = 2_500;
const NORMAL_RECALL_CHARS = 12_000;
const EXACT_LINK_RECALL_CHARS = 16_000;
const TRUNCATED = '[truncated:fresh-context-bootstrap]';

interface CapabilitySnapshot {
  agentGroupId: string;
  howToUse: string;
  services: Array<Record<string, unknown>>;
}

function boundedString(value: unknown, limit = MAX_CAPABILITY_STRING_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`;
}

/**
 * The roster hint for one entry, from the same snapshot the host reduces:
 * the hand-written/derived `summary` when the host wrote one, else the leading
 * clause of the how-to prose so an older snapshot still renders a line rather
 * than a bare name. Word-boundary cut, same intent as
 * `summarizeCapabilityText` (src/capabilities.ts).
 */
function rosterUse(service: Record<string, unknown>): string | undefined {
  const summary = boundedString(service.summary, MAX_CAPABILITY_USE_CHARS);
  if (summary !== undefined) return summary;
  const prose = typeof service.activation === 'string' ? service.activation : service.useFor;
  if (typeof prose !== 'string') return undefined;
  const flat = prose.replace(/\s+/g, ' ').trim();
  if (flat.length <= 96) return flat;
  const cut = flat.slice(0, 96);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
}

/**
 * Evict one capability entry: the last one not marked `retainUnderBudget`,
 * or the last outright once only retained ones remain. The host's
 * `evictCapability` (src/modules/memory/pre-turn-context.ts:1629) applies the same
 * rule to the host-built bootstrap; this fallback must not drop an entry the
 * host would have kept.
 */
function evictCapability(services: unknown[]): void {
  for (let index = services.length - 1; index >= 0; index--) {
    const service = services[index];
    const retained =
      !!service &&
      typeof service === 'object' &&
      (service as { retainUnderBudget?: unknown }).retainUnderBudget === true;
    if (!retained) {
      services.splice(index, 1);
      return;
    }
  }
  services.pop();
}

function readCapabilitiesFrom(filePath: string): {
  snapshot: CapabilitySnapshot;
  degraded?: string;
  truncatedServices?: number;
} {
  try {
    const root = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      session?: { agentGroupId?: unknown; howToUse?: unknown; services?: unknown };
    };
    const session = root.session;
    if (!session || !Array.isArray(session.services)) throw new Error('session capability snapshot is missing');
    const selectedRaw = [...(session.services as unknown[])];
    while (selectedRaw.length > MAX_CAPABILITY_SERVICES) evictCapability(selectedRaw);
    // Same reduction the host applies (`buildCapabilityRoster`,
    // src/capabilities.ts): a roster line per service, not the mini-manual.
    // The prose stays in the mounted snapshot, whole, and the agent fetches
    // one service's worth of it with `get_capabilities({ service })`.
    const services = selectedRaw.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const service = raw as Record<string, unknown>;
      const via = boundedString(service.mcpNamespace) ?? boundedString(service.cli) ?? '';
      const use = rosterUse(service);
      return {
        name: boundedString(service.name) ?? 'Unknown service',
        via,
        ...(use === undefined ? {} : { use }),
        ...(service.retainUnderBudget === true ? { retainUnderBudget: true } : {}),
      };
    });
    const snapshot = {
      agentGroupId: boundedString(session.agentGroupId) ?? 'unknown',
      howToUse: boundedString(session.howToUse) ?? FALLBACK_HOW_TO_USE,
      services,
    };
    let truncatedServices = session.services.length - services.length;
    while (JSON.stringify(snapshot).length > MAX_CAPABILITY_JSON_CHARS && snapshot.services.length > 0) {
      evictCapability(snapshot.services);
      truncatedServices++;
    }
    return { snapshot, ...(truncatedServices > 0 ? { truncatedServices } : {}) };
  } catch (error) {
    return {
      snapshot: { agentGroupId: 'unknown', howToUse: FALLBACK_HOW_TO_USE, services: [] },
      degraded: error instanceof Error ? error.message : String(error),
    };
  }
}

function readIndexFrom(filePath: string): { text?: string; degraded?: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('index.md is not a regular file');
    const length = Math.min(stat.size, MAX_INDEX_BYTES);
    const buffer = Buffer.alloc(length);
    const read = length > 0 ? fs.readSync(fd, buffer, 0, length, 0) : 0;
    return {
      text: `${buffer.subarray(0, read).toString('utf8')}${stat.size > read ? TRUNCATED : ''}`,
    };
  } catch (error) {
    return { degraded: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Runner-side fallback for a context reset the host could not predict (for
 * example cold-continuation rotation or an in-turn stale-session retry).
 * Normal turns get the host-built bootstrap row; this path only fills a
 * missing bootstrap and reads no source beyond the two host-mounted surfaces.
 */
export function ensureFreshContextBootstrap(
  prompt: string,
  paths: { capabilities?: string; index?: string } = {},
): string {
  if (prompt.includes('<trusted_capabilities_json>')) return prompt;

  const capabilitiesPath = paths.capabilities ?? CAPABILITIES_PATH;
  const indexPath = paths.index ?? INDEX_PATH;
  const capabilities = readCapabilitiesFrom(capabilitiesPath);
  const index = readIndexFrom(indexPath);
  const notices = [
    {
      source: 'context',
      status: 'ok',
      code: 'runner-fresh-context-bootstrap',
      detail: 'The runner reset the provider context after host recall admission.',
    },
  ];
  if (capabilities.degraded) {
    notices.push({
      source: 'capabilities',
      status: 'degraded',
      code: 'runner-capability-bootstrap-failed',
      detail: capabilities.degraded,
    });
  }
  if (capabilities.truncatedServices) {
    notices.push({
      source: 'capabilities',
      status: 'truncated',
      code: 'runner-capability-bootstrap-truncated',
      detail: `dropped ${capabilities.truncatedServices} service entries to fit the fresh-context bound`,
    });
  }
  if (index.degraded) {
    notices.push({
      source: 'markdown',
      status: 'degraded',
      code: 'runner-index-bootstrap-failed',
      detail: index.degraded,
    });
  }

  const bootstrap = formatRecallContext({
    trustedCapabilities: capabilities.snapshot,
    memoryEvidence: {
      core:
        index.text === undefined
          ? []
          : [
              {
                path: 'index.md',
                headings: [],
                text: index.text,
                score: Number.MAX_SAFE_INTEGER,
                provenance: { authority: 'workgroup-memory-canon' },
              },
            ],
      excerpts: [],
    },
    conversationEvidence: { excerpts: [] },
    notices,
  });
  const evidencePattern =
    /\[Untrusted recalled evidence[^\n]*\]\n[\s\S]*?<untrusted_recall_json>[\s\S]*?<\/untrusted_recall_json>/g;
  const limit = prompt.includes('"rank":"exact-link"') ? EXACT_LINK_RECALL_CHARS : NORMAL_RECALL_CHARS;
  let boundedPrompt = prompt;
  let evidenceBlocks = [...boundedPrompt.matchAll(evidencePattern)];
  let recalledChars = bootstrap.length + evidenceBlocks.reduce((sum, match) => sum + match[0].length, 0);
  while (recalledChars > limit && evidenceBlocks.length > 0) {
    const block = evidenceBlocks[0]![0];
    boundedPrompt = boundedPrompt.replace(block, '');
    evidenceBlocks = [...boundedPrompt.matchAll(evidencePattern)];
    recalledChars = bootstrap.length + evidenceBlocks.reduce((sum, match) => sum + match[0].length, 0);
  }
  // A native slash command reaches this runner as raw text specifically so the
  // provider SDK can dispatch it. Keep that token at byte zero even when a
  // cold-context bootstrap is needed; otherwise the bootstrap turns a native
  // command back into ordinary prompt text before the provider sees it.
  return boundedPrompt.startsWith('/') ? `${boundedPrompt}\n\n${bootstrap}` : `${bootstrap}\n\n${boundedPrompt}`;
}
