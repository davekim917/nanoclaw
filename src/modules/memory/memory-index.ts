import { frontmatterValue, stripCuratorMetadata } from './curator-contract.js';

/**
 * The OKF map layer: `index.md` at the memory root and one `index.md` per
 * topic folder. Upstream's memory system loads the root index into every
 * fresh context window and expects the agent to follow its links; the curator
 * is a background executor of that format, so every topic file it writes has
 * to reach the map.
 *
 * Everything here is pure string work over Markdown, and every function is a
 * MERGE, never a regeneration. `index.md` is co-owned: the operator writes
 * Core Memory, agents add sections, and the curator owns exactly the link
 * bullets that point at files it owns. Clobbering a hand-written Core Memory
 * section would be a worse bug than a stale map.
 *
 * What a merge preserves, stated exactly — this is NOT "byte for byte", and
 * saying so cost a review round: headings, frontmatter, other sections,
 * section ordering, fenced blocks, HTML blocks, non-indented prose, and
 * hand-written bullets whose target the curator does not claim all survive.
 * Trailing whitespace inside and after the managed section is normalized. The
 * lines indented under a bullet the curator re-renders MOVE WITH IT, so a
 * hand-written note keeps the parent it was written under.
 *
 * This is a line-walker, not a Markdown parser, and it stays one deliberately:
 * a real parser is a new dependency and a normalizing round-trip through an
 * AST would rewrite bytes this module exists to leave alone. It is a merge
 * over a co-owned file, so its only hard duty is to never destroy a line
 * somebody else wrote — and every construct below that it does not understand
 * fails in the duplicate-a-link direction, never the delete-a-line direction.
 *
 * EXACTLY what it does not understand, verified by probing rather than
 * assumed. None of these lose content:
 *
 *   - `> - [X](y.md)` in a blockquote, `* [X](y.md)` with a star marker, a
 *     tab-indented bullet, and a `[X]: y.md` link reference definition are not
 *     claimed, so a second link to the same target is appended beside them;
 *   - a setext `Map\n---` heading is not recognized as the managed heading, so
 *     a fresh `## Map` section is appended at end of file instead of merging
 *     into it. A setext heading INSIDE the section is recognized as a section
 *     boundary, so the managed block is never hoisted across one;
 *   - an HTML block is anything from a line opening with a tag to the next
 *     blank line (CommonMark's type-6 rule). A tag-opened block that contains
 *     a blank line resumes being parsed as Markdown at that point;
 *   - list numbering, tables, and footnotes are ordinary lines to it.
 *
 * Write map links as plain `- [Title](target.md)` bullets under an ATX
 * heading and none of this matters. See docs/memory.md.
 */

/** One rendered map bullet. */
export interface IndexLink {
  /** Link target, relative to the index file's own directory. */
  target: string;
  title: string;
  /** One-line summary after the dash; empty renders a bare link. */
  hook: string;
}

/** `- [Title](target)` — the bullet shape every index in the live tree uses.
 *  The optional angle brackets are CommonMark's `[text](<dest>)`: without them
 *  a hand-written `- [People](<people/index.md>)` is not recognized as ours and
 *  a second link to the same target gets appended beside it. */
const BULLET = /^ {0,3}-\s+\[([^\]]*)\]\(\s*<?([^)>\s]+)>?/;

// A bullet the curator re-renders takes only its own line out of position; the
// lines indented under it are lifted and re-emitted with it (see `carried`
// below).
//
// There used to be a rule that DELETED those indented lines, on the theory
// that they were the bullet's wrapped tail. They are not: a bullet this module
// renders is single-line by construction — the hook is bounded and has its
// whitespace collapsed — so the curator has never written a wrapped bullet,
// and anything indented under one was written by somebody else. Leaving them
// behind is not right either: the managed block moves to the head of the list,
// so an orphaned note silently becomes a child of whichever bullet ends up
// above it. Markdown meaning, not just line order, has to survive.

/** A line that opens a CommonMark type-6 HTML block: `<tag`, `</tag`. The
 *  block runs to the next blank line. */
const HTML_BLOCK_START = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)/;

