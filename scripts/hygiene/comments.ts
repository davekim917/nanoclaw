import ts from 'typescript';

type CommentRule = 'inline-suppression' | 'file-line-citation' | 'pr-history';

export interface CommentFinding {
  rule: CommentRule;
  line: number;
  excerpt: string;
}

// Checked before the directive exemption: knip honours these tags even inside an eslint-disable comment.
const SUPPRESSION = /jscpd:ignore-|@(?:public|internal|beta|alias|lintignore)(?![A-Za-z0-9_])/;
const DIRECTIVE = /^(?:eslint-disable|eslint-enable|@ts-expect-error|@ts-ignore|@ts-nocheck|prettier-ignore|c8 ignore)/;
const CITATION = /[\w-]\.(?:[cm]?[jt]sx?|json|sh|py|md|ya?ml|toml|sql):\d/;
const PR_HISTORY = /(?<!&)#\d+\b|\bPR\s?\d+\b/;

function isJSDocNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * Comments are read only from the trivia around tokens, so text inside a string, template or regex
 * literal is never mistaken for one. JSDoc is skipped as a subtree and read once, as the leading
 * trivia of the token it documents.
 */
function commentRanges(sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.text;
  const byStart = new Map<number, ts.CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) byStart.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    if (isJSDocNode(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.getFullStart()));
      add(ts.getTrailingCommentRanges(text, node.getEnd()));
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sourceFile);
  return [...byStart.values()].sort((a, b) => a.pos - b.pos);
}

export function scanComments(fileName: string, text: string): CommentFinding[] {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const findings: CommentFinding[] = [];
  for (const range of commentRanges(sourceFile)) {
    const comment = text.slice(range.pos, range.end);
    const isDirective = DIRECTIVE.test(comment.replace(/^\/[/*]+\s*/, ''));
    const firstLine = sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1;
    comment.split('\n').forEach((lineText, offset) => {
      const report = (rule: CommentRule) =>
        findings.push({ rule, line: firstLine + offset, excerpt: lineText.trim().slice(0, 160) });
      if (SUPPRESSION.test(lineText)) report('inline-suppression');
      if (isDirective) return;
      if (CITATION.test(lineText)) report('file-line-citation');
      if (PR_HISTORY.test(lineText)) report('pr-history');
    });
  }
  return findings;
}
