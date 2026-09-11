/**
 * Issue #300: eight standalone scripts flagged as import-graph reachable to
 * the mailbox seam (they transitively `import` a file that reaches
 * `getAgentMailbox`/`withMailboxSession`/`withExistingMailboxSession`) with no
 * `src/mailbox/compose.ts` import — the same shape of finding that PR 7 round
 * 2 found real in `scripts/migrate-workgroup-memory.ts` (fixed in b53a6519).
 *
 * Import-graph reachability is not execution (that's exactly the trap
 * b53a6519's own commit message names: "Bolting compose.js onto eight
 * operational entrypoints to satisfy a static over-approximation is the
 * fix-induced-defect pattern, not safety"). This file traces each of the
 * eight scripts' ACTUAL call graph — which specific bindings they import, and
 * whether those specific bindings ever reach the seam — and proves the
 * negative at runtime rather than by static text-matching alone:
 *
 *   1. Every leaf function these scripts (transitively) call is invoked here
 *      with the mailbox factory deliberately unregistered
 *      (`resetAgentMailboxForTesting`). None of them throw the seam's
 *      signature error, `No agent mailbox registered`.
 *   2. A negative control (below) proves that error DOES fire when the seam
 *      is actually reached in the same unregistered state — so a script that
 *      really did reach the seam would fail loudly here, not pass silently.
 *   3. Source-level assertions pin the exact set of `session-manager.js` /
 *      `storage-manager.ts` / `storage-activity.ts` / `worktree-cleanup.ts` /
 *      `container-runner.ts` bindings each script's import graph touches, so
 *      a future refactor that adds a new import re-triggers this review
 *      instead of silently drifting into reachability.
 *
 * Two of the eight (`init-cli-agent.ts`, `init-first-agent.ts`) and
 * `refresh-backlog-canvas.ts` have NO relative-import path (even
 * over-approximated) into `session-manager.ts`, `container-runner.ts`,
 * `delivery.ts`, or `mailbox/index.ts` at all — verified below by walking
 * their import graphs directly rather than asserting an absence by hand.
 *
 * `migrate-repo-store.ts` and `verify-workgroup-memory-runtime.ts` import
 * `session-manager.ts` for non-seam helpers only.
 * `reclaim-idle-thread-worktrees.ts` and `restore-session-mtimes.ts` reach it
 * only through `storage-manager.ts` / `storage-activity.ts`, which contain NO
 * seam call themselves (asserted below) and only re-export the same
 * non-seam `session-manager.js` helpers. `storage-gc.ts` reaches it only
 * through `worktree-cleanup.ts`, which likewise contains no seam call and
 * only imports the two trivial, seam-free `container-runner.ts` getters
 * (`isContainerRunning`, `isContainerSpawning` — Map/Set lookups, not spawn
 * logic) plus the same non-seam `session-manager.js` helpers.
 *
 * None of the eight import `initSessionFolder`, `resolveSession`,
 * `resolveTaskSession`, `withMailboxSession`, `withExistingMailboxSession`,
 * or `destroySessionMailbox` — the only `session-manager.ts` exports whose
 * own body calls the seam. No compose.ts import is needed for any of them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';

import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import {
  isAdmissiblePreTurnTrigger,
  readThreadDirOwner,
  sessionContextPathFor,
  sessionsBaseDir,
  threadsBaseDir,
  threadWorktreeDir,
} from './session-manager.js';
import { isContainerRunning, isContainerSpawning } from './container-runner.js';
import { tryRunWithStorageCleanupClaim } from './storage-activity.js';
import { sessionHasOpenWork } from './storage-manager.js';
import { getAgentMailbox, registerAgentMailbox, resetAgentMailboxForTesting } from './mailbox/index.js';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Every non-test `.ts` file under `root` (a repo-root-relative directory,
 * e.g. `src`), as REPO_ROOT-relative paths. Shared by the SEAM_ADJACENT_MODULES
 * scan below and the transitive import-graph walk further down this file —
 * hoisted here rather than defined twice.
 */
function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(REPO_ROOT, root));
  return out;
}

/**
 * The literal specifier text of a static or dynamic import/export target, or
 * `null` if it isn't a literal at all (a computed dynamic-import specifier
 * is a real edge these walkers can't resolve statically — same "no path
 * found" gap the transitive TARGETS walk further down has for computed
 * specifiers). A static import's specifier is grammatically always a
 * `StringLiteral` (`import x from \`./y\`` isn't valid syntax), but a
 * dynamic `import(...)` accepts a backtick template with no substitutions
 * too (`import(\`./mailbox/index.js\`)`) — same accessor for both, shared by
 * `collectModuleBindings` and `discoverRelativeModules` below, so neither
 * can drift out of sync with the other.
 */
function literalSpecifierText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Throws `"<kind> in a manifest-pinned file: <file>:<line>"` (plus a
 * trailing ` <detail>` when given), naming the exact line `node` starts on
 * in `sourceFile`. Shared by `collectModuleBindings` and
 * `discoverRelativeModules` so a specifier or clause shape either can't
 * statically resolve is a loud failure, not a silently dropped edge — the
 * manifest's completeness guarantee is that every edge is either pinned or
 * rejected, never skipped.
 */
function failClosed(sourceFile: ts.SourceFile, filePath: string, kind: string, node: ts.Node, detail = ''): never {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const suffix = detail ? ` ${detail}` : '';
  throw new Error(`${kind} in a manifest-pinned file: ${filePath}:${line + 1}${suffix}`);
}

