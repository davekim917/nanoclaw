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
 */

/** One rendered map bullet. */
export interface IndexLink {
  /** Link target, relative to the index file's own directory. */
  target: string;
  title: string;
  /** One-line summary after the dash; empty renders a bare link. */
  hook: string;
}

/** `- [Title](target)` — the bullet shape every index in the live tree uses. */
const BULLET = /^-\s+\[([^\]]*)\]\(([^)\s]+)\)/;

/** A bullet's wrapped continuation line, which must die with its bullet. */
const CONTINUATION = /^\s+\S/;

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

  let start = lines.findIndex((line) => line.trimEnd() === heading);
  let end: number;
  if (start < 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(heading);
    start = lines.length - 1;
    end = lines.length;
  } else {
    end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = /^(#+)\s/.exec(lines[index]!);
      if (match && match[1]!.length <= level) {
        end = index;
        break;
      }
    }
  }

  const kept: string[] = [];
  let dropping = false;
  for (const line of lines.slice(start + 1, end)) {
    const match = BULLET.exec(line.trim());
    if (match) {
      dropping = owns(match[2]!);
      if (dropping) continue;
    } else if (dropping && CONTINUATION.test(line)) {
      continue;
    } else if (line.trim() !== '') {
      dropping = false;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[0]!.trim() === '') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();

  // Insert with the section's own top-level bullets, never past a
  // sub-heading: a live root index carries `### Folders`, `### Corrections`
  // and the like INSIDE `## Map`, and appending at the end of the section
  // would file the folder-index links under whichever subsection happens to
  // be last. Stable across runs because the managed bullets are removed
  // before this index is computed.
  const rendered = links.map((link) => `- [${link.title}](${link.target})${link.hook ? ` - ${link.hook}` : ''}`);
  const firstSubheading = kept.findIndex((line) => new RegExp(`^#{${level + 1},}\\s`).test(line));
  let insertAt = firstSubheading < 0 ? kept.length : firstSubheading;
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
