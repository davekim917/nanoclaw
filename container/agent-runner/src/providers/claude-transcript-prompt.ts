import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Past this size only the file's tail is read; the batch recorded this attempt is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * True only when `text` is provably in what a resume of the transcript at
 * `transcriptPath` will load. A credential-rotation retry asks this to decide
 * whether it can point at the batch instead of sending it again
 * (poll-loop.ts:1128 → `formatCredentialRetryPrompt`, poll-loop.ts:142).
 *
 * The resumed context is the parent chain ending at the newest `user`/
 * `assistant` entry, so that is what this walks: from that entry back through
 * `parentUuid`, answering true at a well-formed `user`-role entry that
 * contains `text` and was recorded during THIS attempt (timestamp at or after
 * `sinceMs`, the batch's first-attempt start on the same container clock).
 * Entries off that chain are irrelevant — orphans and side branches are not
 * loaded, so they no longer veto the pointer. Other entry types (`progress`,
 * `system`) sit ON the chain but never start it: a later `progress` line
 * hanging off an abandoned branch would otherwise select that branch.
 *
 * Every doubt answers false, so the caller re-sends: a false negative costs
 * tokens, a false positive would drop the batch. Doubts include a read error,
 * any unparseable line (a tail read's partial first line excepted), a
 * malformed conversation entry (empty `uuid`, absent or non-string
 * `parentUuid`, undated), a repeated `uuid` (two chains under one id), a
 * `compact_boundary` reached before the match (what a resume loads then is a
 * summary, not the batch), a chain that leaves the read window or reaches the
 * transcript root without matching, and a cycle.
 *
 * History: this first shipped demanding that every entry recorded during the
 * attempt form ONE straight chain (`roots === 1`). Real transcripts never have
 * that shape — the harness writes entries whose parents are lines this walk
 * skips — so the check answered false for every live retry: 0 of 93 rotation
 * retries in the 2026-09-19 fleet sample used the pointer, though 74 of them
 * were recorded on the resumed chain and provably safe to point at (the retry
 * entry itself descends from the earlier copy in 74 of the 76 cases where one
 * exists; the other 2 have a compaction between them, which this still
 * refuses).
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
  const byId = new Map<string, Record<string, unknown>>();
  let newest: Record<string, unknown> | undefined;
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
    if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) return false;
    // A repeated uuid means the file can describe two different chains under one
    // id, and the last write would decide which one this walk sees. Re-appending
    // a pre-compaction entry that way reaches the batch without ever visiting
    // the `compact_boundary` that orphaned it, so refuse the whole file.
    if (byId.has(entry.uuid)) return false;
    byId.set(entry.uuid, entry);
    // Only a `user`/`assistant` entry can be the leaf a resume starts from.
    // Verified against SDK 0.3.278 / CLI 2.1.278 by capturing the resumed
    // request: with `user a → user x → user y` and a later `progress p → x`
    // appended last, the resume loads `a → y`, not `p → x`. Taking `p` as the
    // newest entry would point at a batch the model never sees.
    if (entry.type === 'user' || entry.type === 'assistant') newest = entry;
  }
  if (!newest) return false;
  // Walk the resumed chain, newest first. `seen` is the cycle guard: a
  // transcript that points back into itself would otherwise loop forever.
  const seen = new Set<string>();
  let node: Record<string, unknown> | undefined = newest;
  while (node) {
    if (node.type === 'system' && node.subtype === 'compact_boundary') return false;
    if (
      node.type === 'user' &&
      isRecord(node.message) &&
      node.message.role === 'user' &&
      Date.parse(node.timestamp as string) >= sinceMs &&
      userTextOf(node.message.content).includes(text)
    ) {
      return true;
    }
    seen.add(node.uuid as string);
    const parentUuid = node.parentUuid;
    if (typeof parentUuid !== 'string' || seen.has(parentUuid)) return false;
    node = byId.get(parentUuid);
  }
  return false; // the chain left the read window before matching
}

function userTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}
