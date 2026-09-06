/**
 * The PR 3 gate for the requestWake seam (T0, docs/specs/upstream-theme-ports/plan.md
 * §4.2, §5 cases 6-7).
 *
 * Pre-written on T0 PR 2's branch, ahead of PR 3's conversions, per the lead's
 * instruction (2026-09-05): this file MUST fail today, naming the current
 * offenders, and go green only once every fork-only call site in PR 3 is
 * converted to `requestWake`. It is a fail-on-revert gate as much as a
 * completion gate — if a future change reintroduces a direct `wakeContainer`
 * import anywhere outside `src/request-wake.ts`, this is what catches it.
 *
 * Two things are asserted, resolved with the TypeScript AST rather than by
 * text search — matching src/db/transaction-closures.test.ts's convention —
 * because a text-based check would miss the one dynamic-import call site
 * (`src/modules/repository-workspaces/index.ts:719`,
 * `const { wakeContainer } = await import('../../container-runner.js')`),
 * and would also need to distinguish `wakeContainer` (the binding we care
 * about) from every other name `container-runner.js` exports:
 *
 *   1. `wakeContainer` is imported — statically or dynamically — ONLY by
 *      `src/request-wake.ts`. `container-runner.ts` itself calls the function
 *      it declares; that is not an import and is excluded from the scan.
 *      Test files are excluded from the restriction (52 of them mock or
 *      assert on `wakeContainer` directly, by design — see
 *      `docs/specs/upstream-theme-ports/plan.md` T0 risk #4) but are still
 *      scanned, so a resolver that stopped seeing real matches would show it
 *      by losing the sanity-check import in case 1 below, not by silently
 *      shrinking the offender list.
 *   2. `src/modules/interactive/index.ts` imports neither `wakeContainer` nor
 *      `requestWake` — pinning the deliberate absence of a wake on the
 *      ask-user-question response path (see the comment in that file, and
 *      T0 scope report §3.7): a trigger-1 row there re-woke a dead session
 *      every sweep for 24h, holding a memory-budget slot the whole time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const CONTAINER_RUNNER_PATH = path.join(SRC_ROOT, 'container-runner.ts');
const REQUEST_WAKE_PATH = path.join(SRC_ROOT, 'request-wake.ts');

/** The only file allowed to import `wakeContainer` (plan §4.2, PR 3). */
const ALLOWED_WAKE_CONTAINER_IMPORTER = 'src/request-wake.ts';

