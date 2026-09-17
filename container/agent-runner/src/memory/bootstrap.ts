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
 * object, which adds `agentGroupId` and the ~740-char `howToUse`. 11,000
 * clears that with margin (10,000 + 740 + ~45). At 5,000 — the pre-roster
 * value, sized when the block carried five or six full manuals — a
 * host-accepted shape lost entries here alone.
 *
 * This leaves less room under `NORMAL_RECALL_CHARS`, and at the extreme this
 * bound plus a full `MAX_INDEX_BYTES` index exceeds it on its own. The
 * bootstrap's own size is brought back in `ensureFreshContextBootstrap`, which
 * sheds the index and then capability entries before it looks at evidence. A
 * bootstrap that fits the ceiling but leaves no room for evidence is NOT
 * brought back, and that is the host's policy rather than an oversight —
 * `enforceFinalBound` sheds every conversation and memory excerpt before it
 * touches a capability entry. It only bites on pathological input; real
 * rosters measure ~3.9k.
 */
const MAX_CAPABILITY_JSON_CHARS = 11_000;
/** Roster hint cap. Mirrors PRE_TURN_BOUNDS.capabilityRosterUseChars on the host. */
const MAX_CAPABILITY_USE_CHARS = 200;
/**
 * The standing instruction gets its OWN bound, well clear of the 822 chars the
 * host writes today (`CAPABILITY_ROSTER_PREAMBLE`, src/capabilities.ts).
 *
 * At the 600-char default this string was clipped mid-list, around
 * `snow login[truncated:…]`, which dropped the "never set your own
 * Authorization header" rule and the "report it instead of re-authenticating"
 * fallback — the exact prohibitions the preamble exists to keep always-on, and
 * only on the cold-context path, where nobody would see it go.
 */
const MAX_HOW_TO_USE_CHARS = 2_000;
/**
 * Used only when the mounted snapshot predates the roster and so carries no
 * `session.howToUse`. The host writes that field
 * (`CAPABILITY_ROSTER_PREAMBLE`, src/capabilities.ts), so the live text has
 * one source; this is the older-host fallback, not a second copy to keep in
 * sync.
 */
const FALLBACK_HOW_TO_USE =
  'EVERY service listed here is wired into THIS session right now — never tell the user you lack one of them, and never ask for its credentials. ' +
  'These are one-line reminders, not instructions: before you first use a service in a session, call `get_capabilities` with `{"service":"<name>"}` for its full usage notes (auth, exact tool names, known failure shapes). ' +
  'Credentials are injected for you at spawn, so NEVER run an interactive login or auth command in this container (`gh auth login`, `wix login`, `hex auth login`, `aws configure`, `aws sso login`, `snow login`, …) and NEVER set your own `Authorization` header on a gateway-injected service — the gateway overwrites it, so a 401 there is not evidence the credential is missing. If a credential genuinely fails, report it to the operator instead of re-authenticating.';
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
 * `evictCapability` (src/modules/memory/pre-turn-context.ts:1653) applies the same
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
    const services = selectedRaw
      // Skip a malformed entry rather than mapping it to `{}`, which rendered
      // as a nameless, handle-less roster line — an agent reading the block has
      // no way to tell that from a service it holds and cannot name.
      .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw))
      .map((service) => {
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
      howToUse: boundedString(session.howToUse, MAX_HOW_TO_USE_CHARS) ?? FALLBACK_HOW_TO_USE,
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

  let indexText = index.text;
  const render = (): string =>
    formatRecallContext({
      trustedCapabilities: capabilities.snapshot,
      memoryEvidence: {
        core:
          indexText === undefined
            ? []
            : [
                {
                  path: 'index.md',
                  headings: [],
                  text: indexText,
                  score: Number.MAX_SAFE_INTEGER,
                  provenance: { authority: 'workgroup-memory-canon' },
                },
              ],
        excerpts: [],
      },
      conversationEvidence: { excerpts: [] },
      notices,
    });
  let bootstrap = render();
  const limit = prompt.includes('"rank":"exact-link"') ? EXACT_LINK_RECALL_CHARS : NORMAL_RECALL_CHARS;

  // Shed the bootstrap's OWN size first, before touching evidence.
  // `MAX_CAPABILITY_JSON_CHARS` plus a full `MAX_INDEX_BYTES` index exceeds
  // `NORMAL_RECALL_CHARS` on its own, and these two loops are the only thing
  // that can bring that back: no amount of evidence shedding helps when the
  // bootstrap alone is over. Running them first also means the evidence loop
  // below sizes itself against the FINAL bootstrap rather than one that is
  // about to shrink under it.
  //
  // Within the bootstrap, the order is the host's (`enforceFinalBound`,
  // src/modules/memory/pre-turn-context.ts): memory core first, capability
  // entries last, so the roster is the final thing to go. Both loops
  // terminate — the index halves to nothing, and `evictCapability` always
  // removes an entry.
  //
  // What this does NOT do is stop a bootstrap that fits the ceiling on its own
  // from leaving no room for evidence. That is the host's policy, not an
  // oversight: `enforceFinalBound` sheds every conversation and memory excerpt
  // before it touches a capability entry. It is reachable only with
  // operator-set multi-hundred-character `displayName`s; real rosters measure
  // ~3.9k of the 12,000, which is more room for evidence than the pre-roster
  // block left.
  let shedIndex = false;
  while (bootstrap.length > limit && indexText !== undefined) {
    indexText =
      indexText.length > 512 ? `${indexText.slice(0, Math.floor(indexText.length / 2))}${TRUNCATED}` : undefined;
    if (!shedIndex) {
      shedIndex = true;
      notices.push({
        source: 'markdown',
        status: 'truncated',
        code: 'runner-index-bootstrap-truncated',
        detail: 'shortened index.md to keep the fresh-context bootstrap inside the recall ceiling',
      });
    }
    bootstrap = render();
  }
  let shedServices = 0;
  while (bootstrap.length > limit && capabilities.snapshot.services.length > 0) {
    evictCapability(capabilities.snapshot.services);
    shedServices++;
    if (shedServices === 1) {
      notices.push({
        source: 'capabilities',
        status: 'truncated',
        code: 'runner-capability-bootstrap-truncated',
        detail: 'dropped service entries to keep the fresh-context bootstrap inside the recall ceiling',
      });
    }
    bootstrap = render();
  }

  // Now the evidence blocks already in the prompt, measured against the
  // bootstrap the caller will actually receive.
  const evidencePattern =
    /\[Untrusted recalled evidence[^\n]*\]\n[\s\S]*?<untrusted_recall_json>[\s\S]*?<\/untrusted_recall_json>/g;
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
