import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Past this size only the file's tail is read; the batch recorded this attempt is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * True only when `text` is provably in what a resume of the transcript at
 * `transcriptPath` will load. A credential-rotation retry asks this to decide
 * whether it can point at the batch instead of sending it again (measured
 * 2026-09-18: 108 of 121 recent retries re-sent a prompt already recorded).
 *
 * Rather than re-implement the SDK's leaf selection, it demands a shape where
 * every leaf choice agrees: the main-conversation entries recorded during THIS
 * attempt (timestamp at or after `sinceMs`, the batch's first-attempt start on
 * the same container clock) form one straight parent chain — exactly one of
 * them hangs off an earlier entry, no two share a parent — with no
 * compaction, and one of them is a well-formed `user`-role entry containing
 * `text`. Every doubt answers false, so the caller re-sends: a false negative
 * costs tokens, a false positive would drop the batch. Doubts include a read
 * error, any unparseable line (a tail read's partial first line excepted),
 * a branch, a `compact_boundary`, and a malformed conversation entry (empty
 * `uuid`, absent or non-string `parentUuid`, undated).
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
  const attempt: Record<string, unknown>[] = [];
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
    if (!('uuid' in entry) || entry.isSidechain === true) continue; // queue ops, titles, subagents
    if (typeof entry.uuid !== 'string' || !entry.uuid) return false;
    if (!('parentUuid' in entry) || (entry.parentUuid !== null && typeof entry.parentUuid !== 'string')) return false;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(at)) return false;
    if (at >= sinceMs) attempt.push(entry);
  }
  if (attempt.length === 0) return false;
  const ids = new Set(attempt.map((e) => e.uuid as string));
  const parents = new Set<unknown>();
  let roots = 0;
  let matched = false;
  for (const e of attempt) {
    if (e.type === 'system' && e.subtype === 'compact_boundary') return false;
    if (parents.has(e.parentUuid)) return false; // two entries share a parent: a branch
    parents.add(e.parentUuid);
    if (typeof e.parentUuid !== 'string' || !ids.has(e.parentUuid)) roots += 1;
    if (
      e.type === 'user' &&
      isRecord(e.message) &&
      e.message.role === 'user' &&
      userTextOf(e.message.content).includes(text)
    ) {
      matched = true;
    }
  }
  return roots === 1 && matched;
}

function userTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}
