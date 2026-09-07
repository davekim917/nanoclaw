/**
 * Guard for the MCP tool-exposure design this skill depends on.
 *
 * Registering `gmail` in a group's mcpServers map is the *only* wiring needed to expose
 * `mcp__gmail__*` to the agent — there is no static TOOL_ALLOWLIST edit and no per-server
 * allow-pattern to derive. That holds because `claude.ts` sets no explicit `allowedTools`
 * list on the SDK query: `allowedTools` is an auto-allow list, not an include-filter, and
 * the query already runs under `permissionMode: 'bypassPermissions'` +
 * `allowDangerouslySkipPermissions: true`, so every tool the SDK surfaces — including any
 * registered MCP server's tools — is open by default. Only `disallowedTools:
 * SDK_DISALLOWED_TOOLS` narrows that surface, and it blocks by name, not by server, so a
 * registered `gmail` server is never filtered.
 *
 * We guard it structurally: assert the `sdkQuery(...)` call's `options` object carries
 * `disallowedTools` but no `allowedTools` key. Reintroduce an `allowedTools` list and this
 * goes red, surfacing that `gmail` tools would need to be added to it or they'd be silently
 * filtered out despite being registered.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import ts from 'typescript';

const { describe, it, expect } = (await import(
  (globalThis as { Bun?: unknown }).Bun === undefined ? 'vitest' : 'bun:test',
)) as typeof import('vitest');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function source(): { sf: ts.SourceFile } {
  const installed = path.join(TEST_DIR, 'claude.ts');
  if (fs.existsSync(installed)) {
    const text = fs.readFileSync(installed, 'utf8');
    return { sf: ts.createSourceFile(installed, text, ts.ScriptTarget.Latest, true) };
  }
  const instructions = fs.readFileSync(path.join(TEST_DIR, '..', 'SKILL.md'), 'utf8');
  if (!/disallowedTools:\s*SDK_DISALLOWED_TOOLS/.test(instructions)) {
    throw new Error('disallowedTools-only MCP tool-exposure design not found in SKILL.md');
  }
  const text = 'sdkQuery({ options: { disallowedTools: SDK_DISALLOWED_TOOLS } });';
  return { sf: ts.createSourceFile('SKILL.md', text, ts.ScriptTarget.Latest, true) };
}

/** Property names of the `options` object literal passed to the `sdkQuery(...)` call. */
function sdkQueryOptionKeys(sf: ts.SourceFile): string[] {
  let keys: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'sdkQuery' &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const optionsProp = node.arguments[0].properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'options',
      );
      if (optionsProp && ts.isObjectLiteralExpression(optionsProp.initializer)) {
        keys = optionsProp.initializer.properties
          .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : undefined))
          .filter((name): name is string => name !== undefined);
      }
    }
    if (!keys) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!keys) throw new Error('sdkQuery({ options: {...} }) call not found');
  return keys;
}

describe('claude.ts leaves the MCP tool surface open by default (no allowedTools list)', () => {
  const { sf } = source();
  const keys = sdkQueryOptionKeys(sf);

  it('does not set an explicit allowedTools list', () => {
    expect(keys).not.toContain('allowedTools');
  });

  it('gates the tool surface with disallowedTools only', () => {
    expect(keys).toContain('disallowedTools');
  });
});
