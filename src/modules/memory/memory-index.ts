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
 * section ordering, fenced blocks, non-indented prose, and hand-written
 * bullets whose target the curator does not claim all survive. Trailing
 * whitespace inside and after the managed section is normalized, and the
 * lines immediately indented under a replaced bullet die with it.
 *
 * This is a line-walker, not a Markdown parser. Fenced blocks, HTML comments,
 * and CommonMark's 0-3 space indent rule for a top-level list item are
 * handled, which covers every construct that was destroying content. What is
 * still mishandled, verified by probing rather than assumed — none of these
 * lose content, they duplicate a link or add a second section:
 *
 *   - `> - [X](y.md)` in a blockquote, `* [X](y.md)` with a star marker, a
 *     tab-indented bullet, and a `[X]: y.md` link reference definition are not
 *     claimed, so a second link to the same target is appended beside them;
 *   - a setext `Map\n---` heading is not recognized, so a fresh `## Map`
 *     section is appended at end of file instead of merging into it.
 *
 * See docs/memory.md.
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

// A replaced bullet takes NOTHING with it but its own line.
//
// There used to be a rule that also deleted the indented lines under it, on
// the theory that they were its wrapped tail. They are not: a bullet this
// module renders is single-line by construction — the hook is bounded and has
// its whitespace collapsed — so the curator has never written a wrapped
// bullet, and anything indented under one was written by somebody else. The
// rule deleted a hand-written note, an indented code block, a nested
// sub-bullet and a blockquote, and kept only the case it was aimed at, which
// cannot occur. Positive evidence: delete the line we know is ours.

/**
 * Which lines sit inside a fenced code block or an HTML comment.
 *
 * This module walks lines; it is not a Markdown parser. These are the two
 * constructs it MUST know about, because an index that documents its own
 * format puts a real-looking bullet inside a ``` block or comments one out —
 * and deleting the documentation of the map is the same class of bug as
 * deleting the map. Computed once and consulted by every scan below.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const line of lines) {
    if (comment) {
      inside.push(true);
      if (line.includes('-->')) comment = false;
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null) {
      if (/^ {0,3}<!--/.test(line)) {
        inside.push(true);
        comment = !line.includes('-->');
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
  /** End of the section `text` opens: the next heading at its level or above. */
  const sectionEnd = (at: number, atLevel: number): number => {
    for (let index = at + 1; index < lines.length; index += 1) {
      if (fenced[index]) continue;
      const match = /^(#+)\s/.exec(lines[index]!);
      if (match && match[1]!.length <= atLevel) return index;
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
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!fenced[index] && line.trim() !== '') {
      const match = BULLET.exec(line);
      const nested = match !== null && line.startsWith(' ') && listOpen;
      if (match && !nested) {
        listOpen = true;
        if (owns(match[2]!)) continue;
        if (firstBulletAt < 0) firstBulletAt = kept.length;
      } else {
        listOpen = match !== null || /^[ \t]+\S/.test(line);
        if (!listOpen && firstSubheadingAt < 0 && subheading.test(line)) firstSubheadingAt = kept.length;
      }
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
  // Placing the section high is not enough on its own: madison-reed's `## Map`
  // already starts at byte 1,881 — inside the 2,500-byte head read — but it
  // holds thirteen hand-written bullets, so links appended after them landed
  // at byte 4,308 and the agent never saw them. Leading the list is what makes
  // the folder pointers reachable, and it moves no hand-written line relative
  // to another hand-written line: the whole managed block moves as one, ahead
  // of a list the curator does not own. Never past a sub-heading either — a
  // live index carries `### Folders`, `### Corrections` inside `## Map`.
  // Stable across runs because the managed bullets are removed before these
  // indices are computed.
  const rendered = links.map((link) => `- [${link.title}](${link.target})${link.hook ? ` - ${link.hook}` : ''}`);
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
  /** File name within the topic folder, e.g. `james.md`. */
  name: string;
  content: string;
}

/**
 * Render one topic folder's `index.md`, merging into whatever is already
 * there. Curator-owned bullets are replaced; a hand-written bullet pointing
 * at a human-authored file in the same folder is kept, and so is any prose.
 *
 * `owned` names the files this curator owns right now. A bullet pointing at a
 * flat `.md` that is neither in `owned` nor still on disk is dropped too —
 * that is how a deleted topic file leaves the map.
 */
export function renderFolderIndex(
  directory: string,
  entries: readonly TopicIndexEntry[],
  ownedNames: ReadonlySet<string>,
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
  const owns = (target: string): boolean =>
    /^[a-z0-9][a-z0-9-]*\.md$/.test(target) && (ownedNames.has(target) || !presentNames.has(target));
  return mergeManagedLinks(existing, heading, owns, links);
}

/** Root-index Map bullets the curator owns: the topic-folder indexes, nothing else. */
export function rootIndexOwns(topicDirectories: readonly string[]): (target: string) => boolean {
  const managed = new Set(topicDirectories.map((directory) => `${directory}/index.md`));
  return (target) => managed.has(target);
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
 */
export function mergeRootIndexMap(
  existing: string,
  topicDirectories: readonly string[],
  links: readonly IndexLink[],
): string {
  return mergeManagedLinks(existing, '## Map', rootIndexOwns(topicDirectories), links, '## Core Memory');
}