/**
 * Which lines sit inside a fenced code block, an HTML comment, or an HTML
 * block.
 *
 * This module walks lines; it is not a Markdown parser. These are the
 * constructs it MUST know about, because an index that documents its own
 * format puts a real-looking bullet inside a ``` block, comments one out, or
 * wraps one in a `<div>` — and deleting the documentation of the map is the
 * same class of bug as deleting the map. Computed once and consulted by every
 * scan below.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let fence: string | null = null;
  let comment = false;
  let html = false;
  for (const line of lines) {
    if (comment) {
      inside.push(true);
      if (line.includes('-->')) comment = false;
      continue;
    }
    if (html) {
      // CommonMark: a type-6 HTML block ends at the first blank line, and the
      // blank line itself is not part of it.
      html = line.trim() !== '';
      inside.push(html);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (/^ {0,3}<!--/.test(line)) {
        inside.push(true);
        comment = !line.includes('-->');
        continue;
      }
      if (HTML_BLOCK_START.test(line)) {
        inside.push(true);
        html = true;
        continue;
      }
      inside.push(marker !== undefined);
      if (marker !== undefined) fence = marker;
    } else {
      inside.push(true);
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
  }
  return inside;
}

/**
 * THE DELETION RULE, in one place.
 *
 * A managed bullet may be removed only when it is being RE-RENDERED, or when
 * `absent` carries positive evidence its target is gone from disk. "Missing
 * from the list we just built" is never evidence: the list can be short
 * because a `readdir` failed, because a read failed, because a name was
 * filtered out, or because a whole folder was skipped.
 *
 * Four shipped bugs had exactly that shape — `presentNames` built from
 * successful reads, an empty listing read as an emptied folder, `log.md`
 * filtered out of the listing, and the root merge claiming a pointer for a
 * folder it never listed. Each was patched where it was found; the fifth is
 * what this function exists to prevent. Every caller states its evidence for
 * absence, or supplies none and deletes nothing.
 */
export function managedTargets(
  rendered: readonly IndexLink[],
  absent: (target: string) => boolean,
): (target: string) => boolean {
  const targets = new Set(rendered.map((link) => link.target));
  return (target) => targets.has(target) || absent(target);
}

/**
 * Merge `links` into the section of `existing` introduced by `heading`,
 * replacing only the bullets `owns` claims and leaving every other byte of
 * the document alone.
 *
 * The section runs from `heading` to the next heading at the same or a higher
 * level, or to end of file. A missing section is appended rather than treated
 * as an error: a workgroup whose index has no `## Map` yet still gets one.
 *
 * Idempotent: the bullets it renders are themselves `owns`-claimed, so a
 * second run over unchanged input removes and re-renders exactly the same
 * lines and returns byte-identical output.
 */
