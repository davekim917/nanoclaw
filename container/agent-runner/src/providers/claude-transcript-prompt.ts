import fs from 'node:fs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Past this size only the file's tail is read; the batch recorded this attempt is always near the end. */
const TRANSCRIPT_PROMPT_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * True only when `text` is provably in what a resume of `transcriptPath` will load, recorded at or after
 * `sinceMs`. Every doubt answers false so the caller re-sends: a false negative costs tokens, a false positive
 * drops the batch.
 *
 * A resume loads the parent chain ending at the newest `user`/`assistant` entry, so only that chain is walked;
 * off-chain orphans and side branches are not loaded. A `compact_boundary` reached before the match means the
 * resume loads a summary, not the batch.
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
  const seenUuids = new Set<string>();
  const position = new Map<string, number>();
  let newest: Record<string, unknown> | undefined;
  let lastCompactionAt = -1;
  let seq = 0;
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
    if (!('uuid' in entry)) continue; // queue ops, titles
    if (typeof entry.uuid !== 'string' || !entry.uuid) return false;
    // Checked before sidechains are dropped: a sidechain entry reusing a main-conversation uuid shadows it on
    // resume.
    if (seenUuids.has(entry.uuid)) return false;
    seenUuids.add(entry.uuid);
    // A non-boolean `isSidechain` is a doubt: the SDK may exclude an entry that `=== true` treats as main.
    if ('isSidechain' in entry && typeof entry.isSidechain !== 'boolean') return false;
    if (entry.isSidechain === true) continue; // subagent turns are not resumed here
    if (!('parentUuid' in entry) || (entry.parentUuid !== null && typeof entry.parentUuid !== 'string')) return false;
    if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) return false;
    byId.set(entry.uuid, entry);
    position.set(entry.uuid, seq);
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') lastCompactionAt = seq;
    seq += 1;
    // Only a `user`/`assistant` entry can be the resume leaf: a later `progress` entry hanging off an abandoned
    // branch would otherwise select that branch.
    if (entry.type === 'user' || entry.type === 'assistant') newest = entry;
  }
  if (!newest) return false;
  // `seen` guards against a parent chain that cycles.
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
      // A compaction written after the match, even off-chain, means the resume loads the summary, not the batch.
      return lastCompactionAt < (position.get(node.uuid as string) ?? -1);
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
