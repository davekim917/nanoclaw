/**
 * A skill that installs code into the host tree must keep compiling after it
 * is installed. Its resource files are not part of the host build until then,
 * so a host change that deletes or renames an export one of them imports goes
 * unnoticed until someone runs the skill.
 *
 * Install locations come from the skill itself: `nc:copy` directives and the
 * copy steps in its SKILL.md code blocks (`cp SRC DST`, `SRC → DST`). Each named
 * relative import in an installed host-side file is resolved against its
 * install location and checked, by TypeScript parse, against what the target
 * module exports.
 *
 * A `from-branch:` copy is read from the remote an install would fetch it
 * from (`detectRegistryRemote`, the engine's own resolver), as
 * `git show <remote>/<branch>:<path>`. When that ref is not fetched locally
 * the copy is skipped, and the skip says what to fetch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { detectRegistryRemote } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';
import type { ChannelContextDefaults, ConversationInfo } from '../src/channels/adapter.js';
import { getAllUsers } from '../src/modules/permissions/db/users.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = '.claude/skills';
const CODE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;

/**
 * Host exports whose only callers are skill resources. The checks below reach
 * those callers by resolving paths at run time, which knip cannot follow, so
 * without this static import knip reports these exports unused and a cleanup
 * deletes them.
 */
const SKILL_ONLY_EXPORTS: Record<string, unknown> = { getAllUsers };

/** The same, for host types whose only importers are `from-branch:` copies. */
interface SkillOnlyTypes {
  ChannelContextDefaults: ChannelContextDefaults;
  ConversationInfo: ConversationInfo;
}
const SKILL_ONLY_TYPES = ['ChannelContextDefaults', 'ConversationInfo'] as const satisfies ReadonlyArray<
  keyof SkillOnlyTypes
>;

/** Skill code files no copy step installs, and why. */
const NOT_INSTALLED: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: '.claude/skills/add-whatsapp/scripts/', reason: 'run in place with pnpm exec tsx' },
  { prefix: '.claude/skills/add-wechat/scripts/', reason: 'run in place with pnpm exec tsx' },
  {
    prefix: '.claude/skills/migrate-from-openclaw/scripts/discover-openclaw.ts',
    reason: 'run in place with pnpm exec tsx',
  },
  {
    prefix: '.claude/skills/migrate-from-openclaw/scripts/extract-channel-credentials.ts',
    reason: 'run in place with pnpm exec tsx',
  },
  { prefix: '.claude/skills/migrate-from-openclaw/tests/', reason: 'runs in place under vitest.skills.config.ts' },
  {
    prefix: '.claude/skills/pr-review-loop/',
    reason: 'a symlink to container/skills/pr-review-loop, a container skill whose scripts run in place',
  },
  { prefix: '.claude/skills/slack-a2a-rooms/tests/', reason: 'runs in place under vitest.skills.config.ts' },
  {
    prefix: '.claude/skills/use-native-credential-proxy/env.ts',
    reason: 'in-place typecheck shim; the installed file imports src/env.ts directly',
  },
];

interface Install {
  skill: string;
  /** A tree path, or `git:<ref>:<path>` for a file read from a branch. */
  src: string;
  dst: string;
}

/**
 * Git with every inherited `GIT_*` variable removed. A test run launched from
 * a hook or another git process can inherit `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_INDEX_FILE`, which would point these reads at some other repository.
 * Read-only: `null` when the command fails.
 */
function git(args: string[], timeout?: number): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout,
    });
  } catch {
    return null;
  }
}

const registryRemote = detectRegistryRemote(REPO_ROOT);

/**
 * The local ref an install of `branch` reads, or why there is none. An install
 * fetches first, so a local ref behind the remote would check an old payload:
 * it counts only when `git ls-remote` (read-only) shows it current.
 */
function registryRefOf(branch: string): { ref: string } | { reason: string } {
  if (!registryRemote) return { reason: 'no remote resolves as the registry (setup/lib/channels-remote.sh)' };
  const ref = `refs/remotes/${registryRemote}/${branch}`;
  const fetchIt = `run \`git fetch ${registryRemote} ${branch}\` to check these copies`;
  const local = git(['rev-parse', '--verify', '--quiet', ref])?.trim();
  if (!local) return { reason: `${registryRemote}/${branch} is not fetched locally; ${fetchIt}` };
  const remote = git(['ls-remote', '--heads', registryRemote, branch], 30_000)?.split(/\s/)[0];
  if (!remote) return { reason: `cannot reach ${registryRemote} to confirm ${registryRemote}/${branch} is current` };
  if (remote !== local) return { reason: `${registryRemote}/${branch} is behind the remote; ${fetchIt}` };
  return { ref };
}

