import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Past this size only the file's tail is read; the batch recorded this attempt is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * True only when a resume of the transcript at `transcriptPath` provably shows
 * `text`: walking the parent chain back from the newest main-conversation entry
 * (the way the SDK rebuilds history from a leaf's `parentUuid` ancestry), a user
 * entry recorded during THIS attempt — timestamp at or after `sinceMs`, the
 * batch's first-attempt start on the same container clock, no slack —
 * contains it. A credential-rotation retry asks this to decide whether it can
 * point at the batch instead of sending it again (measured 2026-09-18: 108 of
 * 121 recent retries re-sent a prompt already in the transcript).
 *
 * Every doubt answers false, so the caller re-sends: a false negative costs
 * tokens, a false positive would drop the batch. Doubts: a read error; an
 * unparseable line (other than a blank line or a tail read's partial first
 * line); a chain that reaches a `compact_boundary`, a missing or null parent,
 * or an undated entry or one older than the attempt before matching. Only
 * entries on the chain count, so an abandoned branch, a sidechain (subagent)
 * or an entry the SDK would not load (no `uuid`) can never match.
 */
export function transcriptContainsUserText(transcriptPath: string, text: string, sinceMs: number): boolean {
  if (!text || !Number.isFinite(sinceMs)) return false;
  let raw: string;
  let tailRead = false;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= TRANSCRIPT_PROMPT_TAIL_BYTES) {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    } else {
      tailRead = true;
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(TRANSCRIPT_PROMPT_TAIL_BYTES);
        fs.readSync(fd, buf, 0, buf.length, size - buf.length);
        raw = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return false;
  }
  const byUuid = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  const lines = raw.split('\n');
  for (let i = tailRead ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(entry)) return false;
    if (typeof entry.uuid !== 'string') continue; // queue ops, titles: not conversation
    byUuid.set(entry.uuid, entry);
    if (entry.isSidechain !== true) leaf = entry;
  }
  for (let node = leaf; node; ) {
    if (node.type === 'system' && node.subtype === 'compact_boundary') return false;
    const at = typeof node.timestamp === 'string' ? Date.parse(node.timestamp) : NaN;
    if (!(at >= sinceMs)) return false; // older than this attempt, or undated
    if (node.type === 'user' && isRecord(node.message) && userTextOf(node.message.content).includes(text)) return true;
    node = typeof node.parentUuid === 'string' ? byUuid.get(node.parentUuid) : undefined;
  }
  return false; // chain ended (null/missing parent) before a match
}

function userTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}
