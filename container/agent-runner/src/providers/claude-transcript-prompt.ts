import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** How many of the newest user entries a rotation retry searches for its prompt. */
const TRANSCRIPT_PROMPT_SCAN_ENTRIES = 20;
/** Past this size only the file's tail is read; the interrupted batch is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * True when one of the newest user entries in the transcript at `transcriptPath`
 * contains `text` verbatim. A credential-rotation retry asks this to learn
 * whether the interrupted attempt already recorded its prompt: when it did, the
 * resumed session shows the batch once and the retry need not send it again
 * (measured 2026-09-18: 108 of 121 retries re-sent a prompt already in the
 * transcript). Any read or parse problem answers false, so the caller re-sends:
 * a false negative costs tokens, a false positive would drop the batch.
 */
export function transcriptContainsUserText(transcriptPath: string, text: string): boolean {
  if (!text) return false;
  let raw: string;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= TRANSCRIPT_PROMPT_TAIL_BYTES) {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    } else {
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
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < TRANSCRIPT_PROMPT_SCAN_ENTRIES; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue; // blank line, or the tail read cut the first line
    }
    if (!isRecord(entry) || entry.type !== 'user' || !isRecord(entry.message)) continue;
    const content = entry.message.content;
    const userText =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
          : '';
    if (!userText) continue; // tool results only
    seen += 1;
    if (userText.includes(text)) return true;
  }
  return false;
}
