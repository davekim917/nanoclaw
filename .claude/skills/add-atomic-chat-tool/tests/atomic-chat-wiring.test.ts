/**
 * Wiring test for the host-side env-forwarding integration point (host/vitest tree).
 *
 * The env helper is behavior-tested in atomic-chat-env.test.ts, but that does not prove
 * buildContainerArgs actually uses it — a direct unit test stays green even if the reach-in
 * is deleted. buildContainerArgs is entangled with OneCLI and not cheaply invocable, so we
 * assert the integration structurally: inside buildContainerArgs there is an
 * `args.push(...atomicChatEnvArgs())` call. Delete the reach-in and this goes red.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function sourceFile(): ts.SourceFile {
  const installed = path.join(TEST_DIR, 'container-runner.ts');
  if (fs.existsSync(installed)) {
    return ts.createSourceFile(installed, fs.readFileSync(installed, 'utf8'), ts.ScriptTarget.Latest, true);
  }
  const skill = fs.readFileSync(path.join(TEST_DIR, '..', 'SKILL.md'), 'utf8');
  const snippet = [...skill.matchAll(/```ts\n([\s\S]*?)```/g)].find(
    (match) => match[1].includes('args.push(...atomicChatEnvArgs())'),
  )?.[1];
  if (!snippet) throw new Error('atomicChatEnvArgs wiring snippet not found in SKILL.md');
  return ts.createSourceFile(
    'SKILL.md',
    `function buildContainerArgs() { ${snippet} }`,
    ts.ScriptTarget.Latest,
    true,
  );
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Is this node `args.push(...atomicChatEnvArgs())`? */
function isSpreadPushOfEnvArgs(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.name.text !== 'push' ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'args'
  ) {
    return false;
  }
  return node.arguments.some(
    (arg) =>
      ts.isSpreadElement(arg) &&
      ts.isCallExpression(arg.expression) &&
      ts.isIdentifier(arg.expression.expression) &&
      arg.expression.expression.text === 'atomicChatEnvArgs',
  );
}

describe('container-runner.ts wires in atomicChatEnvArgs', () => {
  const sf = sourceFile();
  const fn = findFunction(sf, 'buildContainerArgs');

  it('finds buildContainerArgs', () => {
    expect(fn).toBeDefined();
  });

  it('calls args.push(...atomicChatEnvArgs()) inside buildContainerArgs', () => {
    let wired = false;
    const visit = (node: ts.Node) => {
      if (isSpreadPushOfEnvArgs(node)) wired = true;
      if (!wired) ts.forEachChild(node, visit);
    };
    if (fn?.body) visit(fn.body);
    expect(wired).toBe(true);
  });
});
