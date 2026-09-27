import fs from 'fs';

import { formatRecallContext } from '../formatter.js';

const CAPABILITIES_PATH = '/workspace/capabilities.json';
const INDEX_PATH = '/workspace/workgroup/memory/index.md';
const MAX_CAPABILITY_SERVICES = 32;
const MAX_CAPABILITY_STRING_CHARS = 600;
/**
 * Must cover the LARGEST roster the host would emit, or capabilities vanish only after a cold-context
 * recovery. The host bounds `JSON.stringify(services)` at 10,000; this bound covers the whole snapshot object,
 * which adds `agentGroupId` and the ~740-char `howToUse`.
 */
const MAX_CAPABILITY_JSON_CHARS = 11_000;
/** Roster hint cap. Mirrors PRE_TURN_BOUNDS.capabilityRosterUseChars on the host. */
const MAX_CAPABILITY_USE_CHARS = 200;
/** Must stay well clear of the host's ~822-char preamble: clipping it drops its always-on prohibitions. */
const MAX_HOW_TO_USE_CHARS = 2_000;
/** Older-host fallback only (snapshot without `session.howToUse`); the host is the live text's one source. */
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

/** The host's `summary`, else the leading clause of the how-to prose, cut at a word boundary. */
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

/** Same rule as the host's `evictCapability`: this fallback must not drop an entry the host would have kept. */
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
    // Same reduction as the host's `buildCapabilityRoster`: one roster line per service, not the manual.
    const services = selectedRaw
      // Skip malformed entries: `{}` would render as a nameless roster line.
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

/** Fallback for a context reset the host could not predict; normal turns get the host-built bootstrap row. */
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

  // Shed the bootstrap's own size before evidence: the capability bound plus a full index can exceed
  // NORMAL_RECALL_CHARS alone. Order matches the host's `enforceFinalBound` (memory core first, capability
  // entries last). Both loops terminate.
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

  // Keep a native slash command at byte zero so the provider SDK still dispatches it.
  return boundedPrompt.startsWith('/') ? `${boundedPrompt}\n\n${bootstrap}` : `${bootstrap}\n\n${boundedPrompt}`;
}