/**
 * Every file path a relative specifier `specifierText`, written inside a
 * file whose directory is `fileDir`, could resolve to under Node's
 * ESM/NodeNext extension-mapping rules: `.js` -> `.ts`/`.tsx` (TypeScript
 * compiles either to a `.js` of the same base name, so a `.js` specifier is
 * ambiguous between them), `.mjs` -> `.mts`, `.cjs` -> `.cts`, and an
 * extensionless specifier -> the same four extensions plus `/index.*` under
 * each (a directory import). Pure path arithmetic — does not touch the
 * filesystem, and does not itself decide relative-vs-package; callers
 * already filter to specifiers starting with `.` before calling this.
 *
 * Shared by `discoverRelativeModules` (which existence-checks each
 * candidate and fails closed if none exists on disk) and
 * `collectModuleBindings`'s `specifierMatchesTarget` (which checks whether
 * the target module it's already resolved to — an exact repo-relative path,
 * extension included — is ITSELF one of these candidates) — using one
 * function for both closes the gap where the two could resolve the same
 * specifier differently.
 *
 * The comparison at the call site MUST be exact-path equality, never
 * extension-stripped: a fix-induced bug in an earlier round stripped both
 * sides down to a bare extensionless base before comparing, so `./foo.js`
 * (whose only real candidates are `foo.ts`/`foo.tsx`) and `./foo.mjs`
 * (whose only real candidate is `foo.mts`) both stripped to the same
 * `foo` and matched EITHER target — `foo.ts` and `foo.mts` are two
 * distinct files with distinct binding sets, and stripping conflated them.
 */
function relativeResolutionCandidates(fileDir: string, specifierText: string): string[] {
  const joined = path.posix.normalize(path.posix.join(fileDir, specifierText));
  if (joined.endsWith('.js')) {
    const base = joined.slice(0, -'.js'.length);
    return [`${base}.ts`, `${base}.tsx`];
  }
  if (joined.endsWith('.mjs')) return [`${joined.slice(0, -'.mjs'.length)}.mts`];
  if (joined.endsWith('.cjs')) return [`${joined.slice(0, -'.cjs'.length)}.cts`];
  return [
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.mts`,
    `${joined}.cts`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.mts`,
    `${joined}/index.cts`,
  ];
}

/**
 * Every distinct binding `filePath` (repo-root-relative, e.g.
 * `src/storage-manager.ts`) declares against `modulePath` (same form, e.g.
 * `src/mailbox/index.ts`) — across ALL matching declarations in the file,
 * not just the first. Walks the real TypeScript AST (`ts.createSourceFile`,
 * the same `ts` import the transitive walk below uses for module
 * specifiers) rather than a text regex, so none of these evade detection:
 *
 *   - a SECOND `import { x } from '<module>'` declaration further down the
 *     file (a regex `.exec()` only ever finds the first)
 *   - `import { x as y } from '<module>'` — recorded as `x as y`, so an
 *     alias can't hide the real bound name
 *   - `import * as ns from '<module>'` — recorded as `*`
 *   - a bare default import — recorded as `default`
 *   - `export { x } from '<module>'` / `export * from '<module>'` /
 *     `export * as ns from '<module>'` re-exports (the last two both
 *     recorded as `*` — a namespace re-export exposes every export, same
 *     reachability as an unqualified `export *`)
 *   - `import('<module>')` anywhere in the file, not just at module top
 *     level (inside a function body, for instance) — recorded as `dynamic`
 *
 * `import type { … }` / `export type { … } from` declarations and per-specifier
 * `type` imports/exports are excluded — erased at compile time, no runtime
 * binding, so they cannot reach the seam.
 *
 * FAILS CLOSED (via the shared `failClosed`) on an import or export clause
 * shape this function doesn't recognize, rather than silently contributing
 * no bindings for it — the concrete bug this closed the: `export * as ns
 * from '<module>'` is a `NamespaceExport`, neither the `undefined`
 * `exportClause` case (`export * from`) nor a `NamedExports` case, and fell
 * through both existing branches with zero bindings recorded even though a
 * real re-export edge exists. Both fallbacks are structurally unreachable
 * via real TypeScript syntax today (an `ImportClause`'s `namedBindings` is
 * the closed union `NamespaceImport | NamedImports`, and an
 * `ExportDeclaration`'s `exportClause` is the closed union `NamespaceExport
 * | NamedExports` — both now fully handled); kept anyway as defense against
 * a future TypeScript syntax addition changing either union, verified by
 * temporarily stubbing an unrecognized clause value (see the test file's
 * verification notes) rather than by real syntax, since none currently
 * exists to construct one with.
 */
