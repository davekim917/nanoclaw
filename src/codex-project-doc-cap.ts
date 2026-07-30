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
 * Instead we drop top-level `## ` sections until it fits (keeping the head —
 * the peer-framing preamble + whatever sits above the first `## `, where the
 * highest-priority rules live) — append an "Omitted for size" note so the agent
 * knows, and log loudly so the operator trims CLAUDE.md.
 *
 * Eviction order is two-tier: sections marked `PROTECTED_SECTION_MARKER` are
 * spent only after every unmarked one is gone, and within a tier the smallest
 * sufficient section goes first so we shed the least content. Size alone is
 * content-blind — see the marker's docblock for the production failure that
 * motivated the precedence tier.
 *
 * Only Codex is capped. `project_doc_max_bytes` is a Codex setting, so
 * `claude-md-compose.ts` calls this for Codex groups only; OpenCode and Claude
 * groups get the full doc.
 *
 * Constants mirror Codex's own default project-doc cap (`project_doc_max_bytes`,
 * 32KB) so we degrade under our control instead of letting Codex truncate
 * silently. NB: this is NOT a dormant safety net — workgroup-enriched groups
 * run near the cap and have tripped it on real spawns, so keep the degrade
 * minimal and the under-cap fast path cheap.
 */
import { log } from './log.js';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const CODEX_PROJECT_DOC_WARN_BYTES = 28 * 1024;

/**
 * A `## ` section containing this marker is dropped only as a last resort —
 * after every unmarked section is already gone. Mark the behavioral invariants
 * whose silent disappearance is a safety or correctness problem (credential
 * handling, container lifecycle, truth-grounding), NOT merely useful prose.
 *
 * The marker lives next to the rule it protects (in `container/CLAUDE.md` or a
 * fragment) rather than in a title list here, so protection can't drift out of
 * sync with a renamed heading. It is an HTML comment, so it costs the agent
 * nothing to read.
 *
 * Rationale: size-ranked dropping is content-blind. In production it evicted
 * `Credential Security` from one group and `Feature Work Routing` from three
 * while keeping `Admin CLI (ncl)` — whose content is fully rediscoverable via
 * `ncl help`. Precedence first, then smallest-sufficient within a tier.
 */
export const PROTECTED_SECTION_MARKER = '<!-- nanoclaw:keep -->';

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
 * returned unchanged (with a warn log when near it). Over the cap, `## `
 * sections are dropped until it fits — smallest-sufficient first, to lose the
 * least content — an omission note is appended, and the drop is logged at error
 * level. Never throws.
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
  // Surviving sections in original order (splice preserves it). Size and title
  // are computed once here, not re-derived on every drop.
  const kept = sections.map((text) => ({
    text,
    bytes: bytesOf(text),
    title: text
      .split('\n', 1)[0]
      .replace(/^##\s+/, '')
      .trim(),
    guarded: text.includes(PROTECTED_SECTION_MARKER),
  }));
  const droppedTitles: string[] = [];
  const droppedGuarded: string[] = [];

  const omissionNote = (titles: string[]): string =>
    `## Omitted for size\n\nThese sections were omitted to fit Codex's ${Math.round(
      CODEX_PROJECT_DOC_MAX_BYTES / 1024,
    )}KB project-doc cap: ${titles.join(', ')}. You are operating WITHOUT their text — do not assume you know what they said. If a task plausibly touches one of them, say so and ask rather than guessing. Operator: trim CLAUDE.md to restore them.`;

  // head + the given sections, plus an omission note when any title is present.
  // Pure (takes its inputs) so the loop can cheaply trial a candidate removal.
  const assemble = (list: typeof kept, titles: string[]): string => {
    const parts = [head, ...list.map((s) => s.text)];
    if (titles.length > 0) parts.push(omissionNote(titles));
    return parts.join('\n');
  };

  // Drop sections until it fits, losing as little as possible. Two tiers:
  // unmarked sections are spent first, and only once none remain do we start
  // evicting `PROTECTED_SECTION_MARKER` sections. WITHIN a tier the rule is
  // unchanged — prefer the SMALLEST single section whose removal already makes
  // the doc fit (minimal content loss — shed a 2KB section, not the 6KB one
  // beside it); only when no single section suffices fall back to removing the
  // largest (fastest progress). When just the head is left and still oversized,
  // stop and write it rather than brick the group — Codex truncates, but the
  // cause is logged below.
  while (kept.length > 0 && bytesOf(assemble(kept, droppedTitles)) > CODEX_PROJECT_DOC_MAX_BYTES) {
    const tier = kept.some((s) => !s.guarded) ? [...kept.keys()].filter((i) => !kept[i].guarded) : [...kept.keys()];
    const bySizeAsc = tier.sort((a, b) => kept[a].bytes - kept[b].bytes);
    let pick = bySizeAsc.find(
      (i) =>
        bytesOf(
          assemble(
            kept.filter((_, j) => j !== i),
            [...droppedTitles, kept[i].title].filter(Boolean),
          ),
        ) <= CODEX_PROJECT_DOC_MAX_BYTES,
    );
    if (pick === undefined) pick = bySizeAsc[bySizeAsc.length - 1];
    const [removed] = kept.splice(pick, 1);
    if (removed.title) droppedTitles.push(removed.title);
    if (removed.guarded && removed.title) droppedGuarded.push(removed.title);
  }

  const out = assemble(kept, droppedTitles);
  // `dropped` names the sections, not just a count: the count-only version of
  // this log fired 4,131 times without anyone noticing that Credential Security
  // and Feature Work Routing were the casualties. Never log a silent deletion
  // without naming what was deleted.
  log.error('Codex project doc exceeded size cap — dropped sections to fit', {
    label,
    originalBytes: bytes,
    finalBytes: bytesOf(out),
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    droppedCount: droppedTitles.length,
    dropped: droppedTitles,
    headOversized: droppedTitles.length === 0,
  });
  if (droppedGuarded.length > 0) {
    log.error('Codex project doc dropped PROTECTED sections — behavioral invariants are missing', {
      label,
      droppedGuarded,
    });
  }
  return out;
}
