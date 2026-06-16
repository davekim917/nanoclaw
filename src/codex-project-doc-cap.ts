/**
 * Codex project-doc (AGENTS.md) size cap — graceful degradation.
 *
 * Codex hard-caps the project doc it loads into the system prompt
 * (`project_doc_max_bytes`, default 32KB). Past that it truncates SILENTLY,
 * which can lop off behavioral rules mid-section with no signal. Our AGENTS.md
 * is derived by flattening CLAUDE.md (`agents-md-flatten.ts`); a growing
 * CLAUDE.md could one day cross the cap.
 *
 * This guard fits the composed doc under the cap by DEGRADING, never throwing:
 * a per-spawn throw would ride wakeContainer's transient-retry contract —
 * host-sweep respawns every 60s forever and the group goes silently dark.
 * Instead we drop the largest top-level `## ` sections (keeping the head —
 * the peer-framing preamble + whatever sits above the first `## `, which is
 * where the highest-priority rules live), append an "Omitted for size" note so
 * the agent knows, and log loudly so the operator trims CLAUDE.md.
 *
 * Constants mirror upstream's `codex-agents-md.ts` (`origin/providers`) so the
 * cap value stays in lockstep if we later converge on its section-based
 * composer. Today our AGENTS.md is ~9KB — this is a safety net, not a hot path.
 */
import { log } from './log.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const CODEX_PROJECT_DOC_WARN_BYTES = 28 * 1024;

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf-8');

/**
 * Split a markdown doc into [head, ...sections] on top-level `## ` headings.
 * `head` is everything before the first `## ` (preamble / H1 / highest-priority
 * rules); each section starts at a `## ` line and runs to the next one.
 */
function splitTopLevelSections(content: string): { head: string; sections: string[] } {
  const lines = content.split('\n');
  const head: string[] = [];
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^## (?!#)/.test(line)) {
      if (current) sections.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      head.push(line);
    }
  }
  if (current) sections.push(current.join('\n'));
  return { head: head.join('\n'), sections };
}

/**
 * Return `content` fit under Codex's project-doc cap. Under the cap it's
 * returned unchanged (with a warn log when near it). Over the cap, the largest
 * `## ` sections are dropped until it fits, an omission note is appended, and
 * the drop is logged at error level. Never throws.
 */
export function capCodexProjectDoc(content: string, label = 'AGENTS.md'): string {
  const bytes = bytesOf(content);
  if (bytes <= CODEX_PROJECT_DOC_MAX_BYTES) {
    if (bytes >= CODEX_PROJECT_DOC_WARN_BYTES) {
      log.warn('Codex project doc near size cap', {
        label,
        bytes,
        warnBytes: CODEX_PROJECT_DOC_WARN_BYTES,
        maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      });
    }
    return content;
  }

  const { head, sections } = splitTopLevelSections(content);
  // Surviving sections in original order (splice preserves it). Byte size is
  // measured once here rather than re-encoded on every drop.
  const kept = sections.map((text) => ({ text, bytes: bytesOf(text) }));
  const droppedTitles: string[] = [];

  // head + surviving sections, plus an omission note once anything is dropped.
  const assemble = (): string => {
    const parts = [head, ...kept.map((s) => s.text)];
    if (droppedTitles.length > 0) {
      parts.push(
        `## Omitted for size\n\nThese sections were omitted to fit Codex's ${Math.round(
          CODEX_PROJECT_DOC_MAX_BYTES / 1024,
        )}KB project-doc cap: ${droppedTitles.join(', ')}. Their behavior still applies where the underlying tools/rules are active; trim CLAUDE.md to restore them.`,
      );
    }
    return parts.join('\n');
  };

  // Drop the largest surviving section until it fits. When only the head is
  // left and it's still oversized, stop and write it rather than brick the
  // group — Codex truncates, but the cause is logged below.
  while (kept.length > 0 && bytesOf(assemble()) > CODEX_PROJECT_DOC_MAX_BYTES) {
    let largest = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i].bytes >= kept[largest].bytes) largest = i;
    }
    const [removed] = kept.splice(largest, 1);
    const title = removed.text
      .split('\n', 1)[0]
      .replace(/^##\s+/, '')
      .trim();
    if (title) droppedTitles.push(title);
  }

  const out = assemble();
  log.error('Codex project doc exceeded size cap — dropped largest sections', {
    label,
    originalBytes: bytes,
    finalBytes: bytesOf(out),
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    droppedCount: droppedTitles.length,
    headOversized: droppedTitles.length === 0,
  });
  return out;
}
