/**
 * Wiring test for the MCP-server registration integration point (container/Bun tree).
 *
 * The handlers are behavior-tested in atomic-chat-mcp-stdio.test.ts, but that does not
 * prove the server is registered — delete the index.ts entry and the tool simply never
 * appears, yet the handler test stays green. index.ts is the container boot entry and is
 * not cheaply invocable, so we assert the registration structurally: the `mcpServers`
 * object literal has an `atomic_chat` property whose command runs `atomic-chat-mcp-stdio.ts`.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import ts from 'typescript';

const { describe, it, expect } = (await import(
  (globalThis as { Bun?: unknown }).Bun === undefined ? 'vitest' : 'bun:test',
)) as typeof import('vitest');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFile(): ts.SourceFile {
  const installed = path.join(TEST_DIR, 'index.ts');
  if (fs.existsSync(installed)) {
    return ts.createSourceFile(installed, fs.readFileSync(installed, 'utf8'), ts.ScriptTarget.Latest, true);
  }
  const skill = fs.readFileSync(path.join(TEST_DIR, '..', 'SKILL.md'), 'utf8');
  const snippet = [...skill.matchAll(/```ts\n([\s\S]*?)```/g)].find((match) =>
    match[1].includes('atomic_chat'),
  )?.[1];
  if (!snippet) throw new Error('atomic_chat registration snippet not found in SKILL.md');
  return ts.createSourceFile('SKILL.md', snippet, ts.ScriptTarget.Latest, true);
}

/** Find the object literal assigned to `const mcpServers = { ... }`. */
function mcpServersLiteral(sf: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'mcpServers' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      ((ts.isIdentifier(p.name) && p.name.text === name) ||
        (ts.isStringLiteral(p.name) && p.name.text === name)),
  );
}

describe('index.ts registers the atomic_chat MCP server', () => {
  const obj = mcpServersLiteral(sourceFile());

  it('finds the mcpServers object literal', () => {
    expect(obj).toBeDefined();
  });

  it('has an atomic_chat entry', () => {
    expect(obj && property(obj, 'atomic_chat')).toBeDefined();
  });

  it('points atomic_chat at atomic-chat-mcp-stdio.ts', () => {
    const entry = obj && property(obj, 'atomic_chat');
    const text = entry ? entry.getText() : '';
    expect(text).toContain('atomic-chat-mcp-stdio.ts');
  });
});