function read(src: string): string {
  if (!src.startsWith('git:')) return fs.readFileSync(path.join(REPO_ROOT, src), 'utf8');
  const out = git(['show', src.slice('git:'.length)]);
  if (out === null) throw new Error(`cannot read ${src}`);
  return out;
}

function listFiles(rel: string): string[] {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return fs
    .readdirSync(abs)
    .filter((name) => name !== 'node_modules')
    .flatMap((name) => listFiles(path.posix.join(rel, name)));
}

/** The body lines of every fenced code block that is not an `nc:` directive. */
function plainCodeBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let inFence = false;
  for (const line of markdown.split('\n')) {
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      if (inFence) {
        if (current) blocks.push(current);
        current = null;
        inFence = false;
      } else {
        inFence = true;
        current = fence[1].startsWith('nc:') ? null : [];
      }
      continue;
    }
    current?.push(line.trim());
  }
  return blocks;
}

interface BranchCopy {
  skill: string;
  branch: string;
  src: string;
  dst: string;
}

function branchCopiesOf(skill: string): BranchCopy[] {
  const markdown = fs.readFileSync(path.join(REPO_ROOT, SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
  return parseDirectives(markdown).flatMap((d) => {
    const branch = d.attrs['from-branch'];
    if (d.kind !== 'copy' || typeof branch !== 'string') return [];
    return d.body.map((line) => {
      const [src, dst = src] = line.split('->').map((part) => part.trim());
      return { skill, branch, src, dst };
    });
  });
}

/** A branch copy's files as read from `ref`; a path the ref lacks yields none. */
function installsFromRef(copy: BranchCopy, ref: string): Install[] {
  const files = (git(['ls-tree', '-r', '--name-only', ref, '--', copy.src]) ?? '').split('\n').filter(Boolean);
  return files.map((file) => ({
    skill: copy.skill,
    src: `git:${ref}:${file}`,
    dst: path.posix.join(copy.dst, path.posix.relative(copy.src, file)),
  }));
}

function installsOf(skill: string): Install[] {
  const skillDir = path.posix.join(SKILLS_DIR, skill);
  const markdown = fs.readFileSync(path.join(REPO_ROOT, skillDir, 'SKILL.md'), 'utf8');
  const pairs: Array<[string, string]> = [];

  for (const d of parseDirectives(markdown)) {
    if (d.kind !== 'copy' || d.attrs['from-branch'] !== undefined) continue;
    for (const line of d.body) {
      const [src, dst = src] = line.split('->').map((s) => s.trim());
      pairs.push([path.posix.join(skillDir, src), dst]);
    }
  }

  for (const block of plainCodeBlocks(markdown)) {
    const vars: Record<string, string> = { CLAUDE_SKILL_DIR: skillDir };
    const expand = (token: string) =>
      token.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name: string) => vars[name] ?? whole);
    for (const line of block) {
      const assign = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=["']?([^"'\s]+)["']?$/);
      if (assign) {
        vars[assign[1]] = expand(assign[2]);
        continue;
      }
      const tokens = line.replace(/\s+#.*$/, '').split(/\s+/);
      if (tokens[0] === 'cp') {
        const operands = tokens.slice(1).filter((t) => !t.startsWith('-'));
        if (operands.length === 2) pairs.push([expand(operands[0]), expand(operands[1])]);
        continue;
      }
      const arrow = line.match(/^(\S+)\s+(?:→|->)\s+(\S+)$/);
      if (arrow) pairs.push([expand(arrow[1]), expand(arrow[2])]);
    }
  }

  return pairs
    .filter(([src]) => src.startsWith(`${skillDir}/`))
    .flatMap(([src, dst]) =>
      listFiles(src).map((file) => ({ skill, src: file, dst: path.posix.join(dst, path.posix.relative(src, file)) })),
    );
}