export function mergeManagedLinks(
  existing: string,
  heading: string,
  owns: (target: string) => boolean,
  links: readonly IndexLink[],
  insertAfter?: string,
): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  // Strip a leading BOM before scanning: otherwise the first heading never
  // matches and a duplicate section is appended below the original.
  const lines = existing.length > 0 ? existing.replace(/^\uFEFF/, '').split('\n') : [];
  let fenced = fencedLines(lines);
  const headingAt = (text: string): number =>
    lines.findIndex((line, index) => !fenced[index] && line.trimEnd() === text);
  /**
   * The level of the setext heading whose underline is at `index`, i.e. the
   * heading formed by the line ABOVE it. Recognized so the managed block is
   * never hoisted across a heading the walker would otherwise not see as one.
   * A `---` after a blank line, a list item or an ATX heading is a thematic
   * break, not an underline.
   */
  const setextLevelAt = (index: number): number | null => {
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index]!);
    const above = index > 0 ? lines[index - 1]! : '';
    if (!underline || fenced[index] === true || fenced[index - 1] === true) return null;
    if (above.trim() === '' || /^ {0,3}(?:#|[-*+>]\s|\d+[.)]\s)/.test(above)) return null;
    return underline[1]!.startsWith('=') ? 1 : 2;
  };
  /** End of the section `text` opens: the next heading at its level or above. */
  const sectionEnd = (at: number, atLevel: number): number => {
    for (let index = at + 1; index < lines.length; index += 1) {
      if (fenced[index]) continue;
      const match = /^(#+)\s/.exec(lines[index]!);
      if (match && match[1]!.length <= atLevel) return index;
      const setext = setextLevelAt(index);
      if (setext !== null && setext <= atLevel && index - 1 > at) return index - 1;
    }
    return lines.length;
  };

  let start = headingAt(heading);
  let end: number;
  if (start < 0) {
    // Where a NEW section goes is ours to choose; where an existing one sits
    // is not. `insertAfter` puts the map high enough to survive the 2,500-byte
    // head read the agent's bootstrap does (bootstrap.ts MAX_INDEX_BYTES), and
    // once it exists this branch never runs again.
    const anchor = insertAfter === undefined ? -1 : headingAt(insertAfter);
    if (anchor >= 0) {
      let at = sectionEnd(anchor, /^#+/.exec(insertAfter!)![0].length);
      while (at > anchor + 1 && lines[at - 1]!.trim() === '') at -= 1;
      lines.splice(at, 0, '', heading);
      start = at + 1;
    } else {
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
      if (lines.length > 0) lines.push('');
      lines.push(heading);
      start = lines.length - 1;
    }
    fenced = fencedLines(lines);
    end = start + 1;
  } else {
    end = sectionEnd(start, level);
  }

  const subheading = new RegExp(`^#{${level + 1},}\\s`);
  const kept: string[] = [];
  let firstSubheadingAt = -1;
  let firstBulletAt = -1;
  // An indented bullet is a NESTED item when a list is already open, and a
  // top-level item when one is not — CommonMark allows a top-level item up to
  // three spaces in. Without this, a hand-written sub-bullet under someone
  // else's link is read as top-level and replaced.
  let listOpen = false;
  // Lines indented under a bullet we are re-rendering, keyed by its target.
  // They are somebody else's prose and they are ABOUT that entry, so they move
  // with it to the head of the list instead of being left behind to be
  // silently reparented onto whichever bullet ends up above them. Nothing is
  // carried off a bullet that is being deleted rather than re-rendered — those
  // lines stay exactly where they are, because losing them would be worse than
  // reparenting them.
  const rerendered = new Set(links.map((link) => link.target));
  const carried = new Map<string, string[]>();
  let carryTo: string | null = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!fenced[index] && line.trim() !== '') {
      const match = BULLET.exec(line);
      const nested = match !== null && line.startsWith(' ') && listOpen;
      const indented = /^[ \t]+\S/.test(line);
      if (match && !nested) {
        listOpen = true;
        if (owns(match[2]!)) {
          carryTo = rerendered.has(match[2]!) ? match[2]! : null;
          continue;
        }
        carryTo = null;
        if (firstBulletAt < 0) firstBulletAt = kept.length;
      } else if (carryTo !== null && indented) {
        const lines_ = carried.get(carryTo) ?? [];
        lines_.push(line);
        carried.set(carryTo, lines_);
        continue;
      } else {
        carryTo = null;
        listOpen = match !== null || indented;
        if (!listOpen && firstSubheadingAt < 0 && subheading.test(line)) firstSubheadingAt = kept.length;
      }
    } else {
      // A blank line, or a line inside a fence, ends the carry — same rule
      // that stopped the old deletion reaching across a blank into someone
      // else's prose.
      carryTo = null;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[0]!.trim() === '') {
    kept.shift();
    if (firstSubheadingAt > 0) firstSubheadingAt -= 1;
    if (firstBulletAt > 0) firstBulletAt -= 1;
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  if (firstSubheadingAt > kept.length) firstSubheadingAt = -1;

  // AT THE HEAD of the section's own bullet list, after any leading prose.
  //
  // Placing the section high is not enough on its own: the busiest live workgroup's `## Map`
  // already starts at byte 1,881 — inside the 2,500-byte head read — but it
  // holds thirteen hand-written bullets, so links appended after them landed
  // at byte 4,308 and the agent never saw them. Leading the list is what makes
  // the folder pointers reachable, and it moves no hand-written line relative
  // to another hand-written line: the whole managed block moves as one, ahead
  // of a list the curator does not own. Never past a sub-heading either — a
  // live index carries `### Folders`, `### Corrections` inside `## Map`.
  // Stable across runs because the managed bullets are removed before these
  // indices are computed.
  const rendered = links.flatMap((link) => [
    `- [${link.title}](${link.target})${link.hook ? ` - ${link.hook}` : ''}`,
    ...(carried.get(link.target) ?? []),
  ]);
  let insertAt = firstBulletAt;
  if (insertAt < 0) {
    insertAt = firstSubheadingAt < 0 ? kept.length : firstSubheadingAt;
    // Land before the blank line that separates the last bullet from the
    // sub-heading, not between the blank line and the heading. Only when
    // anchoring on a heading or on end-of-section: anchoring on a bullet must
    // land exactly ON it, or the blank above it ends up BETWEEN the managed
    // block and the list, splitting one list into two.
    while (insertAt > 0 && kept[insertAt - 1]!.trim() === '') insertAt -= 1;
  }
  const section = [...kept.slice(0, insertAt), ...rendered, ...kept.slice(insertAt)];
  const tail = lines.slice(end);
  // Exactly one blank line before whatever follows. Without this, inserting a
  // new section immediately above an existing heading left the blank that was
  // already there plus the one added here, and a second merge collapsed it —
  // i.e. the create path was not idempotent.
  while (tail.length > 0 && tail[0]!.trim() === '') tail.shift();
  const rebuilt = [...lines.slice(0, start + 1), '', ...section, ...(tail.length > 0 ? ['', ...tail] : [])];
  return `${rebuilt.join('\n').trimEnd()}\n`;
}

/**
 * Display name for a topic file, from its slug. Deterministic and free — the
 * consolidation prompt does not ask the model for a title, and adding a field
 * the model must fill would be one more thing that can drift between the file
 * and the map.
 */
export function titleFromStem(stem: string): string {
  return stem
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => (/^[a-z]/.test(word) ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * The map hook, taken from the file's opening line.
 *
 * The consolidation prompt already requires every topic file to "lead with a
 * short, dense, self-contained summary line", so that line IS the file's
 * description — deriving it costs nothing and can never go stale against the
 * file, which a stored `description` frontmatter field would. Legacy headers
 * and frontmatter are stripped first, so a file the curator has not rewritten
 * yet still yields a real hook.
 */
export function hookFromContent(content: string, maxChars: number): string {
  const body = stripCuratorMetadata(content);
  const lead = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  if (!lead) return '';
  const flat = lead.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ');
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Longest hook a map bullet carries. Concise, per definition.md's "Keep every folder's index accurate and concise". */
export const INDEX_HOOK_MAX_CHARS = 120;

export interface TopicIndexEntry {
  /** File name within the topic folder, e.g. `mira.md`. */
  name: string;
  content: string;
}

/** A flat topic-file leaf, the only thing a folder index can claim. */
const TOPIC_LEAF = /^[a-z0-9][a-z0-9-]*\.md$/;

/**
 * Render one topic folder's `index.md`, merging into whatever is already
 * there. Curator-owned bullets are replaced; a hand-written bullet pointing
 * at a human-authored file in the same folder is kept, and so is any prose.
 *
 * `entries` are the curator-owned files as read this pass — the bullets that
 * get re-rendered. `presentNames` is the folder's OBSERVED listing, and the
 * only licence to delete: a bullet pointing at a topic leaf that the listing
 * proves is gone loses its link, which is how a deleted topic file leaves the
 * map. Everything else stays. See `managedTargets`.
 */
export function renderFolderIndex(
  directory: string,
  entries: readonly TopicIndexEntry[],
  presentNames: ReadonlySet<string>,
  existing: string,
): string {
  // Merge into the heading the file ALREADY has. Insisting on our own
  // `# People` meant an existing `# People Directory` was never matched, so a
  // second complete link set was appended under a second heading and the
  // original was never maintained again.
  const heading = /^# .+$/m.exec(existing)?.[0].trimEnd() ?? `# ${titleFromStem(directory)}`;
  // A human-set `title:`/`description:` wins over the derived slug and lead
  // line — the curator already carries those keys forward untouched, so this
  // is the whole fix for `Mmulhern` and `Gsc Data Pipeline`: set the field
  // once and the map honours it forever. Nothing is ever written by us.
  const links = entries.map((entry) => ({
    target: entry.name,
    title: frontmatterValue(entry.content, 'title') ?? titleFromStem(entry.name.replace(/\.md$/, '')),
    hook: frontmatterValue(entry.content, 'description') ?? hookFromContent(entry.content, INDEX_HOOK_MAX_CHARS),
  }));
  const owns = managedTargets(links, (target) => TOPIC_LEAF.test(target) && !presentNames.has(target));
  return mergeManagedLinks(existing, heading, owns, links);
}

/**
 * Merge the topic-folder pointers into the root `index.md`'s `## Map`.
 *
 * Deliberately three lines, not one per topic file. The root index is read
 * head-first under a hard 2,500-byte bound (`PRE_TURN_BOUNDS.markdownCoreChars`
 * on the host, `MAX_INDEX_BYTES` in the container's bootstrap), and the busiest
 * live workgroup has 231 topic files — a bullet each would be ~26 KB of index,
 * of which the agent would see none. That bound is not a budget memory
 * outgrew; it is definition.md's "headlines and pointers here, detail in
 * linked files" enforced in code, and the per-folder index is definition.md's
 * own answer ("create it and its `index.md` before writing the first concept
 * there"). These three links point at those.
 *
 * A new `## Map` is placed after `## Core Memory` so it lands inside that head
 * read. An existing one is left exactly where it is — a human may have put it
 * there deliberately. `okf_version`, Core Memory and every other section are
 * untouched either way.
 *
 * `links` are the pointers to re-render. `retired` is the ONLY licence to
 * delete one: a folder the caller listed successfully and found nothing to
 * point at. The static list of topic directories used to stand in for that,
 * which deleted the People pointer whenever `people/` failed to list while
 * `domain/` succeeded — a folder that was skipped is not a folder that is
 * gone. See `managedTargets`.
 */
export function mergeRootIndexMap(
  existing: string,
  links: readonly IndexLink[],
  retired: readonly string[] = [],
): string {
  const gone = new Set(retired);
  return mergeManagedLinks(
    existing,
    '## Map',
    managedTargets(links, (target) => gone.has(target)),
    links,
    '## Core Memory',
  );
}