function collectModuleBindings(filePath: string, modulePath: string, root: string = REPO_ROOT): string[] {
  const src = fs.readFileSync(path.join(root, filePath), 'utf8');
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const fileDir = path.posix.dirname(filePath);

  // Exact-path equality against `modulePath` (an already-resolved,
  // extension-intact repo-relative path — see relativeResolutionCandidates's
  // doc comment for the fix-induced bug this replaced: extension-stripped
  // comparison conflated distinct files sharing a base name, e.g. foo.ts
  // and foo.mts).
  function specifierMatchesTarget(specifierText: string): boolean {
    if (!specifierText.startsWith('.')) return false; // package import — no repo-relative edge
    return relativeResolutionCandidates(fileDir, specifierText).includes(modulePath);
  }

  function namedElementText(el: ts.ImportSpecifier | ts.ExportSpecifier): string | null {
    if (el.isTypeOnly) return null;
    const original = (el.propertyName ?? el.name).text;
    return el.propertyName ? `${original} as ${el.name.text}` : original;
  }

  const bindings: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifierText = literalSpecifierText(node.moduleSpecifier);
      if (
        specifierText !== null &&
        specifierMatchesTarget(specifierText) &&
        // ImportClause.isTypeOnly is deprecated as of TypeScript 5.9 in favor
        // of phaseModifier (which also distinguishes `import defer`, a
        // different phase, not type-only — so type-only is specifically the
        // TypeKeyword case).
        node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
      ) {
        const clause = node.importClause;
        if (!clause) {
          bindings.push('(side-effect)'); // bare `import '<module>'`
        } else {
          if (clause.name) bindings.push('default');
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              bindings.push('*');
            } else if (ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                const text = namedElementText(el);
                if (text) bindings.push(text);
              }
            } else {
              failClosed(sourceFile, filePath, 'unrecognized import clause', node);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifierText = literalSpecifierText(node.moduleSpecifier);
      if (specifierText !== null && specifierMatchesTarget(specifierText) && !node.isTypeOnly) {
        if (!node.exportClause) {
          bindings.push('*'); // `export * from '<module>'`
        } else if (ts.isNamespaceExport(node.exportClause)) {
          bindings.push('*'); // `export * as ns from '<module>'` — exposes every export, same as `export *`
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const text = namedElementText(el);
            if (text) bindings.push(text);
          }
        } else {
          failClosed(sourceFile, filePath, 'unrecognized export clause', node);
        }
      }
    } else if (
      // `ts.isImportCall` exists at runtime but isn't in the public .d.ts, so
      // detect a dynamic `import(...)` call the same way the compiler's own
      // (unexported) implementation does: a CallExpression whose callee is
      // the bare `import` keyword.
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const specifierText = literalSpecifierText(node.arguments[0]);
      if (specifierText !== null && specifierMatchesTarget(specifierText)) bindings.push('dynamic');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

/**
 * Every module `filePath` (repo-root-relative) has a relative import,
 * export-from, or dynamic `import()` edge to, resolved to a repo-root-relative
 * `.ts` path — with the same `/index.ts` directory-import fallback the
 * transitive TARGETS walk further down uses for its own specifier
 * resolution. This is edge DISCOVERY, not binding collection: it finds every
 * module the file touches at all, independent of what's bound against each
 * one (that's `collectModuleBindings`'s job, called once per discovered
 * module by `collectRelativeImportManifest` below).
 *
 * FAILS CLOSED rather than silently under-reporting: a `filePath` this
 * function is called on is, by construction, one of the two manifest-pinned
 * files (`collectRelativeImportManifest`'s only caller), so the manifest is
 * only complete-by-construction if every edge is either pinned OR rejected —
 * never silently dropped. Three edges this function cannot resolve
 * statically would otherwise vanish with no trace:
 *   - a COMPUTED dynamic import, `import(someExpression)` — the specifier
 *     isn't a string/no-substitution-template literal, so `resolveModule`
 *     has nothing to resolve. Throws instead of skipping.
 *   - ANY `require(...)` call at all, literal argument or not — host code is
 *     ESM (see this repo's CLAUDE.md "Module System (host)"); `require` is
 *     undefined at runtime there, so a call to it is either dead code that
 *     shouldn't exist or a real edge this manifest has no way to see. Either
 *     way, it must not pass silently.
 *   - a LITERAL relative specifier that doesn't resolve to any file on disk
 *     under `relativeResolutionCandidates`'s extension-mapping rules (an
 *     `.mjs`/`.cjs`/extensionless specifier this function previously only
 *     tried a `.js` -> `.ts` mapping for, or a genuine typo) — a specifier
 *     the module-discovery pass can't place anywhere is exactly the kind of
 *     edge that must force a human to look, not silently contribute nothing.
 * A throw here fails the pinning `it()` with a message naming the exact
 * file and line, which is the point: an edge the manifest can't literally
 * pin must force a human to look, not vanish.
 */
function discoverRelativeModules(filePath: string, root: string = REPO_ROOT): string[] {
  const src = fs.readFileSync(path.join(root, filePath), 'utf8');
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const fileDir = path.posix.dirname(filePath);
  const modules = new Set<string>();

  function resolveModule(specifierText: string, node: ts.Node): string | undefined {
    if (!specifierText.startsWith('.')) return undefined; // package import — no repo-relative edge
    for (const candidate of relativeResolutionCandidates(fileDir, specifierText)) {
      if (fs.existsSync(path.join(root, candidate))) return candidate;
    }
    failClosed(sourceFile, filePath, 'unresolvable relative import', node, specifierText);
  }

  // The five ts.SyntaxKind shapes this visitor treats as module edges — every
  // other node kind (a plain call, a type reference, a class, …) creates no
  // module-graph edge at all and falls through to the unconditional
  // ts.forEachChild(node, visit) recursion below, so this list IS the
  // coverage claim, not just a subset of it:
  //   - ImportDeclaration        `import ... from '<module>'`
  //   - ExportDeclaration        `export ... from '<module>'`
  //   - ImportKeyword call       dynamic `import('<module>')`
  //   - a CallExpression to the identifier `require`
  //   - ImportEqualsDeclaration  `import x = require('<module>')` /
  //                              `import x = SomeNamespace.Member` — see
  //                              below; TypeScript's own CommonJS-interop
  //                              form, never used in this repo's ESM host
  //                              code, so ANY occurrence fails closed
  //                              unconditionally rather than being parsed.
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifierText = literalSpecifierText(node.moduleSpecifier);
      if (specifierText !== null) {
        const resolved = resolveModule(specifierText, node);
        if (resolved) modules.add(resolved);
      }
      // A static import's specifier is grammatically always a literal — no
      // computed-specifier case exists here to fail closed on.
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifierText = literalSpecifierText(node.moduleSpecifier);
      if (specifierText !== null) {
        const resolved = resolveModule(specifierText, node);
        if (resolved) modules.add(resolved);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      const specifierText = arg ? literalSpecifierText(arg) : null;
      if (specifierText === null) failClosed(sourceFile, filePath, 'computed dynamic import', node);
      const resolved = resolveModule(specifierText, node);
      if (resolved) modules.add(resolved);
      // An unresolvable-but-LITERAL specifier that's a PACKAGE import (not
      // relative) is fine — resolveModule returns undefined for it without
      // failing closed, since package imports aren't part of this
      // repo-relative manifest at all.
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      failClosed(sourceFile, filePath, 'unexpected require() call', node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      // `import x = require('./m.js')` (CommonJS interop) or
      // `import x = SomeNamespace.Member` — either way a module-graph edge
      // (or an internal alias) this visitor doesn't parse, in code this
      // repo's ESM host (see CLAUDE.md "Module System (host)") and its own
      // `@typescript-eslint/no-require-imports` lint rule already ban. The
      // tripwire agrees with the lint rule rather than silently skipping.
      failClosed(sourceFile, filePath, 'import-equals declaration', node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...modules].sort();
}

/**
 * The COMPLETE relative-import manifest of `filePath`: every module it has
 * any edge to (`discoverRelativeModules`), mapped to the exact bindings
 * `collectModuleBindings` finds against it. Deliberately not limited to a
 * curated or derived "seam-adjacent" subset of modules — see the doc
 * comment on the pin tests below (`storage-manager.ts imports exactly this
 * relative-import manifest`, and worktree-cleanup.ts's counterpart) for why
 * these two specific files are pinned this way instead of walked like the
 * TARGETS scripts further down.
 */
function collectRelativeImportManifest(filePath: string, root: string = REPO_ROOT): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  for (const modulePath of discoverRelativeModules(filePath, root)) {
    manifest[modulePath] = collectModuleBindings(filePath, modulePath, root);
  }
  return manifest;
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mailbox-seam-unreachable-${name}-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

const NOT_REGISTERED = 'No agent mailbox registered';

/**
 * Run `fn` with the mailbox factory deliberately unregistered — the exact
 * condition a standalone `tsx` script is in, since none of the eight load
 * `src/mailbox/compose.ts`. `src/test-setup.ts` registers the real factory
 * before every test; this suspends that registration for the duration of
 * `fn` and restores it afterward so later tests in this file (and the
 * process, since ESM module state is per-file here) are unaffected.
 */
async function withNoMailboxRegistered<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = resetAgentMailboxForTesting();
  try {
    return await fn();
  } finally {
    if (previous) registerAgentMailbox(previous);
  }
}

/** Call `fn` and, if it throws, assert the throw is not the seam's signature error. */
function callNeverReachingSeam(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    expect((err as Error).message).not.toBe(NOT_REGISTERED);
  }
}

describe('collectModuleBindings — backtick dynamic import specifiers', () => {
  // Regression: `ts.isStringLiteral` alone misses a dynamic `import(...)`
  // written with a backtick template that has no substitutions
  // (`import(\`./mailbox/index.js\`)`) — a NoSubstitutionTemplateLiteral is a
  // distinct AST node kind from StringLiteral, and TypeScript accepts either
  // as a dynamic-import specifier. A destructured alias on the awaited
  // result (the realistic shape this would appear in) exercises that the
  // walker still recurses into the surrounding variable declaration to find
  // the call expression.
  it('a backtick dynamic import with a destructured alias is still recorded as `dynamic`', () => {
    const dir = tmpDir('backtick-dynamic-import');
    fs.writeFileSync(
      path.join(dir, 'entry.ts'),
      [
        'export async function evade() {',
        '  const { getAgentMailbox: alias } = await import(`./mailbox/index.js`);',
        '  return alias;',
        '}',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(dir, 'mailbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mailbox/index.ts'), 'export function getAgentMailbox() {}\n');

    expect(collectModuleBindings('entry.ts', 'mailbox/index.ts', dir)).toEqual(['dynamic']);
  });

  it('the equivalent plain-string dynamic import is recorded identically, proving the two forms share one code path', () => {
    const dir = tmpDir('string-dynamic-import');
    fs.writeFileSync(
      path.join(dir, 'entry.ts'),
      [
        'export async function evade() {',
        "  const { getAgentMailbox: alias } = await import('./mailbox/index.js');",
        '  return alias;',
        '}',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(dir, 'mailbox'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mailbox/index.ts'), 'export function getAgentMailbox() {}\n');

    expect(collectModuleBindings('entry.ts', 'mailbox/index.ts', dir)).toEqual(['dynamic']);
  });
});

describe('discoverRelativeModules — NodeNext extension mapping and fail-closed resolution', () => {
  // Codex on df6cf622: resolveModule only ever tried `.js` -> `.ts`, so a
  // relative specifier ending `.mjs`/`.cjs` — or any other unresolvable
  // relative specifier — silently resolved to nothing and the edge vanished
  // from the manifest with no trace. Exercised here against synthetic
  // fixtures (discoverRelativeModules's new `root` parameter) rather than
  // by editing a real pinned file directly: storage-manager.ts is ALSO
  // really `import`-ed by this test file itself (for `sessionHasOpenWork`),
  // so a genuinely unresolvable specifier added there crashes the whole
  // suite's module load — a real, even louder failure, but one that never
  // reaches this function's own code path to prove its exact message.

  it('resolves a `.mjs` specifier to its `.mts` source', () => {
    const dir = tmpDir('nodenext-mjs');
    fs.writeFileSync(dir + '/entry.ts', "import { x } from './helper.mjs';\n");
    fs.writeFileSync(dir + '/helper.mts', 'export const x = 1;\n');

    expect(discoverRelativeModules('entry.ts', dir)).toEqual(['helper.mts']);
  });

  it('resolves a `.cjs` specifier to its `.cts` source', () => {
    const dir = tmpDir('nodenext-cjs');
    fs.writeFileSync(dir + '/entry.ts', "import { x } from './helper.cjs';\n");
    fs.writeFileSync(dir + '/helper.cts', 'export const x = 1;\n');

    expect(discoverRelativeModules('entry.ts', dir)).toEqual(['helper.cts']);
  });

  it('resolves an extensionless specifier to a directory `/index.ts`', () => {
    const dir = tmpDir('nodenext-extensionless-index');
    fs.writeFileSync(dir + '/entry.ts', "import { x } from './helper';\n");
    fs.mkdirSync(dir + '/helper', { recursive: true });
    fs.writeFileSync(dir + '/helper/index.ts', 'export const x = 1;\n');

    expect(discoverRelativeModules('entry.ts', dir)).toEqual(['helper/index.ts']);
  });

  it('fails closed with an exact file:line and the offending specifier when a relative import cannot be resolved at all', () => {
    const dir = tmpDir('nodenext-unresolvable');
    fs.writeFileSync(dir + '/entry.ts', ["import fs from 'node:fs';", "import './nope.mjs';", ''].join('\n'));

    expect(() => discoverRelativeModules('entry.ts', dir)).toThrow(
      'unresolvable relative import in a manifest-pinned file: entry.ts:2 ./nope.mjs',
    );
  });

  // Codex on 74f344d0: `import x = require('./m.js')` — an
  // ImportEqualsDeclaration, TypeScript's own CommonJS-interop import form —
  // is a node kind this visitor never checked for at all, so it fell
  // straight through to the unconditional forEachChild recursion with no
  // edge recorded and no failure, even though it's an unconditional ban
  // under this repo's `@typescript-eslint/no-require-imports` (host code is
  // ESM). Fails closed unconditionally now, without even inspecting the
  // module reference.
  it('fails closed on any import-equals declaration, unconditionally', () => {
    const dir = tmpDir('nodenext-import-equals');
    fs.writeFileSync(dir + '/entry.ts', ["import m = require('./helper.js');", 'void m;', ''].join('\n'));
    fs.writeFileSync(dir + '/helper.ts', 'export const x = 1;\n');

    expect(() => discoverRelativeModules('entry.ts', dir)).toThrow(
      'import-equals declaration in a manifest-pinned file: entry.ts:1',
    );
  });

  // Codex on d91bc418: this round's own fix — comparing extension-stripped
  // candidates instead of exact resolved paths — was itself fix-induced.
  // `./foo.js`'s only real candidates are `foo.ts`/`foo.tsx`; `./foo.mjs`'s
  // only real candidate is `foo.mts`. Stripped to a bare `foo`, both
  // specifiers' candidates matched EITHER target, so foo.ts and foo.mts —
  // two distinct files with distinct binding sets — got merged into one
  // manifest entry, and swapping which specifier pointed at which file left
  // the manifest unchanged.
  it('two distinct same-basename modules (`foo.ts` and `foo.mts`) get two distinct manifest entries, and swapping the specifiers changes the manifest', () => {
    const dir = tmpDir('nodenext-same-basename-distinct-extensions');
    fs.writeFileSync(dir + '/foo.ts', 'export const a = 1;\nexport const b = 1;\n');
    fs.writeFileSync(dir + '/foo.mts', 'export const a = 2;\nexport const b = 2;\n');

    fs.writeFileSync(
      dir + '/entry.ts',
      ["import { a } from './foo.js';", "import { b } from './foo.mjs';", ''].join('\n'),
    );
    expect(collectRelativeImportManifest('entry.ts', dir)).toEqual({ 'foo.ts': ['a'], 'foo.mts': ['b'] });

    // Swap which specifier points at which name — `.js` now binds `b`,
    // `.mjs` now binds `a`. A stripped-comparison bug conflates `foo.ts` and
    // `foo.mts` (both strip to `foo`), so the swap would leave the manifest
    // identical to the one above; the fix must not.
    fs.writeFileSync(
      dir + '/entry.ts',
      ["import { b } from './foo.js';", "import { a } from './foo.mjs';", ''].join('\n'),
    );
    expect(collectRelativeImportManifest('entry.ts', dir)).toEqual({ 'foo.ts': ['b'], 'foo.mts': ['a'] });
  });
});

describe('negative control: the harness actually detects a real seam hit', () => {
  it('getAgentMailbox() throws "No agent mailbox registered" when the factory is unregistered', async () => {
    await withNoMailboxRegistered(() => {
      expect(() => getAgentMailbox()).toThrow(NOT_REGISTERED);
    });
  });
});

describe('scripts/migrate-repo-store.ts — only imports readThreadDirOwner, threadWorktreeDir from session-manager.js', () => {
  it('neither function reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        readThreadDirOwner(tmpDir('read-thread-dir-owner'));
      });
      callNeverReachingSeam(() => {
        threadWorktreeDir('cli', 'thread-1', 'wg-1');
      });
    });
  });
});