const skills = fs
  .readdirSync(path.join(REPO_ROOT, SKILLS_DIR))
  .filter((name) => fs.existsSync(path.join(REPO_ROOT, SKILLS_DIR, name, 'SKILL.md')))
  .sort();
const installs = skills.flatMap(installsOf);
const installedAt = new Map(installs.map((i) => [i.dst, i]));

const parsed = new Map<string, ts.SourceFile>();
function parse(rel: string): ts.SourceFile {
  let file = parsed.get(rel);
  if (!file) {
    file = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
    parsed.set(rel, file);
  }
  return file;
}

/** Where a relative specifier lands, as the file to read: an installed resource's source, or a tree file. */
function resolve(
  fromDst: string,
  specifier: string,
  lookup: ReadonlyMap<string, Install> = installedAt,
): { dst: string; read: string } | null {
  const base = path.posix.join(path.posix.dirname(fromDst), specifier);
  const stem = base.replace(/\.[cm]?js$/, '');
  for (const dst of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`]) {
    const install = lookup.get(dst);
    if (install) return { dst, read: install.src };
    const abs = path.join(REPO_ROOT, dst);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { dst, read: dst };
  }
  return null;
}

function modifierKinds(node: ts.Node): ts.SyntaxKind[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).map((m) => m.kind) : [];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

function exportsOf(
  target: { dst: string; read: string },
  lookup: ReadonlyMap<string, Install> = installedAt,
  seen = new Set<string>(),
): Set<string> {
  const names = new Set<string>();
  if (seen.has(target.dst)) return names;
  seen.add(target.dst);
  for (const stmt of parse(target.read).statements) {
    if (ts.isExportAssignment(stmt)) names.add('default');
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) names.add(el.name.text);
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        names.add(stmt.exportClause.name.text);
      } else if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const next = resolve(target.dst, stmt.moduleSpecifier.text, lookup);
        if (next) for (const n of exportsOf(next, lookup, seen)) if (n !== 'default') names.add(n);
      }
      continue;
    }
    const kinds = modifierKinds(stmt);
    if (!kinds.includes(ts.SyntaxKind.ExportKeyword)) continue;
    if (kinds.includes(ts.SyntaxKind.DefaultKeyword)) {
      names.add('default');
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) for (const n of bindingNames(decl.name)) names.add(n);
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name &&
      ts.isIdentifier(stmt.name)
    ) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

interface NamedImport {
  specifier: string;
  names: string[];
}

function dynamicImportSpecifier(expr: ts.Expression | undefined): string | undefined {
  if (!expr || !ts.isAwaitExpression(expr) || !ts.isCallExpression(expr.expression)) return undefined;
  const call = expr.expression;
  const arg = call.arguments[0];
  return call.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

function namedImportsOf(file: ts.SourceFile): NamedImport[] {
  const out: NamedImport[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const clause = node.importClause;
      const names = clause.name ? ['default'] : [];
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
      }
      out.push({ specifier: node.moduleSpecifier.text, names });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      out.push({
        specifier: node.moduleSpecifier.text,
        names: node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text),
      });
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const specifier = dynamicImportSpecifier(node.initializer);
      if (specifier !== undefined) {
        out.push({
          specifier,
          names: node.name.elements.map((el) =>
            el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : bindingNames(el.name)[0],
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out.filter((i) => i.specifier.startsWith('.'));
}

const isHostCode = (i: Install) => CODE_FILE.test(i.dst) && !i.dst.startsWith('container/');
const hostInstalls = installs.filter(isHostCode);

/** Per registry branch: the host code its copies install, and the lookup their imports resolve through. */
const branchChecks: Array<{ ref: string; lookup: ReadonlyMap<string, Install>; installs: Install[] }> = [];
/** Declared branch sources the resolved ref does not have; the install's `git show` fails on each. */
const absentBranchSources: Array<{ copy: BranchCopy; ref: string }> = [];
/** Branch copies that could not be read, with the reason. */
const uncheckedBranchCopies: Array<{ skill: string; branch: string; reason: string }> = [];
{
  const copies = skills.flatMap(branchCopiesOf);
  for (const branch of [...new Set(copies.map((c) => c.branch))].sort()) {
    const onBranch = copies.filter((c) => c.branch === branch);
    const found = registryRefOf(branch);
    if ('reason' in found) {
      for (const skill of [...new Set(onBranch.map((c) => c.skill))]) {
        uncheckedBranchCopies.push({ skill, branch, reason: found.reason });
      }
      continue;
    }
    const fromRef = onBranch.flatMap((copy) => {
      const files = installsFromRef(copy, found.ref);
      if (files.length === 0) absentBranchSources.push({ copy, ref: found.ref });
      return files;
    });
    const lookup = new Map([...installedAt, ...fromRef.map((i): [string, Install] => [i.dst, i])]);
    branchChecks.push({ ref: found.ref, lookup, installs: fromRef.filter(isHostCode) });
  }
}

function importProblems(install: Install, lookup: ReadonlyMap<string, Install> = installedAt): string[] {
  const problems: string[] = [];
  for (const { specifier, names } of namedImportsOf(parse(install.src))) {
    const target = resolve(install.dst, specifier, lookup);
    if (!target) {
      problems.push(`imports '${specifier}', which does not exist relative to ${install.dst}`);
      continue;
    }
    const exported = exportsOf(target, lookup);
    for (const name of names) {
      if (!exported.has(name)) {
        problems.push(`imports { ${name} } from '${specifier}', but ${target.dst} does not export it`);
      }
    }
  }
  return problems;
}

describe('installable skill resources', () => {
  it('finds the host-side installs the skills declare', () => {
    expect(hostInstalls.map((i) => i.dst)).toContain('src/dashboard-pusher.ts');
  });

  it('every skill code file is installed by a copy step or listed as not installed', () => {
    const sources = new Set(installs.map((i) => i.src));
    const unaccounted = skills
      .flatMap((skill) => listFiles(path.posix.join(SKILLS_DIR, skill)))
      .filter((file) => CODE_FILE.test(file) && !sources.has(file))
      .filter((file) => !NOT_INSTALLED.some((entry) => file.startsWith(entry.prefix)));
    expect(unaccounted, 'no copy step in the skill installs these; list each in NOT_INSTALLED with the reason').toEqual(
      [],
    );
    for (const entry of NOT_INSTALLED) {
      expect(listFiles(entry.prefix.replace(/\/$/, '')).length, `${entry.prefix} no longer exists`).toBeGreaterThan(0);
    }
  });

  for (const install of hostInstalls) {
    it(`${install.skill}: ${install.src} resolves every named import at ${install.dst}`, () => {
      expect(importProblems(install), `${install.skill}: ${install.src} (installed at ${install.dst})`).toEqual([]);
    });
  }

  for (const { lookup, installs: fromRef } of branchChecks) {
    for (const install of fromRef) {
      it(`${install.skill}: ${install.src} resolves every named import at ${install.dst}`, () => {
        expect(
          importProblems(install, lookup),
          `${install.skill}: ${install.src} (installed at ${install.dst})`,
        ).toEqual([]);
      });
    }
  }

  for (const { copy, ref } of absentBranchSources) {
    it(`${copy.skill}: from-branch:${copy.branch} source ${copy.src} exists at ${ref}`, () => {
      expect.fail(`${copy.skill} copies ${copy.src} from ${ref}, which has no such path`);
    });
  }

  for (const { skill, branch, reason } of uncheckedBranchCopies) {
    it.skip(`${skill}: from-branch:${branch} copies not checked — ${reason}`);
  }

  it('SKILL_ONLY_EXPORTS names only exports a skill resource still imports', () => {
    const imported = new Set(
      hostInstalls.flatMap((install) => namedImportsOf(parse(install.src)).flatMap((i) => i.names)),
    );
    expect(Object.keys(SKILL_ONLY_EXPORTS).filter((name) => !imported.has(name))).toEqual([]);
  });

  it.skipIf(branchChecks.length === 0 || uncheckedBranchCopies.length > 0)(
    'SKILL_ONLY_TYPES names only types a from-branch copy still imports (skipped while any registry branch is unread)',
    () => {
      const imported = new Set(
        branchChecks.flatMap((check) =>
          check.installs.flatMap((install) => namedImportsOf(parse(install.src)).flatMap((i) => i.names)),
        ),
      );
      const refs = branchChecks.map((check) => check.ref).join(', ');
      expect(
        SKILL_ONLY_TYPES.filter((name) => !imported.has(name)),
        `no from-branch copy in ${refs} imports these`,
      ).toEqual([]);
    },
  );
});
