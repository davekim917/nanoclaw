import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Past this size only the file's tail is read; the batch recorded this attempt is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;
/** Clock slack between the runner's attempt start and the CLI's entry timestamps (same container clock). */
const ATTEMPT_CLOCK_SLACK_MS = 1_000;

/**
 * True only when the transcript at `transcriptPath` provably shows `text` to a
 * resume: a main-conversation user entry recorded during THIS attempt (its
 * timestamp is at or after `sinceMs`) contains it, with no compaction after it.
 * A credential-rotation retry asks this to decide whether it can point at the
 * batch instead of sending it again (measured 2026-09-18: 108 of 121 recent
 * retries re-sent a prompt already in the transcript).
 *
 * Every doubt answers false, so the caller re-sends: a false negative costs
 * tokens, a false positive would drop the batch. Doubts include a read error,
 * an unparseable line (other than a blank line or the partial first line of a
 * tail read), a `compact_boundary` newer than the match (compaction may not have
 * kept it), and reaching entries older than the attempt without a match (an
 * identical older copy, e.g. a repeated webhook, is a different delivery).
 * Sidechain (subagent) entries are not part of the resumed conversation and
 * are skipped.
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
  const lines = raw.split('\n');
  const firstComplete = tailRead ? 1 : 0; // a tail read starts mid-line
  const cutoff = sinceMs - ATTEMPT_CLOCK_SLACK_MS;
  for (let i = lines.length - 1; i >= firstComplete; i--) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return false; // corruption newer than any match: don't trust the file
    }
    if (!isRecord(entry)) return false;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return false;
    if (entry.type !== 'user' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    const content = entry.message.content;
    const userText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
          : '';
    if (!userText) continue; // tool results only
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!(at >= cutoff)) return false; // older than this attempt, or undated: stop
    if (userText.includes(text)) return true;
  }
  return false;
}