describe('scripts/verify-workgroup-memory-runtime.ts', () => {
  it('isAdmissiblePreTurnTrigger (its only session-manager.js import) never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        isAdmissiblePreTurnTrigger({
          id: 'm1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: 'hello',
          trigger: 1,
        } as Parameters<typeof isAdmissiblePreTurnTrigger>[0]);
      });
    });
  });

  // It is NOT eligible for the "no relative-import path to the seam at
  // all" walk below (TARGETS) — it genuinely does reach
  // src/session-manager.ts (a SEAM_ADJACENT_FILES entry), just through a
  // non-seam binding. Adding it there would fail that walk's "zero path"
  // assertion for a correct reason (the path exists) while asserting the
  // wrong thing (the walk can't tell a non-seam binding from a seam one).
  // The right proof for this shape — same one used above for
  // isAdmissiblePreTurnTrigger, and for storage-manager.ts /
  // worktree-cleanup.ts below — is pinning the exact import set so a
  // future import drift re-triggers this review instead of silently
  // widening reachability.
  it('its only session-manager.js imports are isAdmissiblePreTurnTrigger, pinned so a future import here re-triggers this review', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/verify-workgroup-memory-runtime.ts'), 'utf8');
    const match = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/src\/session-manager\.js['"]/.exec(src);
    expect(
      match,
      'verify-workgroup-memory-runtime.ts must import from ../src/session-manager.js for this test to be meaningful',
    ).not.toBeNull();
    const names = match![1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['isAdmissiblePreTurnTrigger'].sort());
  });

  // The module-load side of this script — does importing
  // scripts/migrate-workgroup-memory.ts (for parseMigrationReport) run its
  // CLI body, and is the verifier module itself (verify-workgroup-memory-
  // runtime.ts) safe to import bare — is covered in
  // scripts/mailbox-seam-unreachable.test.ts. This file's tsconfig rootDir
  // is src/, so it cannot import a scripts/ module.
});

