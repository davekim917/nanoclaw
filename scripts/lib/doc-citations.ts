import { spawnSync } from 'node:child_process';

const CITED_FILE_LINE_RE = /([\w./-]+\.\w+):(\d+)(?:-(\d+))?/g;
const AT_SHA_RE = /^at\s+([0-9a-f]{7,40})\b/;
const PIN_CHAIN_LINK_RE = /^`?(?:(?:[\w./-]+\.\w+)?:\d+(?:-\d+)?|#\d+)`?/;
const PIN_CHAIN_JOIN_RE = /^\s*(?:,|and)\s*/;
const CONTINUATION_RE = /^`?:(\d+)(?:-(\d+))?`?/;

export interface FileLineCitation {
  file: string;
  span: string;
  startLine: number;
  endLine: number;
  index: number;
  end: number;
  pinnedSha: string | null;
}

export interface CitationRun {
  links: FileLineCitation[];
  end: number;
  pinnedSha: string | null;
}

function chainEnd(text: string, pos: number): number {
  let i = text[pos] === '`' ? pos + 1 : pos;
  for (;;) {
    const join = PIN_CHAIN_JOIN_RE.exec(text.slice(i));
    if (!join) break;
    const afterJoin = i + join[0].length;
    const link = PIN_CHAIN_LINK_RE.exec(text.slice(afterJoin));
    if (!link) break;
    i = afterJoin + link[0].length;
  }
  return i;
}

function pinningShaAfter(text: string, pos: number): string | null {
  const rest = text.slice(chainEnd(text, pos)).replace(/^\s*/, '');
  return AT_SHA_RE.exec(rest)?.[1] ?? null;
}

export function fileLineCitations(text: string): FileLineCitation[] {
  const citations: FileLineCitation[] = [];
  for (const m of text.matchAll(CITED_FILE_LINE_RE)) {
    const [whole, file, startStr, endStr] = m;
    const index = m.index ?? 0;
    citations.push({
      file,
      span: endStr ? `${startStr}-${endStr}` : startStr,
      startLine: Number(startStr),
      endLine: Number(endStr ?? startStr),
      index,
      end: index + whole.length,
      pinnedSha: pinningShaAfter(text, index + whole.length),
    });
  }
  return citations;
}

export function citationRuns(text: string): CitationRun[] {
  const runs: CitationRun[] = [];
  let consumedTo = 0;
  for (const head of fileLineCitations(text)) {
    if (head.index < consumedTo) continue;
    const links: FileLineCitation[] = [head];
    let file = head.file;
    let i = text[head.end] === '`' ? head.end + 1 : head.end;
    for (;;) {
      const join = PIN_CHAIN_JOIN_RE.exec(text.slice(i));
      if (!join) break;
      const at = i + join[0].length;
      const link = PIN_CHAIN_LINK_RE.exec(text.slice(at));
      if (!link) break;
      const continuation = CONTINUATION_RE.exec(link[0]);
      const own = fileLineCitations(link[0])[0];
      if (continuation) {
        const [, s, e] = continuation;
        links.push({
          file,
          span: e ? `${s}-${e}` : s,
          startLine: Number(s),
          endLine: Number(e ?? s),
          index: at,
          end: at + link[0].length,
          pinnedSha: head.pinnedSha,
        });
      } else if (own) {
        file = own.file;
        links.push({ ...own, index: at + own.index, end: at + own.end, pinnedSha: head.pinnedSha });
      }
      i = at + link[0].length;
    }
    consumedTo = i;
    runs.push({ links, end: i, pinnedSha: head.pinnedSha });
  }
  return runs;
}

function countLines(content: string): number {
  if (content === '') return 0;
  return (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n').length;
}

export function gitRead(root: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

export function gitPathExists(root: string, filePath: string, rev?: string): boolean {
  if (rev === undefined)
    return (
      spawnSync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', filePath], { cwd: root }).status ===
      0
    );
  return spawnSync('git', ['cat-file', '-e', `${rev}:${filePath}`], { cwd: root }).status === 0;
}

export function gitCommitResolvable(root: string, sha: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;
}

export function gitIsShallowRepo(root: string): boolean {
  return (gitRead(root, ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
}

function gitLineCount(root: string, filePath: string, rev?: string): number | null {
  const content = gitRead(root, ['show', `${rev ?? ''}:${filePath}`]);
  return content === null ? null : countLines(content);
}

export type LineCitationCheck = { ok: true } | { ok: false; problem: string } | { ok: 'skipped'; reason: string };

export function checkLineCitation(
  root: string,
  citation: Pick<FileLineCitation, 'file' | 'span' | 'endLine' | 'pinnedSha'>,
  label = `\`${citation.file}:${citation.span}\``,
): LineCitationCheck {
  const { file, endLine, pinnedSha } = citation;
  if (pinnedSha) {
    if (!gitCommitResolvable(root, pinnedSha)) {
      if (gitIsShallowRepo(root))
        return { ok: 'skipped', reason: `${label} at ${pinnedSha}: not resolvable in this shallow clone` };
      return {
        ok: false,
        problem: `cites ${label} at ${pinnedSha}, but ${pinnedSha} does not resolve to a commit here`,
      };
    }
    if (!gitPathExists(root, file, pinnedSha))
      return { ok: false, problem: `cites ${label} at ${pinnedSha}, but ${file} does not exist at ${pinnedSha}` };
    const lineCount = gitLineCount(root, file, pinnedSha);
    if (lineCount === null || lineCount < endLine)
      return {
        ok: false,
        problem: `cites ${label} at ${pinnedSha}, but ${file} has only ${lineCount ?? 0} lines at ${pinnedSha}`,
      };
    return { ok: true };
  }
  if (!gitPathExists(root, file)) return { ok: false, problem: `cites ${label}, but ${file} does not exist` };
  const lineCount = gitLineCount(root, file);
  if (lineCount === null || lineCount < endLine)
    return { ok: false, problem: `cites ${label}, but ${file} has only ${lineCount ?? 0} lines` };
  return { ok: true };
}
