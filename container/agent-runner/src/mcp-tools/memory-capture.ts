import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const INBOX_DIR = '/workspace/agent/sources/inbox';
// Cap captured content size. A large web page or a `gws gmail search` returning
// hundreds of items could otherwise write a multi-MB file. The classifier reads
// captured files via readFileSync and sends them to the Anthropic API; an
// unbounded write path is both a cost risk and a way to push files past the
// model's context window (200K for Haiku 4.5), which would dead-letter them
// after 3 wasted API calls. 50KB is large enough for a substantive article or
// meeting transcript and small enough to bound waste from adversarial input.
const MAX_CAPTURE_BYTES = 50_000;
const TRUNCATION_NOTICE =
  '\n\n[Content truncated by memory-capture: exceeded 50KB cap. Original size in attachment metadata.]\n';

function sha8(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Byte-aware truncation. JS `string.length` counts UTF-16 code units, not
 * bytes — multi-byte UTF-8 content would slip past a `length`-based cap.
 * Slice on a byte boundary (best-effort: trim back to last valid UTF-8
 * sequence start so we don't end on a partial codepoint).
 */
function truncateToBytes(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= maxBytes) return content;
  // Walk back from maxBytes to a valid UTF-8 start byte (top bit 0, or
  // 11xxxxxx leading byte). Bytes 10xxxxxx are continuation bytes and an
  // unsafe truncation point.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf-8') + TRUNCATION_NOTICE;
}

let _captureFailureLogCount = 0;
const CAPTURE_FAILURE_LOG_LIMIT = 20;
/**
 * Best-effort stderr log for capture errors — capped so a misconfigured tool
 * doesn't flood logs. Operators see "memory-capture failed N times for
 * <toolName>: <errClass>" without seeing payload contents (which could be
 * sensitive).
 */
function logCaptureFailure(context: string, err: unknown): void {
  if (_captureFailureLogCount >= CAPTURE_FAILURE_LOG_LIMIT) return;
  _captureFailureLogCount++;
  const errClass = err instanceof Error ? err.constructor.name + ':' + err.message.slice(0, 80) : String(err).slice(0, 80);
  const suffix = _captureFailureLogCount === CAPTURE_FAILURE_LOG_LIMIT ? ' (further capture errors suppressed)' : '';
  console.error(`[memory-capture] ${context}: ${errClass}${suffix}`);
}

/**
 * Write content to finalPath atomically, no-clobber. Uses `flag: 'wx'` so the
 * write fails if the file already exists, instead of relying on a TOCTOU
 * `existsSync` check followed by a rename (Codex-flagged race: two writers
 * for the same hashed path could share a temp path and overwrite each
 * other's output, with the catch-all swallowing whichever lost). The temp
 * path also gets a per-call random suffix so concurrent writes for distinct
 * targets in the same dir don't collide on the temp name.
 */
function atomicWrite(finalPath: string, content: string): void {
  // Guard against re-publishing the same content key. We don't try to detect
  // content updates here — by design, hash collision means "we already have
  // this fact"; a hashOf that's content-aware (vs input-only) is the surface
  // that would make re-fetches re-capture.
  if (fs.existsSync(finalPath)) return;
  const bounded = truncateToBytes(content, MAX_CAPTURE_BYTES);
  const tmpSuffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = `${finalPath}.${tmpSuffix}.tmp`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  try {
    fs.writeFileSync(tmpPath, bounded, { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    // wx fails with EEXIST if our randomized temp path already exists
    // (1-in-4-billion); not worth retrying. Surface as capture failure.
    throw err;
  }
  try {
    // POSIX rename overwrites — to keep no-clobber, link + unlink ensures
    // EEXIST surfaces if a second writer published the same finalPath
    // between our existsSync check above and now.
    fs.linkSync(tmpPath, finalPath);
  } catch (err) {
    // Clean up the orphan tmp file regardless of outcome.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    // EEXIST means another writer won the race — same content, same hash,
    // not a bug. Other errors propagate.
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return;
    throw err;
  }
  // Clean up tmp file (linkSync left it as a hardlink; one unlink removes
  // the tmp name without affecting finalPath).
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    /* best-effort */
  }
}

export const MCP_CAPTURE_TOOLS: ReadonlyArray<{
  name: string;
  prefix: string;
  hashOf: (input: unknown, output: unknown) => string;
  serialize: (output: unknown) => string;
}> = [
  {
    // The mounted Granola MCP is the LOCAL server at
    // `container/agent-runner/src/granola-mcp-server.ts` (NOT the hosted
    // mcp.granola.ai). It exposes exactly two tools — `list_meetings` and
    // `get_meeting` (singular). Earlier revisions of this table referenced
    // tool names from the hosted server (`get_meetings` plural,
    // `get_meeting_transcript`); those were dead code at runtime.
    //
    // get_meeting accepts `id` and an optional `include_transcript: boolean`
    // (default false). Without include_transcript, returns the LLM-generated
    // notes/summary; with it, also includes the verbatim transcript. We hash
    // the id + include_transcript flag so the same meeting fetched both ways
    // produces two distinct inbox files (one notes-only, one with transcript)
    // rather than collapsing.
    name: 'mcp__granola__get_meeting',
    prefix: 'granola-meeting',
    hashOf: (input: unknown) => {
      const i = input as { id?: string; include_transcript?: boolean };
      const id = i.id ?? JSON.stringify(input);
      const tx = i.include_transcript === true ? 'tx' : 'notes';
      return `${id}|${tx}`;
    },
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    // Pocket — in-person meeting transcriber. Per docs.heypocketai.com/docs/mcp,
    // get_pocket_conversation returns transcriptSegments[] + recording metadata.
    // search_pocket_* tools are not captured: query-shaped, not durable content.
    name: 'mcp__pocket__get_pocket_conversation',
    prefix: 'pocket-transcript',
    hashOf: (input: unknown) => {
      const i = input as { conversation_id?: string; recording_id?: string; recordingId?: string; id?: string };
      return i.conversation_id ?? i.recording_id ?? i.recordingId ?? i.id ?? JSON.stringify(input);
    },
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    // Linear MCP is mounted in container-runner.ts as `mcpServers.linear`
    // (HTTP, https://mcp.linear.app/mcp). Earlier revisions referenced
    // `linear-server` (the host-side mount name in claude.ai's config) —
    // wrong inside the container.
    name: 'mcp__linear__get_issue',
    prefix: 'linear',
    hashOf: (input: unknown) => {
      const id = (input as { id?: string; issueId?: string })?.id ?? (input as { issueId?: string })?.issueId ?? JSON.stringify(input);
      return id;
    },
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__github__get_pr',
    prefix: 'github',
    hashOf: (input: unknown) => {
      const i = input as { owner?: string; repo?: string; pull_number?: number };
      const id = i.owner && i.repo && i.pull_number != null
        ? `${i.owner}/${i.repo}/${i.pull_number}`
        : JSON.stringify(input);
      return id;
    },
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  // Exa — content-producing tools. The "fetch is the curation signal" principle
  // (per brief.md): if the agent ran an Exa crawl/research call, that's a
  // deliberate research action and the result is worth capturing as a source.
  // Search-only tools (web_search_exa) are also captured because their result
  // sets carry context that compounds (top-N URLs/snippets for a query).
  {
    name: 'mcp__exa__crawling_exa',
    prefix: 'exa-crawl',
    hashOf: (input: unknown) => {
      const i = input as { url?: string; urls?: string[] };
      return i.url ?? (i.urls ?? []).join('|') ?? JSON.stringify(input);
    },
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__web_search_exa',
    prefix: 'exa-search',
    hashOf: (input: unknown) => (input as { query?: string })?.query ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__web_search_advanced_exa',
    prefix: 'exa-search-adv',
    hashOf: (input: unknown) => (input as { query?: string })?.query ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__company_research_exa',
    prefix: 'exa-company',
    hashOf: (input: unknown) => (input as { company_name?: string; domain?: string })?.company_name ?? (input as { domain?: string })?.domain ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__people_search_exa',
    prefix: 'exa-people',
    hashOf: (input: unknown) => (input as { query?: string })?.query ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__deep_researcher_check',
    prefix: 'exa-research',
    hashOf: (input: unknown) => (input as { task_id?: string })?.task_id ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
  {
    name: 'mcp__exa__get_code_context_exa',
    prefix: 'exa-code',
    hashOf: (input: unknown) => (input as { query?: string })?.query ?? JSON.stringify(input),
    serialize: (output: unknown) => JSON.stringify(output, null, 2),
  },
];

// Build a lookup map for fast tool name checks
const MCP_CAPTURE_MAP = new Map(MCP_CAPTURE_TOOLS.map((t) => [t.name, t]));

/**
 * PostToolUse hook for MCP tool result capture. Wired in
 * src/providers/claude.ts with matcher `mcp__.*` so it fires for every MCP
 * tool call. The hook looks up the tool name in `MCP_CAPTURE_MAP` and no-ops
 * if the tool isn't on the allowlist — that way adding a new server is a
 * one-line entry to `MCP_CAPTURE_TOOLS`, no matcher regex update needed.
 *
 * Earlier revisions of this file exported a `createMemoryCaptureMcpMiddleware`
 * that took (toolName, input, output) — but the Claude Agent SDK has no
 * "MCP middleware" extension point; only PostToolUse hooks fire on tool
 * results. The middleware was never wired and `MCP_CAPTURE_TOOLS` entries
 * were dead code. This is the correct shape: a PostToolUse HookCallback that
 * dispatches via the same lookup table.
 */
export function createMemoryCaptureMcpHook(): HookCallback {
  return async (input) => {
    let toolName: string | undefined;
    try {
      const i = input as {
        tool_name?: string;
        tool_input?: unknown;
        tool_response?: unknown;
      };
      toolName = i.tool_name;
      if (!toolName) return {};
      const spec = MCP_CAPTURE_MAP.get(toolName);
      if (!spec) return {};
      const hashInput = spec.hashOf(i.tool_input, i.tool_response);
      const hash = sha8(hashInput);
      const finalPath = path.join(INBOX_DIR, `${spec.prefix}-${hash}.md`);
      const content = spec.serialize(i.tool_response);
      atomicWrite(finalPath, content);
    } catch (err) {
      // Swallow capture errors — never break the agent's normal flow.
      // Log rate-limited so a misconfigured tool doesn't flood stderr.
      logCaptureFailure(`mcp:${toolName ?? 'unknown'}`, err);
    }
    return {};
  };
}

// GWS commands that indicate content-fetch (not destructive) operations
const GWS_CAPTURE_RE = /\bgws\s+(?:gmail\s+(?:get|search|read)|docs\s+read|sheets\s+read|slides\s+read)\b/;
const DRY_RUN_RE = /\s--dry-run(?:\s|$)/;

export function createMemoryCaptureWebFetchHook(): HookCallback {
  return async (input) => {
    try {
      const i = input as { tool_input?: { url?: string }; tool_response?: { content?: string } };
      const url = i.tool_input?.url;
      const content = i.tool_response?.content;
      if (!url || !content) return {};
      const hash = sha8(url);
      const finalPath = path.join(INBOX_DIR, `web-${hash}.md`);
      atomicWrite(finalPath, content);
    } catch (err) {
      logCaptureFailure('webfetch', err);
    }
    return {};
  };
}

export function createMemoryCaptureBashHook(): HookCallback {
  return async (input) => {
    try {
      const i = input as { tool_input?: { command?: string }; tool_response?: { stdout?: string; output?: string } };
      const command = i.tool_input?.command;
      if (!command) return {};
      if (!GWS_CAPTURE_RE.test(command)) return {};
      if (DRY_RUN_RE.test(command)) return {};
      const stdout = i.tool_response?.stdout ?? i.tool_response?.output ?? '';
      if (!stdout) return {};
      const hash = sha8(command);
      const finalPath = path.join(INBOX_DIR, `gws-${hash}.md`);
      atomicWrite(finalPath, stdout);
    } catch (err) {
      logCaptureFailure('bash:gws', err);
    }
    return {};
  };
}