describe('storage-manager.ts / storage-activity.ts contain no literal seam call', () => {
  it('storage-manager.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-manager.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  it('storage-activity.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/storage-activity.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  // Three rounds of Codex review on this file progressively widened a
  // curated "seam-adjacent modules" set — first hand-listed, then derived
  // from which files bind the seam factory's names directly — and each
  // widening still missed a real gap: a file that reaches the seam only
  // through a SECOND hop (storage-manager.ts -> some helper -> a file that
  // itself binds getAgentMailbox) escapes any one-level "does this file
  // bind the factory" classification, however the set of candidate files is
  // chosen.
  //
  // The fix is to stop classifying modules at all. storage-manager.ts and
  // worktree-cleanup.ts are the two files EXEMPT from the transitive
  // TARGETS walk further down (they legitimately import real seam-adjacent
  // helpers, so "zero path to the seam" is the wrong invariant for them).
  // For exactly these two, pin the COMPLETE relative-import manifest
  // instead: every module either file has ANY edge to, each mapped to its
  // exact binding set. This is complete by construction — there is no set
  // of modules to keep in sync, because the set IS "every module this file
  // imports from." A brand-new import to ANY module, first-hop or
  // otherwise, changes the manifest and fails this assertion. What it does
  // NOT do is prove no import here transitively reaches the seam two or
  // more hops away — that residual risk is exactly what the TARGETS walk
  // covers for the scripts, and for these two files, review. That is the
  // honest boundary this test draws, not a gap it hides.
  it('storage-manager.ts imports exactly this complete relative-import manifest', () => {
    expect(collectRelativeImportManifest('src/storage-manager.ts')).toEqual({
      'src/config.ts': ['CONTAINER_IMAGE', 'CONTAINER_IMAGE_BASE', 'CONTAINER_INSTALL_LABEL', 'DATA_DIR'],
      'src/container-mounts.ts': ['runningContainerMounts as inspectRunningContainerMounts'],
      'src/container-runtime.ts': ['CONTAINER_RUNTIME_BIN'],
      // Seam 3 PR 6: the host-side boot finisher takes the central lease; the
      // `type RawStatements` specifier is inline type-only and contributes no
      // runtime binding.
      'src/db/central-lease.ts': ['withCentralSync', 'withRawDb'],
      'src/db/connection.ts': ['getRawDb'],
      // Seam 3 PR 4 moved this off the async driver's getAllContainerConfigs
      // to a raw, synchronous prepare — see the doc comment at the call site
      // (storage-manager.ts's configuredImageProtection) for why: this runs
      // inside the storage maintenance worker thread and the synchronous
      // reclaim executors, neither of which can await the async driver.
      'src/db/container-configs.ts': ['CONTAINER_CONFIGS_ALL_SQL'],
      // The npm dependency cache (docs/specs/repository-branch-clones/plan.md
      // §5.7). dependency-cache.ts's own relative imports are config.ts,
      // container-runtime.ts and log.ts, all three already pinned in this
      // manifest, so this edge reaches no module — and so no path to the
      // mailbox seam — that storage-manager.ts did not already reach. Its
      // `type` specifiers contribute no runtime binding.
      'src/dependency-cache.ts': [
        'collectCacheGarbage',
        'DEPENDENCY_CACHE_DIRNAME',
        'DEPENDENCY_CACHE_TEMP_NAMES',
        'finishDependencyCachePass',
        'hasPendingConversion',
        'isEligiblePackageDir',
        'isFarmPackageDir',
        'processPackageDir',
        'recoverPackageDir',
        'startDependencyCachePass',
      ],
      'src/log.ts': ['log'],
      'src/modules/mailbox/index.ts': ['sessionMailboxPath'],
      'src/repository-workspaces.ts': ['listTopicCheckouts', 'resolveRepositoryWorkUnit'],
      'src/session-manager.ts': ['sessionContextPathFor', 'sessionsBaseDir', 'threadsBaseDir', 'threadWorktreeDir'],
      'src/storage-activity.ts': ['STORAGE_INTERNAL_ENTRY_NAMES', 'tryRunWithStorageCleanupClaim'],
      // `import type { ContainerConfigRow }` — a whole-clause type-only
      // import, erased at compile time. discoverRelativeModules still
      // records the module-graph edge (it doesn't distinguish type-only
      // imports), but collectModuleBindings correctly excludes it from the
      // binding list, so this file contributes no runtime binding — never a
      // path to the mailbox seam.
      'src/types.ts': [],
    });
  });
});

describe('scripts/reclaim-idle-thread-worktrees.ts — only imports getStorageReport from storage-manager.ts', () => {
  it("storage-manager.ts's session-manager.js re-imports never reach the mailbox seam", async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('reclaim');
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => outboundDbPath('ag1', 's1'));
      callNeverReachingSeam(() => sessionContextPathFor(dir));
      callNeverReachingSeam(() => sessionsBaseDir());
      callNeverReachingSeam(() => threadsBaseDir());
      callNeverReachingSeam(() => threadWorktreeDir('cli', 'thread-1', 'wg-1'));
    });
  });
});

