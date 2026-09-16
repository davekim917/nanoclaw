import fs from 'fs';

import { formatRecallContext } from '../formatter.js';

const CAPABILITIES_PATH = '/workspace/capabilities.json';
const INDEX_PATH = '/workspace/workgroup/memory/index.md';
const MAX_CAPABILITY_SERVICES = 32;
const MAX_CAPABILITY_STRING_CHARS = 600;
const MAX_CAPABILITY_JSON_CHARS = 5_000;
const MAX_INDEX_BYTES = 2_500;
const NORMAL_RECALL_CHARS = 12_000;
const EXACT_LINK_RECALL_CHARS = 16_000;
const TRUNCATED = '[truncated:fresh-context-bootstrap]';

interface CapabilitySnapshot {
  agentGroupId: string;
  services: Array<Record<string, unknown>>;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= MAX_CAPABILITY_STRING_CHARS) return value;
  return `${value.slice(0, MAX_CAPABILITY_STRING_CHARS - TRUNCATED.length)}${TRUNCATED}`;
}

function boundedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 64)
    .map(boundedString)
    .filter((item): item is string => item !== undefined);
}

/**
 * Evict one capability entry: the last one not marked `retainUnderBudget`,
 * or the last outright once only retained ones remain. The host's
 * `evictCapability` (src/modules/memory/pre-turn-context.ts:1590) applies the same
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
      session?: { agentGroupId?: unknown; services?: unknown };
    };
    const session = root.session;
    if (!session || !Array.isArray(session.services)) throw new Error('session capability snapshot is missing');
    const selectedRaw = [...(session.services as unknown[])];
    while (selectedRaw.length > MAX_CAPABILITY_SERVICES) evictCapability(selectedRaw);
    const services = selectedRaw.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const service = raw as Record<string, unknown>;
      return {
        name: boundedString(service.name) ?? 'Unknown service',
        ...(boundedString(service.cli) === undefined ? {} : { cli: boundedString(service.cli) }),
        ...(boundedString(service.mcpNamespace) === undefined
          ? {}
          : { mcpNamespace: boundedString(service.mcpNamespace) }),
        declaredTools: boundedStringArray(service.declaredTools),
        scopes: boundedStringArray(service.scopes),
        credentialPaths: boundedStringArray(service.credentialPaths),
        ...(boundedString(service.activation) === undefined ? {} : { activation: boundedString(service.activation) }),
        ...(boundedString(service.useFor) === undefined ? {} : { useFor: boundedString(service.useFor) }),
        ...(service.retainUnderBudget === true ? { retainUnderBudget: true } : {}),
      };
    });
    const snapshot = {
      agentGroupId: boundedString(session.agentGroupId) ?? 'unknown',
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
      snapshot: { agentGroupId: 'unknown', services: [] },
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
  return boundedPrompt.startsWith('/')
    ? `${boundedPrompt}\n\n${bootstrap}`
    : `${bootstrap}\n\n${boundedPrompt}`;
}