function toRel(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

function isTestOrFixtureFile(rel: string): boolean {
  return rel.endsWith('.test.ts') || rel.includes('/transaction-fixtures/');
}

/** Every .ts file under src/, excluding node_modules/dist and dotfiles. */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

/**
 * Resolve a relative import specifier (e.g. '../../container-runner.js', as
 * written under this repo's NodeNext module resolution) to an absolute .ts
 * path. Returns null for a bare/package specifier — nothing this gate cares
 * about is imported from a package.
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  let resolved = path.resolve(path.dirname(fromFile), specifier);
  if (resolved.endsWith('.js')) resolved = `${resolved.slice(0, -3)}.ts`;
  else if (!resolved.endsWith('.ts')) resolved = `${resolved}.ts`;
  return resolved;
}

function bindingNameText(node: ts.PropertyName | ts.BindingName | undefined): string | null {
  return node && ts.isIdentifier(node) ? node.text : null;
}

interface Importer {
  file: string;
  line: number;
  form: 'static' | 'dynamic' | 'namespace' | 'dynamic-namespace';
}

/**
 * Every file that imports `bindingName` from the module at `targetPath`,
 * whether through a static `import { bindingName } from '...'` or a dynamic
 * `const { bindingName } = await import('...')`. `targetPath` itself is
 * skipped — declaring and using a name is not importing it.
 */
function findImportersOf(files: string[], targetPath: string, bindingName: string): Importer[] {
  const results: Importer[] = [];
  for (const file of files) {
    if (path.resolve(file) === targetPath) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(bindingName)) continue; // cheap prefilter before parsing
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = toRel(file);
    const lineOf = (node: ts.Node): number =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    const visit = (node: ts.Node): void => {
      // Static: import { bindingName } from '<specifier>'; (handles aliasing
      // via propertyName, e.g. `import { bindingName as x }`).
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
        const resolved = resolveRelativeSpecifier(file, node.moduleSpecifier.text);
        const namedBindings = node.importClause.namedBindings;
        if (resolved === targetPath && namedBindings && ts.isNamedImports(namedBindings)) {
          const hit = namedBindings.elements.some((el) => bindingNameText(el.propertyName ?? el.name) === bindingName);
          if (hit) results.push({ file: rel, line: lineOf(node), form: 'static' });
        }
        // Namespace: import * as runner from '<specifier>'; runner.bindingName(...).
        // Flagged conservatively: the binding is reachable through the
        // namespace, and the cheap prefilter above already proved the file
        // mentions the name, so treating the import itself as the caller is
        // the fail-closed reading (Codex on #470).
        if (resolved === targetPath && namedBindings && ts.isNamespaceImport(namedBindings)) {
          results.push({ file: rel, line: lineOf(node), form: 'namespace' });
        }
      }
      // Dynamic: const { bindingName } = await import('<specifier>');
      // `ts.isImportCall` is not part of the public typings (present at
      // runtime, absent from typescript.d.ts), so the shape is checked
      // directly: a CallExpression whose callee is the `import` keyword.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const resolved = resolveRelativeSpecifier(file, arg.text);
          if (resolved === targetPath) {
            let parent: ts.Node = node.parent;
            if (ts.isAwaitExpression(parent)) parent = parent.parent;
            if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
              const hit = parent.name.elements.some(
                (el) => bindingNameText(el.propertyName ?? el.name) === bindingName,
              );
              if (hit) results.push({ file: rel, line: lineOf(node), form: 'dynamic' });
            } else {
              // Any other consumer of the module namespace — `const m = await
              // import(...)`, `(await import(...)).bindingName`, `.then(m => ...)` —
              // is flagged conservatively for the same reason as the static
              // namespace import: the file mentions the name and holds the
              // whole module.
              results.push({ file: rel, line: lineOf(node), form: 'dynamic-namespace' });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return results;
}

describe('the resolver flags every import shape that can reach the binding (not vacuous)', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-chokepoint-'));
  const target = path.join(fixtureDir, 'target.ts');
  fs.writeFileSync(target, 'export function wakeContainer(): void {}\n');
  const cases: Array<[string, string, Importer['form']]> = [
    ['named.ts', "import { wakeContainer } from './target.js';\nwakeContainer();\n", 'static'],
    ['aliased.ts', "import { wakeContainer as w } from './target.js';\nw();\n", 'static'],
    ['namespace.ts', "import * as runner from './target.js';\nrunner.wakeContainer();\n", 'namespace'],
    ['dynamic.ts', "const { wakeContainer } = await import('./target.js');\nwakeContainer();\n", 'dynamic'],
    ['dynamic-ns.ts', "const m = await import('./target.js');\nm.wakeContainer();\n", 'dynamic-namespace'],
    ['dynamic-member.ts', "(await import('./target.js')).wakeContainer();\n", 'dynamic-namespace'],
  ];
  for (const [name, source] of cases) fs.writeFileSync(path.join(fixtureDir, name), source);
  const found = findImportersOf(
    cases.map(([name]) => path.join(fixtureDir, name)),
    path.resolve(target),
    'wakeContainer',
  );

  it.each(cases)('%s is reported as %s', (name, _source, form) => {
    const hit = found.find((i) => path.basename(i.file) === name);
    expect(hit?.form, `${name} bypassed the resolver`).toBe(form);
  });

  it('does not flag a file that imports something else from the module', () => {
    const other = path.join(fixtureDir, 'other.ts');
    fs.writeFileSync(other, "import { somethingElse } from './target.js';\nsomethingElse();\n");
    expect(findImportersOf([other], path.resolve(target), 'wakeContainer')).toEqual([]);
  });
});

describe('wakeContainer has exactly one importer', () => {
  const files = allSourceFiles();
  const importers = findImportersOf(files, CONTAINER_RUNNER_PATH, 'wakeContainer');

  it('finds the one importer it is supposed to allow, so the resolver is not vacuous', () => {
    expect(importers.map((i) => i.file)).toContain(ALLOWED_WAKE_CONTAINER_IMPORTER);
  });

  it('is imported, statically or dynamically, only by src/request-wake.ts', () => {
    const offenders = importers
      .filter((i) => !isTestOrFixtureFile(i.file))
      .filter((i) => i.file !== ALLOWED_WAKE_CONTAINER_IMPORTER)
      .map((i) => `${i.file}:${i.line} (${i.form})`);
    expect(
      offenders,
      'wakeContainer must be imported ONLY by src/request-wake.ts. Every other production call site ' +
        'should go through requestWake() instead — see docs/specs/upstream-theme-ports/plan.md T0 §4.2 ' +
        '(PR 3). This includes the dynamic import() form: static text search alone would have missed ' +
        'src/modules/repository-workspaces/index.ts.',
    ).toEqual([]);
  });
});

describe('the interactive question response still does not wake', () => {
  const interactiveFile = path.join(SRC_ROOT, 'modules', 'interactive', 'index.ts');

  it('imports neither wakeContainer nor requestWake', () => {
    const wakeContainerHits = findImportersOf([interactiveFile], CONTAINER_RUNNER_PATH, 'wakeContainer');
    const requestWakeHits = findImportersOf([interactiveFile], REQUEST_WAKE_PATH, 'requestWake');
    expect(
      [...wakeContainerHits, ...requestWakeHits],
      'src/modules/interactive/index.ts must not wake the container on an ask-user-question response — ' +
        'a trigger-1 row there re-woke a dead session every sweep for 24h, holding a memory-budget slot ' +
        'the whole time (see the comment in that file, and T0 scope report §3.7). The live poller reads ' +
        'pending rows directly; no wake is needed.',
    ).toEqual([]);
  });
});