describe('scripts/restore-session-mtimes.ts — imports tryRunWithStorageCleanupClaim (storage-activity.ts) and sessionHasOpenWork (storage-manager.ts)', () => {
  it('tryRunWithStorageCleanupClaim never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('cleanup-claim');
      let ran = false;
      callNeverReachingSeam(() => {
        const claimed = tryRunWithStorageCleanupClaim(dir, () => {
          ran = true;
        });
        expect(claimed).toBe(true);
      });
      expect(ran).toBe(true);
    });
  });

  it('sessionHasOpenWork never reaches the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      const dir = tmpDir('open-work');
      callNeverReachingSeam(() => {
        sessionHasOpenWork('ag1', 's1', dir);
      });
    });
  });
});

describe('worktree-cleanup.ts contains no literal seam call, and the only container-runner.ts bindings storage-gc.ts pulls in are trivial getters', () => {
  it('worktree-cleanup.ts never calls getAgentMailbox/withMailboxSession/withExistingMailboxSession', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/worktree-cleanup.ts'), 'utf8');
    expect(/\b(getAgentMailbox|withMailboxSession|withExistingMailboxSession)\s*\(/.test(src)).toBe(false);
  });

  // See the doc comment on storage-manager.ts's manifest pin above for why
  // these two specific files (the ones exempt from the TARGETS transitive
  // walk further down) are pinned as a COMPLETE relative-import manifest
  // rather than walked or classified against a curated module set.
  it('worktree-cleanup.ts imports exactly this complete relative-import manifest', () => {
    expect(collectRelativeImportManifest('src/worktree-cleanup.ts')).toEqual({
      'src/config.ts': ['DATA_DIR', 'GROUPS_DIR'],
      'src/container-mounts.ts': ['runningContainerMounts'],
      'src/container-runner.ts': ['isContainerRunning', 'isContainerSpawning'],
      // Seam 3 PR 6 (#460 round 4): the session inventory reads through the
      // central lease — this module runs on the host from the onHostStart
      // timer, so its raw SELECT can no longer land in a suspended transaction.
      'src/db/central-lease.ts': ['withCentralSync', 'withRawDb'],
      'src/host-lifecycle.ts': ['onHostShutdown', 'onHostStart'],
      'src/log.ts': ['log'],
      // PR 7 moved this file's outbound read onto the seam, and the manifest
      // is how you can see it: the raw opener and the three op modules it
      // reached into directly are gone, replaced by one funnel import from the
      // barrel. Four entries out, one binding in — a strictly smaller surface,
      // which is what this pin exists to make visible rather than to forbid.
      'src/modules/mailbox/index.ts': ['readSessionOutbound', 'sessionMailboxPath'],
      'src/repository-workspaces.ts': [
        'canonicalRepoDir',
        'checkoutInheritedTagsPath',
        'defaultTopicBranch',
        'ensureRepositoryLock',
        'listTopicCheckouts',
        'parseCheckoutDirName',
        'readCheckoutInheritedTags',
        'resolveRepositoryWorkUnit',
        'topicStateDir',
        'topicWorktreesDir',
        'transferTombstonesDir',
        'withHostRepositoryLock',
        'withRepositoryLifecycleClaims',
      ],
      'src/safe-git.ts': ['safeGitArgs', 'safeGitEnv', 'safeGitFilterNames'],
      'src/storage-manager.ts': ['dirSizeBytes', 'sessionWasReclaimed'],
    });
  });
});

