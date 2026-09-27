#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { walkArgs } from './lib/cli-args.js';
import { citationRuns, gitRead, type CitationRun, type FileLineCitation } from './lib/doc-citations.js';

const MAX_EARLIER_VERSIONS = 5;
const USAGE =
  'usage: pnpm exec tsx scripts/pin-doc-citations.ts [--doc <path>]... [--rev <rev>] [--dry-run] [<cited file>...]\n' +
  '  Appends " at <sha>" to each unpinned file:line citation (of the listed files, or all) in the docs\n' +
  '  (default: docs/review-notes.md and docs/review-notes/*.md). The sha is the newest revision, from the\n' +
  "  commit that introduced the citation back through the cited file's earlier versions, whose cited lines\n" +
  '  hold an identifier the note names next to the citation. A citation with no such identifier, no\n' +
  '  matching revision, or two different matching versions around its own commit is refused and left\n' +
  '  for a manual pin; the run then exits 1. Each doc must match --rev apart from pins: commit a new note first.';

export type PinOutcome =
  | { kind: 'pinned'; doc: string; line: number; citation: string; sha: string; origin: string }
  | { kind: 'refused'; doc: string; line: number; citation: string; reason: string };

export function noteAnchors(clause: string, citedFiles: readonly string[]): string[] {
  const fileWords = new Set(
    citedFiles.flatMap((file) => path.posix.basename(file).split(/[^\w$-]+/)).filter((word) => word.length > 0),
  );
  const found = new Set<string>();
  const add = (word: string): void => {
    if (word.length >= 4 && !fileWords.has(word)) found.add(word);
  };
  const identifierShapes = [
    /\b[a-z][a-z0-9]*[A-Z]\w*/g,
    /\b[A-Z][a-z0-9]+[A-Z]\w*/g,
    /\b[A-Za-z][A-Za-z0-9]*_\w+/g,
    /\b[A-Za-z_$][\w$]*(?=\()/g,
  ];
  const addShaped = (text: string): void => {
    for (const shape of identifierShapes) for (const [word] of text.matchAll(shape)) add(word);
  };
  for (const [, span] of clause.matchAll(/`([^`]+)`/g)) {
    if (/\.\w+:\d/.test(span) || /^:\d/.test(span)) continue;
    if (/\//.test(span) || /^[\w.-]+\.[a-z]{1,4}$/.test(span)) continue;
    if (/\s/.test(span)) {
      addShaped(span);
      if (span.trim().length >= 6 && /[A-Za-z]{3}/.test(span)) found.add(span.trim());
    } else for (const [word] of span.matchAll(/[A-Za-z_$][\w$]*(?:-[\w$]+)*/g)) add(word);
  }
  const prose = clause.replace(/`[^`]*`/g, ' ');
  addShaped(prose);
  for (const [, single, double] of prose.matchAll(/(?<!\w)'([^'\n]{5,200})'(?!\w)|"([^"\n]{5,200})"/g))
    found.add(single ?? double);
  return [...found];
}

export function citationClause(text: string, start: number, end: number): string {
  const boundary = /(?: · |; |\.\s+(?=[A-Z`(#]))/g;
  let clauseStart = 0;
  let clauseEnd = text.length;
  const masked = text.replace(/`[^`]*`/g, (span) => 'x'.repeat(span.length));
  for (const m of masked.matchAll(boundary)) {
    const at = m.index ?? 0;
    if (at + m[0].length <= start) clauseStart = at + m[0].length;
    else if (at >= end) {
      clauseEnd = at;
      break;
    }
  }
  return text.slice(clauseStart, start) + text.slice(end, clauseEnd);
}

function linesAt(root: string, rev: string, file: string, cache: Map<string, string[] | null>): string[] | null {
  const key = `${rev}:${file}`;
  if (!cache.has(key)) {
    const content = gitRead(root, ['show', key]);
    cache.set(key, content === null ? null : content.split('\n'));
  }
  return cache.get(key) ?? null;
}

function citedText(lines: string[] | null, link: FileLineCitation): string | null {
  if (!lines || link.endLine > lines.length || link.startLine < 1) return null;
  return lines.slice(link.startLine - 1, link.endLine).join('\n');
}

function citedLinks(line: string): Set<string> {
  return new Set(citationRuns(line).flatMap((run) => run.links.map((link) => `${link.file}:${link.span}`)));
}

function introducingCommit(root: string, rev: string, doc: string, lineNumber: number, cited: string): string | null {
  const history = gitRead(root, ['log', `-L${lineNumber},${lineNumber}:${doc}`, '--format=%x00%H', rev]) ?? '';
  let oldest: string | null = null;
  for (const entry of history.split('\0').filter(Boolean)) {
    const [sha, ...patch] = entry.split('\n');
    const body = patch.filter((line) => !/^(?:\+\+\+|---) (?:[ab]\/|\/dev\/null)/.test(line));
    const after = body.filter((line) => line.startsWith('+')).map((line) => line.slice(1));
    const before = body.filter((line) => line.startsWith('-')).map((line) => line.slice(1));
    if (after.length === 0 && before.length === 0) continue;
    if (!after.some((line) => citedLinks(line).has(cited))) break;
    oldest = sha.trim();
    if (!before.some((line) => citedLinks(line).has(cited))) break;
  }
  return oldest;
}

const unpinned = (line: string): string => line.replace(/\s+at\s+[0-9a-f]{7,40}\b/g, '');

function newestOf(root: string, shas: readonly string[]): string | null {
  const isAncestor = (a: string, b: string): boolean =>
    spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }).status === 0;
  return shas.find((sha) => shas.every((other) => isAncestor(other, sha))) ?? null;
}

function candidateRevisions(root: string, origin: string, files: readonly string[]): string[] {
  const touching = (gitRead(root, ['log', '--format=%H', `-n${MAX_EARLIER_VERSIONS}`, origin, '--', ...files]) ?? '')
    .split('\n')
    .filter(Boolean);
  const revs = [origin, ...touching.map((sha) => `${sha}^`)];
  const seenVersions = new Set<string>();
  const out: string[] = [];
  for (const rev of revs) {
    const version = files
      .map((file) => gitRead(root, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`])?.trim() ?? 'missing')
      .join(' ');
    if (seenVersions.has(version)) continue;
    seenVersions.add(version);
    const sha = gitRead(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim();
    if (sha) out.push(sha);
  }
  return out;
}

function shortSha(root: string, sha: string): string {
  return gitRead(root, ['rev-parse', '--short=9', sha])?.trim() ?? sha;
}

function mentions(text: string, anchor: string): boolean {
  if (!/^[\w$-]+$/.test(anchor)) return text.includes(anchor);
  return new RegExp(`(?<![\\w$])${anchor.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
}

function choosePin(
  root: string,
  links: readonly FileLineCitation[],
  anchors: readonly string[],
  candidates: readonly string[],
  originTouchedFile: boolean,
): { sha: string } | { refused: string } {
  if (anchors.length === 0)
    return { refused: 'the note names no identifier next to it to check the cited lines against' };
  const cache = new Map<string, string[] | null>();
  const view = (rev: string): string[] | null => {
    const texts = links.map((link) => citedText(linesAt(root, rev, link.file, cache), link));
    return texts.every((text): text is string => text !== null) ? texts : null;
  };
  const matches = (texts: string[] | null): boolean =>
    texts !== null && texts.every((text) => anchors.some((anchor) => mentions(text, anchor)));
  const index = candidates.findIndex((rev) => matches(view(rev)));
  if (index === -1)
    return {
      refused: `no revision among ${candidates.map((rev) => shortSha(root, rev)).join(', ')} has ${anchors.join(', ')} at the cited lines`,
    };
  if (index === 0 && originTouchedFile && candidates.length > 1) {
    const origin = view(candidates[0]);
    const before = view(candidates[1]);
    if (matches(before) && JSON.stringify(before) !== JSON.stringify(origin))
      return {
        refused:
          `both ${shortSha(root, candidates[0])} (the note's own commit) and ${shortSha(root, candidates[1])} (just before it) ` +
          'match with different code at the cited lines',
      };
  }
  return { sha: candidates[index] };
}

function runFiles(run: CitationRun): string[] {
  return [...new Set(run.links.map((link) => link.file))];
}

export function pinDocs(
  root: string,
  docs: readonly string[],
  citedFiles: readonly string[],
  options: { rev?: string; write?: boolean } = {},
): PinOutcome[] {
  const rev = options.rev ?? 'HEAD';
  const outcomes: PinOutcome[] = [];
  for (const doc of docs) {
    const lines = fs.readFileSync(path.join(root, doc), 'utf8').split('\n');
    const committed = gitRead(root, ['show', `${rev}:${doc}`])?.split('\n');
    const inSync =
      committed !== undefined &&
      committed.length === lines.length &&
      lines.every((line, n) => unpinned(line) === unpinned(committed[n]));
    let changed = false;
    lines.forEach((text, i) => {
      const inserts: { at: number; sha: string }[] = [];
      for (const run of citationRuns(text)) {
        const head = run.links[0];
        if (run.pinnedSha) continue;
        const files = runFiles(run);
        if (citedFiles.length > 0 && !files.some((file) => citedFiles.includes(file))) continue;
        const citation = text.slice(head.index, run.end).replace(/`/g, '');
        if (!gitRead(root, ['log', '-1', '--format=%H', rev, '--', head.file])?.trim()) continue;
        const refuse = (reason: string): void => {
          outcomes.push({ kind: 'refused', doc, line: i + 1, citation, reason });
        };
        if (!inSync) {
          refuse(`${doc} differs from ${rev} by more than pins; commit it first`);
          continue;
        }
        const onLine = citationRuns(text).flatMap((other) => other.links.map((link) => `${link.file}:${link.span}`));
        if (run.links.some((link) => onLine.filter((key) => key === `${link.file}:${link.span}`).length > 1)) {
          refuse('the line cites the same file:line more than once, so its history cannot tell them apart');
          continue;
        }
        const linkOrigins = run.links.map((link) =>
          introducingCommit(root, rev, doc, i + 1, `${link.file}:${link.span}`),
        );
        if (linkOrigins.some((sha) => sha === null)) {
          refuse("the line's history does not show the commit that added this citation");
          continue;
        }
        const origin = newestOf(root, linkOrigins as string[]);
        if (!origin) {
          refuse('its citations were added on unrelated branches');
          continue;
        }
        const candidates = candidateRevisions(root, origin, files);
        const originTouchedFile = Boolean(
          gitRead(root, ['diff', '--name-only', `${origin}^`, origin, '--', ...files])?.trim(),
        );
        const runStart = text[head.index - 1] === '`' ? head.index - 1 : head.index;
        const anchors = noteAnchors(citationClause(text, runStart, run.end), files);
        const decision = choosePin(root, run.links, anchors, candidates, originTouchedFile);
        if ('refused' in decision) {
          refuse(decision.refused);
          continue;
        }
        const sha = shortSha(root, decision.sha);
        inserts.push({ at: run.end, sha });
        outcomes.push({ kind: 'pinned', doc, line: i + 1, citation, sha, origin: shortSha(root, origin) });
      }
      if (inserts.length === 0) return;
      let next = text;
      for (const { at, sha } of inserts.sort((a, b) => b.at - a.at))
        next = `${next.slice(0, at)} at ${sha}${next.slice(at)}`;
      lines[i] = next;
      changed = true;
    });
    if (changed && options.write !== false) fs.writeFileSync(path.join(root, doc), lines.join('\n'));
  }
  return outcomes;
}

function reviewNotesDocs(root: string): string[] {
  const dir = path.join(root, 'docs', 'review-notes');
  const fragments = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => `docs/review-notes/${name}`)
    : [];
  return ['docs/review-notes.md', ...fragments].filter((doc) => fs.existsSync(path.join(root, doc)));
}

function main(): void {
  const fail = (message: string): never => {
    console.error(`${message}\n${USAGE}`);
    process.exit(2);
  };
  const docs: string[] = [];
  const files: string[] = [];
  let rev: string | undefined;
  let dryRun = false;
  walkArgs(process.argv.slice(2), fail, (name, arg, value) => {
    if (name === '--doc') docs.push(value());
    else if (name === '--rev') rev = value();
    else if (name === '--dry-run') dryRun = true;
    else if (name === '--help' || name === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else files.push(arg);
  });
  const root = (gitRead(process.cwd(), ['rev-parse', '--show-toplevel']) ?? fail('not inside a git repo')).trim();
  const outcomes = pinDocs(root, docs.length > 0 ? docs : reviewNotesDocs(root), files, { rev, write: !dryRun });
  for (const outcome of outcomes) {
    if (outcome.kind === 'pinned')
      console.log(
        `${outcome.doc}:${outcome.line}: ${outcome.citation} at ${outcome.sha} (introduced in ${outcome.origin})`,
      );
    else console.log(`REFUSED ${outcome.doc}:${outcome.line}: ${outcome.citation}: ${outcome.reason}; pin it by hand`);
  }
  const refused = outcomes.filter((outcome) => outcome.kind === 'refused').length;
  console.log(`pinned ${outcomes.length - refused}, refused ${refused}${dryRun ? ' (dry run, nothing written)' : ''}`);
  process.exit(refused > 0 ? 1 : 0);
}

if (process.argv[1] && new URL(process.argv[1], 'file:').href === import.meta.url) {
  main();
}
