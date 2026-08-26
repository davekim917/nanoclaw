import { stripCuratorMetadata } from './curator-contract.js';

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
 *   - `> - [X](y.md)` in a blockquote, `* [X](y.md)` with a star marker, and a
 *     `[X]: y.md` link reference definition are not claimed, so a second link
 *     to the same target is appended beside them;
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

/** A bullet's wrapped continuation line, which must die with its bullet.
 *  Only the lines IMMEDIATELY under it — a blank line ends the bullet, and
 *  anything after that blank is someone else's prose. */
const CONTINUATION = /^\s+\S/;

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
): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const lines = existing.length > 0 ? existing.split('\n') : [];
  let fenced = fencedLines(lines);

  let start = lines.findIndex((line, index) => !fenced[index] && line.trimEnd() === heading);
  let end: number;
  if (start < 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(heading);
    fenced = fencedLines(lines);
    start = lines.length - 1;
    end = lines.length;
  } else {
    end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (fenced[index]) continue;
      const match = /^(#+)\s/.exec(lines[index]!);
      if (match && match[1]!.length <= level) {
        end = index;
        break;
      }
    }
  }

  const subheading = new RegExp(`^#{${level + 1},}\\s`);
  const kept: string[] = [];
  let firstSubheadingAt = -1;
  let dropping = false;
  // An indented bullet is a NESTED item when a list is already open, and a
  // top-level item when one is not — CommonMark allows a top-level item up to
  // three spaces in. Without this, a hand-written sub-bullet under someone
  // else's link is read as top-level and replaced.
  let listOpen = false;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!;
    if (fenced[index]) {
      dropping = false;
    } else if (line.trim() === '') {
      // A blank line ends the bullet. Anything indented after it is a new
      // block someone wrote, not this bullet's wrapped tail — carrying
      // `dropping` across the blank is what silently ate hand-written notes.
      // (It does NOT end the list: a loose list has blanks between items.)
      dropping = false;
    } else {
      const match = BULLET.exec(line);
      const nested = match !== null && line.startsWith(' ') && listOpen;
      if (match && !nested) {
        listOpen = true;
        dropping = owns(match[2]!);
        if (dropping) continue;
      } else if (dropping && CONTINUATION.test(line)) {
        continue; // wrapped tail or nested item of a bullet being replaced
      } else {
        dropping = false;
        listOpen = match !== null || CONTINUATION.test(line);
        if (!listOpen && firstSubheadingAt < 0 && subheading.test(line)) firstSubheadingAt = kept.length;
      }
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[0]!.trim() === '') {
    kept.shift();
    if (firstSubheadingAt > 0) firstSubheadingAt -= 1;
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  if (firstSubheadingAt > kept.length) firstSubheadingAt = -1;

  // Insert with the section's own top-level bullets, never past a
  // sub-heading: a live root index carries `### Folders`, `### Corrections`
  // and the like INSIDE `## Map`, and appending at the end of the section
  // would file the folder-index links under whichever subsection happens to
  // be last. Stable across runs because the managed bullets are removed
  // before this index is computed.
  const rendered = links.map((link) => `- [${link.title}](${link.target})${link.hook ? ` - ${link.hook}` : ''}`);
  let insertAt = firstSubheadingAt < 0 ? kept.length : firstSubheadingAt;
  // Land before the blank line that separates the bullets from the
  // sub-heading, not between the blank line and the heading.
  while (insertAt > 0 && kept[insertAt - 1]!.trim() === '') insertAt -= 1;
  const section = [...kept.slice(0, insertAt), ...rendered, ...kept.slice(insertAt)];
  const tail = lines.slice(end);
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
  const heading = `# ${titleFromStem(directory)}`;
  const links = entries.map((entry) => ({
    target: entry.name,
    title: titleFromStem(entry.name.replace(/\.md$/, '')),
    hook: hookFromContent(entry.content, INDEX_HOOK_MAX_CHARS),
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
 * Deliberately three lines, not one per topic file. The root index is
 * injected into every fresh context window under a hard per-file character
 * bound (`PRE_TURN_BOUNDS.markdownCoreChars`), and the busiest live workgroup
 * has 231 topic files — a bullet each would be ~26 KB of index, of which the
 * agent would see none and the operator would have to scroll past all of it.
 * OKF's own answer is the per-folder index, and that is what these three
 * links point at. `okf_version`, Core Memory and every other section are
 * untouched.
 */
export function mergeRootIndexMap(
  existing: string,
  topicDirectories: readonly string[],
  links: readonly IndexLink[],
): string {
  return mergeManagedLinks(existing, '## Map', rootIndexOwns(topicDirectories), links);
}