describe('scripts/storage-gc.ts — only imports runStorageGcOnce from worktree-cleanup.ts', () => {
  it('isContainerRunning and isContainerSpawning (Map/Set lookups, not spawn logic) never reach the mailbox seam', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => {
        expect(isContainerRunning('nonexistent-session')).toBe(false);
      });
      callNeverReachingSeam(() => {
        expect(isContainerSpawning('nonexistent-session')).toBe(false);
      });
    });
  });

  it('inboundDbPath never reaches the mailbox seam (openOutboundDb is exercised indirectly via sessionHasOpenWork above)', async () => {
    await withNoMailboxRegistered(() => {
      callNeverReachingSeam(() => inboundDbPath('ag1', 's1'));
    });
  });
});

describe('scripts/init-cli-agent.ts, scripts/init-first-agent.ts, scripts/refresh-backlog-canvas.ts have no relative-import path to the seam', () => {
  const STANDALONE_ROOTS = ['scripts'];
  const TARGETS = ['scripts/init-cli-agent.ts', 'scripts/init-first-agent.ts', 'scripts/refresh-backlog-canvas.ts'];
  const SEAM_ADJACENT_FILES = [
    'src/session-manager.ts',
    'src/container-runner.ts',
    'src/delivery.ts',
    'src/mailbox/index.ts',
  ];

  // listTsFiles is defined once, at module scope, above.

  const read = (relPath: string): string => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

  /**
   * `true` if the import/export statement enclosing source offset `pos`
   * (a position `ts.preProcessFile` reports somewhere inside that
   * statement's specifier) is a whole-statement `import type { … } from` or
   * `export type { … } from` — erased at compile time, no runtime edge. A
   * per-specifier `import { type X, Y } from` is NOT type-only (Y is a real
   * value import) and is intentionally not matched here, same as before.
   *
   * This is a cheap text check, not a parse: walk back to the nearest
   * preceding `;` (or start of file) — the statement terminator every
   * import/export in this codebase's prettier-formatted style carries — and
   * check what the statement starts with.
   */
  function isTypeOnlyStatement(src: string, pos: number): boolean {
    const prevSemicolon = src.lastIndexOf(';', pos);
    const statement = src.slice(prevSemicolon + 1, pos).trimStart();
    return /^import\s+type\b/.test(statement) || /^export\s+type\b/.test(statement);
  }

  /**
   * Relative import/export specifiers that create a runtime module-graph
   * edge — VALUE imports only; `import type` / `export type { … } from` are
   * erased at compile time and create no runtime edge. Uses TypeScript's own
   * scanner (`ts.preProcessFile`, an existing dependency) rather than a
   * lexical regex walk, which previously let a lazy pattern spanning
   * newlines swallow a bare side-effect import sitting between a
   * non-relative `from` clause and the next relative one (see the
   * "side-effect import" test below). `preProcessFile` reports every
   * specifier from static imports (including bare side-effect imports),
   * dynamic `import('./x.js')` with a string-literal specifier, and
   * `export … from` re-exports in one pass; type-only statements are
   * filtered out separately via `isTypeOnlyStatement` since
   * `preProcessFile` reports those too.
   */
  function relativeValueSpecifiers(src: string): string[] {
    const { importedFiles } = ts.preProcessFile(src, /* readImportFiles */ true, /* detectJavaScriptImports */ false);
    const specifiers = new Set<string>();
    for (const { fileName, pos } of importedFiles) {
      if (!fileName.startsWith('.')) continue; // package import — no repo-relative edge
      if (isTypeOnlyStatement(src, pos)) continue;
      specifiers.add(fileName);
    }
    return [...specifiers];
  }

  /** Resolve a relative specifier from `relPath` to a repo-root-relative .ts file path under `root`, if one exists. */
  function resolveSpecifier(relPath: string, specifier: string, root: string): string | undefined {
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(relPath), specifier))
      .replace(/\.js$/, '.ts');
    if (fs.existsSync(path.join(root, resolved))) return resolved;
    const idx = resolved.replace(/\.ts$/, '') + '/index.ts';
    if (fs.existsSync(path.join(root, idx))) return idx;
    return undefined;
  }

  function relativeValueImports(relPath: string, src: string, root: string = REPO_ROOT): string[] {
    const out: string[] = [];
    for (const specifier of relativeValueSpecifiers(src)) {
      const resolved = resolveSpecifier(relPath, specifier, root);
      if (resolved) out.push(resolved);
    }
    return out;
  }

  for (const target of TARGETS) {
    it(`${target} never value-imports (transitively) session-manager.ts, container-runner.ts, delivery.ts, or mailbox/index.ts`, () => {
      const allFiles = [...listTsFiles('src'), ...STANDALONE_ROOTS.flatMap(listTsFiles)];
      const sources = new Map(allFiles.map((p) => [p, read(p)]));
      const visited = new Set([target]);
      const queue = [target];
      while (queue.length) {
        const cur = queue.shift()!;
        const src = sources.get(cur);
        if (!src) continue;
        for (const dep of relativeValueImports(cur, src)) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }
      const hit = SEAM_ADJACENT_FILES.find((f) => visited.has(f));
      expect(hit, `${target} reaches ${hit} — this proof is stale, re-run the trace`).toBeUndefined();
    });
  }

  describe('relativeValueImports walker — dynamic import() and re-export edges', () => {
    it('resolves a dynamic import(), an `export * from`, and an `export { … } from` specifier, each to its target file', () => {
      const dir = tmpDir('walker-edges');
      fs.writeFileSync(
        path.join(dir, 'entry.ts'),
        [
          'export async function loadDynamic() {',
          "  return await import('./dynamic-target.js');",
          '}',
          "export * from './star-target.js';",
          "export { value } from './named-target.js';",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(dir, 'dynamic-target.ts'), 'export const dynamicValue = 1;\n');
      fs.writeFileSync(path.join(dir, 'star-target.ts'), 'export const starValue = 1;\n');
      fs.writeFileSync(path.join(dir, 'named-target.ts'), 'export const value = 1;\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps.sort()).toEqual(['dynamic-target.ts', 'named-target.ts', 'star-target.ts'].sort());
    });

    it('does not resolve an `export type { … } from` re-export (erased at compile time, no runtime edge)', () => {
      const dir = tmpDir('walker-type-only');
      fs.writeFileSync(path.join(dir, 'entry.ts'), "export type { Foo } from './types-only.js';\n");
      fs.writeFileSync(path.join(dir, 'types-only.ts'), 'export type Foo = { x: number };\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps).toEqual([]);
    });

    it('follows a dynamic import() transitively across two hops', () => {
      const dir = tmpDir('walker-transitive');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'entry.ts'), "export const load = () => import('./middle.js');\n");
      fs.writeFileSync(path.join(dir, 'middle.ts'), "export * from './leaf.js';\n");
      fs.writeFileSync(path.join(dir, 'leaf.ts'), 'export const leaf = 1;\n');

      const sources = new Map(
        ['entry.ts', 'middle.ts', 'leaf.ts'].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
      );
      const visited = new Set(['entry.ts']);
      const queue = ['entry.ts'];
      while (queue.length) {
        const cur = queue.shift()!;
        const src = sources.get(cur);
        if (!src) continue;
        for (const dep of relativeValueImports(cur, src, dir)) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          }
        }
      }

      expect(visited).toEqual(new Set(['entry.ts', 'middle.ts', 'leaf.ts']));
    });

    it('resolves a side-effect `import`, even when a package import with a `from` clause precedes it on an earlier line', () => {
      // Regression: a lazy, newline-spanning regex here previously let a
      // preceding non-relative `import path from 'path';` statement's `from`
      // clause absorb everything up to the NEXT `from '<relative>'` it could
      // find, silently swallowing this bare side-effect import in between —
      // exactly the shape `scripts/init-cli-agent.ts` and
      // `scripts/init-first-agent.ts` use for `import '../src/channels/index.js';`.
      const dir = tmpDir('walker-side-effect');
      fs.writeFileSync(
        path.join(dir, 'entry.ts'),
        [
          "import path from 'node:path';",
          "import './side-effect-target.js';",
          "import { later } from './later-target.js';",
        ].join('\n'),
      );
      fs.writeFileSync(path.join(dir, 'side-effect-target.ts'), 'export const ranSideEffect = true;\n');
      fs.writeFileSync(path.join(dir, 'later-target.ts'), 'export const later = 1;\n');

      const src = fs.readFileSync(path.join(dir, 'entry.ts'), 'utf8');
      const deps = relativeValueImports('entry.ts', src, dir);

      expect(deps.sort()).toEqual(['later-target.ts', 'side-effect-target.ts'].sort());
    });
  });
});
