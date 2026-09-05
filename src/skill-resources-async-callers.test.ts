/**
 * Structural tripwire: a skill RESOURCE may not call an async `src/` export
 * without awaiting it.
 *
 * Why this file exists. A skill's `resources` directory is production code the
 * moment the skill is installed - add-dashboard's SKILL.md copies
 * `resources/dashboard-pusher.ts` to `src/dashboard-pusher.ts` - but it is the
 * one production surface with NO static gate:
 *
 *   - neither tsconfig includes it, and neither can, because its imports
 *     (`./db/agent-groups.js`) only resolve from the INSTALL location, not from
 *     where the file is checked in;
 *   - eslint.config.js scopes the type-aware promise rules
 *     (no-floating-promises, no-misused-promises, await-thenable) to `src/`
 *     only, so they never see it either.
 *
 * Seam 3 PR 5b made six permissions leaves async and the pusher kept calling
 * them synchronously. `getMembers(id).map(...)` on a Promise throws, the throw
 * landed in `push(config).catch(log.error)`, and the dashboard feed died
 * silently. Nothing but the skill's own behavioral test caught it, and only
 * because that test posts a real snapshot.
 *
 * So this test IS the missing gate, and it is cheap: parse the resource, work
 * out what each relative import would resolve to at the install location, read
 * that file's async exports, and fail on any bare call. It uses the TypeScript
 * compiler API rather than the type checker, so it needs no program, no
 * tsconfig and no mocks - the same shape as `src/db/transaction-closures.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_ROOT = path.join(REPO_ROOT, '.claude', 'skills');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Every `.ts` under any skill's `resources/`, at any depth. */
function resourceFiles(): string[] {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
  };
  for (const skill of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const resources = path.join(SKILLS_ROOT, skill.name, 'resources');
    if (fs.existsSync(resources)) walk(resources);
  }
  return out.sort();
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * Resolve a resource's relative specifier the way the INSTALL does: the file
 * lands at `src/<basename>`, so `./db/x.js` is `src/db/x.ts`. Returns null for
 * anything that does not land on a real file under `src/` — packages, deep
 * `@scope/...` ids, and specifiers pointing outside the tree.
 */
function resolveAsInstalled(specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const asTs = specifier.replace(/\.js$/, '.ts');
  const resolved = path.resolve(SRC_ROOT, asTs);
  if (!resolved.startsWith(SRC_ROOT + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

/** `export async function f` and `export const f = async (…)`, by name. */
function asyncExportNames(file: string): Set<string> {
  const names = new Set<string>();
  const sf = parse(file);
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isAsync = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node) && isAsync(node)) {
      names.add(node.name.text);
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && isAsync(init)) {
          names.add(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** The shapes that consume a promise correctly. Anything else drops it. */
function isConsumed(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (ts.isAwaitExpression(parent)) return true;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isVoidExpression(parent)) return true;
  // Concise arrow body: `() => getUser(id)` hands the promise to the caller.
  if (ts.isArrowFunction(parent) && parent.body === call) return true;
  // `Promise.all([...])` and friends.
  if (ts.isArrayLiteralExpression(parent)) return true;
  // `.then(...)` / `.catch(...)` / `.finally(...)`
  if (ts.isPropertyAccessExpression(parent) && ['then', 'catch', 'finally'].includes(parent.name.text)) return true;
  return false;
}

interface Offender {
  resource: string;
  line: number;
  name: string;
  module: string;
}

function scan(): { offenders: Offender[]; resourcesWithImports: number; resolvableImports: number } {
  const offenders: Offender[] = [];
  let resourcesWithImports = 0;
  let resolvableImports = 0;

  for (const resource of resourceFiles()) {
    const sf = parse(resource);
    /** imported identifier → the src module it resolves to, for async ones only. */
    const asyncImports = new Map<string, string>();
    let resolvedHere = 0;

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const target = resolveAsInstalled(stmt.moduleSpecifier.text);
      if (!target) continue;
      resolvedHere++;
      const bindings = stmt.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const asyncNames = asyncExportNames(target);
      for (const el of bindings.elements) {
        const exported = (el.propertyName ?? el.name).text;
        if (asyncNames.has(exported)) {
          asyncImports.set(el.name.text, path.relative(REPO_ROOT, target).split(path.sep).join('/'));
        }
      }
    }

    resolvableImports += resolvedHere;
    if (resolvedHere > 0) resourcesWithImports++;
    if (asyncImports.size === 0) continue;

    const rel = path.relative(REPO_ROOT, resource).split(path.sep).join('/');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const module = asyncImports.get(name);
        if (module && !isConsumed(node)) {
          offenders.push({
            resource: rel,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            name,
            module,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { offenders, resourcesWithImports, resolvableImports };
}

describe('skill resources await the async src exports they import', () => {
  it('is not scanning an empty tree', () => {
    // Without this, deleting the skills directory — or breaking the install-path
    // resolution — would make the assertion below pass while checking nothing.
    const { resourcesWithImports, resolvableImports } = scan();
    expect(resourcesWithImports, 'no skill resource imports anything resolvable under src/').toBeGreaterThanOrEqual(1);
    expect(resolvableImports, 'no relative import resolved to a real src/ module').toBeGreaterThanOrEqual(1);
  });

  it('calls no async src export without consuming its promise', () => {
    const { offenders } = scan();
    expect(
      offenders.map((o) => `${o.resource}:${o.line} bare call to async ${o.name} (from ${o.module})`),
      'a skill resource calls an async src/ export without awaiting it. The resource is copied into src/ at ' +
        'install time and runs in production there, but no tsconfig and no lint glob covers it — this test is ' +
        'the only gate. Await the call (or Promise.all it).',
    ).toEqual([]);
  });
});
