#!/usr/bin/env tsx
/**
 * Public repository boundary checker.
 *
 * Portable checks use structural patterns and require no install state.
 * Install-aware checks additionally compare tracked content with identifiers
 * derived from the local registry and an ignored operator-maintained file.
 *
 * Findings intentionally omit the matched value.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

export type ScanCategory =
  | 'private-identifier'
  | 'email-address'
  | 'slack-identifier'
  | 'discord-identifier'
  | 'generated-install-identifier'
  | 'atlassian-tenant-url'
  | 'linear-workspace-url'
  | 'vendor-organization-id'
  | 'forbidden-artifact-path';

export interface Finding {
  file: string;
  line: number;
  category: ScanCategory;
}

interface AllowlistEntry {
  path: string;
  value: string;
  reason: string;
}

interface ScanInput {
  file: string;
  content: Buffer;
}

export interface ScanOptions {
  root: string;
  index: boolean;
  portable: boolean;
  dbPath?: string;
  // Undefined means "not explicitly requested" — run() resolves the default
  // local path, falling back to the main checkout when the worktree has none.
  // An explicit --identifiers value always wins over that fallback.
  identifiersPath?: string;
  allowlistPath: string;
  // Scan ONE text file instead of the tracked tree. Set by --message, which
  // the commit-msg hook points at git's message file. Commit messages are part
  // of what a fork publishes upstream — history travels with the branch — but
  // they are not tracked files, so the file scan never saw them. On
  // 2026-08-25 a message naming a real group folder and an install's OAuth
  // slot arrangement committed clean while the gate rejected the same
  // identifier in the diff.
  messagePath?: string;
}

const DEFAULT_DB_RELATIVE = path.join('data', 'v2.db');
const DEFAULT_IDENTIFIERS_RELATIVE = path.join('.nanoclaw', 'public-boundary-identifiers');

const GENERIC_IDENTIFIERS = new Set([
  'admin',
  'agent',
  'claude',
  'codex',
  // Same shape as 'dispatch' below: a Slack channel named "#commercial" put a
  // common English word in the registry-derived set, where it matched ordinary
  // prose in long-committed vendored design docs and blocked every commit. The
  // channel's platform ID stays banned.
  'commercial',
  'dbt cloud',
  'discord',
  // Common orchestration term (src/modules/orchestrator-dispatch/ and
  // dispatch.ts throughout). A Slack channel renamed to "#dispatch" put it
  // in the registry-derived set and blocked every commit with ~154 hits in
  // long-committed code. The channel's platform ID stays banned.
  'dispatch',
  'general',
  'github actions',
  'main',
  'main-codex',
  'main-opencode',
  'number',
  'opencode',
  'owner',
  'releases',
  'slack',
  'support',
  'system',
  'unknown',
  'discord-codex',
  'discord-opencode',
  'cli:local',
  'cli:test-driver',
  // Slack's built-in bot; ingress auto-creates a user row named this in any
  // install with a Slack workspace, and it collides with generic camelCase
  // `slackBot` variables in channel code. Universal, not install-specific.
  // Same for its platform ID: USLACKBOT is identical in every workspace and
  // appears as a literal in adapter filter code.
  'slackbot',
  'uslackbot',
]);

const RESERVED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'example.invalid',
  'host.docker.internal',
  'localhost',
  'nanoclaw.local',
]);

const FORBIDDEN_PATHS = [/^\.context\//, /^docs\/specs\/[^/]+\/qa-evidence(?:\/|$)/];

const STRUCTURAL_RULES: Array<{
  category: Exclude<ScanCategory, 'private-identifier' | 'forbidden-artifact-path'>;
  pattern: RegExp;
  synthetic: (value: string) => boolean;
}> = [
  {
    category: 'email-address',
    pattern: /(?<![/])\b[A-Z0-9._%+-]+@(?!\d+(?:\.\d+)+\.)(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi,
    synthetic: (value) => {
      const normalized = value.toLowerCase();
      const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
      const local = value.slice(0, value.indexOf('@')).toLowerCase();
      return (
        RESERVED_EMAIL_DOMAINS.has(domain) ||
        normalized === 'git@github.com' ||
        normalized === 'workspace-noreply@google.com' ||
        normalized === 'calendar-notification@google.com' ||
        domain === 'users.noreply.github.com' ||
        (/^\d+$/.test(local) && (domain === 's.whatsapp.net' || domain === 'g.us')) ||
        /^(?:alice|bob|jane|john|foo|bar|test|user)(?:[.+_-]|$)/.test(local) ||
        /^(?:acme|example|fixture|test)\d*\./.test(domain)
      );
    },
  },
  {
    category: 'slack-identifier',
    pattern: /\b(?=[CDGUWT][A-Z0-9]{8,}\b)(?=[A-Z0-9]*\d)[CDGUWT][A-Z0-9]+\b/g,
    synthetic: (value) =>
      /ALLOWED|CHANNEL|COLLIDE|DEST|EXAMPLE|FIXTURE|OTHER|PROJECT|TARGET|TEAM|TEST|UNKNOWN|USER|WORKSPACE/i.test(value),
  },
  {
    category: 'discord-identifier',
    pattern: /\b\d{17,20}\b/g,
    synthetic: (value) => /^(\d)\1+$/.test(value) || /^1234567890\d{8,10}$/.test(value),
  },
  {
    category: 'generated-install-identifier',
    pattern: /\b(?:ag|mg|sess)-\d{13}-[a-z0-9]{5,}\b/gi,
    synthetic: (value) => /example|fixture|test/i.test(value),
  },
  {
    category: 'atlassian-tenant-url',
    pattern: /https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\b/gi,
    synthetic: (value) => /^https:\/\/(?:example|fixture|test)\.atlassian\.net$/i.test(value),
  },
  {
    category: 'linear-workspace-url',
    pattern: /https:\/\/linear\.app\/([^/\s]+)\/issue\//gi,
    synthetic: (value) => /linear\.app\/(?:example|fixture|test)\/issue\//i.test(value),
  },
  {
    category: 'vendor-organization-id',
    pattern: /\borg_[A-Za-z0-9]{12,}\b/g,
    synthetic: (value) => /example|fixture|test/i.test(value),
  },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedIdentifierPattern(value: string): RegExp | null {
  const tokens = value.match(/[A-Za-z0-9]+/g) ?? [];
  if (tokens.length === 0) return null;
  const normalizedLength = tokens.reduce((sum, token) => sum + token.length, 0);
  if (normalizedLength < 4) {
    const identifier = tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}');
    const context =
      '(?:agent|client|customer|data|datafold|discord|group|slack|tenant|token|workspace|workgroup|[amw]g)';
    return new RegExp(
      `(^|[^A-Za-z0-9])(?:${context}[^A-Za-z0-9]{1,4}${identifier}|${identifier}[^A-Za-z0-9]{1,4}${context})(?=$|[^A-Za-z0-9])`,
      'i',
    );
  }
  if (normalizedLength < 6) {
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(value)}(?=$|[^A-Za-z0-9])`, 'i');
  }
  return new RegExp(`(^|[^A-Za-z0-9])${tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}')}(?=$|[^A-Za-z0-9])`, 'i');
}

function addIdentifier(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim().replace(/^#/, '');
  if (trimmed.length < 2 || GENERIC_IDENTIFIERS.has(trimmed.toLowerCase())) return;
  target.add(trimmed);
  for (const platformId of trimmed.match(/[CDGUWT][A-Z0-9]{8,}|\d{17,20}/g) ?? []) {
    if (GENERIC_IDENTIFIERS.has(platformId.toLowerCase())) continue;
    target.add(platformId);
  }
}

export function loadRegistryIdentifiers(dbPath: string): Set<string> {
  if (!fs.existsSync(dbPath)) throw new Error('install registry is missing');
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    throw new Error('install registry is unreadable');
  }

  const identifiers = new Set<string>();
  const queries = [
    'SELECT id, display_name FROM workgroups',
    'SELECT id, name, folder, workgroup_id FROM agent_groups',
    'SELECT id, platform_id, instance, name FROM messaging_groups',
    // system:* rows are synthetic senders minted when a host script DMs via
    // the CLI socket (health-sentinel, drift-check, ...). Their ids are
    // constants IN tracked scripts — treating them as install-private would
    // make the boundary check flag the very script that authors them.
    "SELECT id, display_name FROM users WHERE id NOT LIKE 'system:%'",
  ];
  try {
    for (const query of queries) {
      let rows: Record<string, unknown>[];
      try {
        rows = db.prepare(query).all() as Record<string, unknown>[];
      } catch {
        continue;
      }
      for (const row of rows) {
        for (const value of Object.values(row)) addIdentifier(identifiers, value);
      }
    }
  } finally {
    db.close();
  }
  if (identifiers.size === 0) throw new Error('install registry contained no usable identifiers');
  return identifiers;
}

export function loadLocalIdentifiers(identifiersPath: string): Set<string> {
  let text: string;
  try {
    text = fs.readFileSync(identifiersPath, 'utf8');
  } catch {
    throw new Error('local identifier inventory is missing or unreadable');
  }
  const identifiers = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    addIdentifier(identifiers, value);
  }
  if (identifiers.size === 0) throw new Error('local identifier inventory is empty');
  return identifiers;
}

function loadAllowlist(allowlistPath: string): AllowlistEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch {
    throw new Error('public boundary allowlist is missing or invalid');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { entries?: unknown }).entries) ||
    !(parsed as { entries: unknown[] }).entries.every(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as AllowlistEntry).path === 'string' &&
        typeof (entry as AllowlistEntry).value === 'string' &&
        typeof (entry as AllowlistEntry).reason === 'string' &&
        (entry as AllowlistEntry).reason.trim().length > 0,
    )
  ) {
    throw new Error('public boundary allowlist has an invalid schema');
  }
  return (parsed as { entries: AllowlistEntry[] }).entries;
}

function isAllowed(file: string, value: string, allowlist: AllowlistEntry[]): boolean {
  return allowlist.some((entry) => entry.path === file && entry.value === value);
}

function isSerializedAllowlistValue(file: string, value: string, allowlist: AllowlistEntry[]): boolean {
  return path.basename(file) === '.public-boundary-allowlist.json' && allowlist.some((entry) => entry.value === value);
}

function lineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function addFinding(target: Finding[], finding: Finding): void {
  if (
    !target.some(
      (existing) =>
        existing.file === finding.file && existing.line === finding.line && existing.category === finding.category,
    )
  ) {
    target.push(finding);
  }
}

export function scanInputs(
  inputs: ScanInput[],
  privateIdentifiers: Set<string>,
  allowlist: AllowlistEntry[],
): Finding[] {
  const findings: Finding[] = [];
  for (const input of inputs) {
    if (input.content.includes(0)) continue;
    const content = input.content.toString('utf8');

    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(input.file))) {
      addFinding(findings, { file: input.file, line: 1, category: 'forbidden-artifact-path' });
    }

    for (const rule of STRUCTURAL_RULES) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        const value = match[0];
        if (
          rule.synthetic(value) ||
          isAllowed(input.file, value, allowlist) ||
          isSerializedAllowlistValue(input.file, value, allowlist)
        ) {
          continue;
        }
        addFinding(findings, {
          file: input.file,
          line: lineNumber(content, match.index ?? 0),
          category: rule.category,
        });
      }
    }

    for (const identifier of privateIdentifiers) {
      // The serialized-allowlist exemption matters here too: a registry-derived
      // name (e.g. a workgroup) can only be allowlisted by writing its value
      // into .public-boundary-allowlist.json, which this same scan then reads.
      // The exemption covers exactly the values owner-reviewed via entries —
      // any other private identifier inside the file still flags (see test).
      if (isAllowed(input.file, identifier, allowlist) || isSerializedAllowlistValue(input.file, identifier, allowlist))
        continue;
      const pattern = normalizedIdentifierPattern(identifier);
      const match = pattern?.exec(content);
      if (match) {
        addFinding(findings, {
          file: input.file,
          line: lineNumber(content, match.index + (match[1]?.length ?? 0)),
          category: 'private-identifier',
        });
      }
    }
  }
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.category.localeCompare(b.category),
  );
}

function trackedInputs(root: string, index: boolean): ScanInput[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const inputs: ScanInput[] = [];
  for (const file of files) {
    try {
      const content = index
        ? execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
        : fs.readFileSync(path.join(root, file));
      inputs.push({ file, content });
    } catch {
      // A tracked file deleted from the selected surface has no content to scan.
    }
  }
  return inputs;
}

export function resolveOptions(argv: string[], cwd = process.cwd()): ScanOptions {
  const options: ScanOptions = {
    root: cwd,
    index: false,
    portable: false,
    allowlistPath: '.public-boundary-allowlist.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--portable') options.portable = true;
    else if (arg === '--staged' || arg === '--index') options.index = true;
    else if (arg === '--root') options.root = argv[++i] ?? '';
    else if (arg === '--db') options.dbPath = argv[++i];
    else if (arg === '--identifiers') options.identifiersPath = argv[++i] ?? '';
    else if (arg === '--allowlist') options.allowlistPath = argv[++i] ?? '';
    else if (arg === '--message') options.messagePath = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.root) throw new Error('--root requires a path');
  if (options.messagePath === '') throw new Error('--message requires a path');
  options.root = path.resolve(options.root);
  if (options.messagePath) options.messagePath = path.resolve(options.root, options.messagePath);
  if (options.identifiersPath !== undefined)
    options.identifiersPath = path.resolve(options.root, options.identifiersPath);
  options.allowlistPath = path.resolve(options.root, options.allowlistPath);
  if (options.dbPath) options.dbPath = path.resolve(options.root, options.dbPath);
  return options;
}

type IdentifierOrigin = 'explicit' | 'local' | 'main-checkout' | 'none';

// A linked worktree shares the main checkout's git dir, so `--git-common-dir`
// finds it with no configuration. Returns null (never throws) whenever that
// can't be established — git failure, or this root already IS the main
// checkout — so callers fall back to today's local-only behaviour.
function findMainCheckoutRoot(root: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
  const candidateRoot = path.dirname(path.resolve(root, commonDir));
  return candidateRoot === path.resolve(root) ? null : candidateRoot;
}

// Explicit path wins outright (and stays fail-closed: a bad explicit path
// throws, same as before). Otherwise try the local default, then the main
// checkout's copy of that same default. An unusable/missing source at any
// step is a soft miss, not an error, so a broken local file can't block
// resolution reaching the fallback.
function resolveIdentifierSet(
  explicitPath: string | undefined,
  root: string,
  mainCheckoutRoot: string | null,
  defaultRelative: string,
  loader: (resolvedPath: string) => Set<string>,
): { identifiers: Set<string>; origin: IdentifierOrigin } {
  if (explicitPath !== undefined) return { identifiers: loader(explicitPath), origin: 'explicit' };
  try {
    return { identifiers: loader(path.join(root, defaultRelative)), origin: 'local' };
  } catch {
    // fall through to the main-checkout fallback below
  }
  if (mainCheckoutRoot) {
    try {
      return { identifiers: loader(path.join(mainCheckoutRoot, defaultRelative)), origin: 'main-checkout' };
    } catch {
      // fall through to "none"
    }
  }
  return { identifiers: new Set(), origin: 'none' };
}

export interface RunReport {
  findings: Finding[];
  mode: 'portable' | 'install-aware' | 'structural-fallback';
  registryOrigin: IdentifierOrigin | 'skipped';
  identifiersOrigin: IdentifierOrigin | 'skipped';
}

/**
 * Git only strips `#` lines on the EDITOR path.
 *
 * `git commit -m` (and `-F`) use cleanup mode `whitespace`, which keeps
 * comment lines verbatim — verified against git 2.43.0: a `-F` message whose
 * body contains `#\tmodified: …`, `# <identifier>` and a scissors line comes
 * back out of `git log` byte for byte. Only the editor path uses cleanup
 * `default` (plus scissors under `-v`), which discards them. So blanking
 * every `#` line unconditionally is fail-OPEN: an identifier prefixed with
 * `#` and passed to `-m` ships while the gate prints "passed".
 *
 * Scanning every `#` line instead is fail-CLOSED but false-positives on git's
 * own editor template, which names the branch and lists every staged path — a
 * guaranteed block for an install with group-named directories, and a blocked
 * gate gets disabled with --no-verify, which checks nothing at all.
 *
 * The commit-msg hook is handed only the message file, never the invocation
 * (git passes the source to prepare-commit-msg, not to us), so the path has to
 * be inferred from content. Two rounds of this were bypassable because they
 * inferred it for the WHOLE FILE from a single marker anywhere in it:
 *
 *   - a `-m` body containing one `#\t` line blanked every other `#` line,
 *     including `# person@example.com` further down;
 *   - a `-m` body containing a scissors LOOKALIKE (`# --- >8 ---`) truncated
 *     everything below it out of the scan.
 *
 * Both are fixed by narrowing what a marker licenses:
 *
 *   1. Scissors must be git's own line EXACTLY — `# ` + 24 dashes + ` >8 ` +
 *      24 dashes (builtin/commit.c; verified against 2.43.0). A loose `-+`
 *      pattern is a one-line, hand-typeable way to hide a message tail.
 *   2. The template is a CONTIGUOUS TRAILING comment block, and it is only
 *      treated as one if it contains a bare `#` line. Git's template always
 *      has them (verified for staged, unstaged, `--allow-empty`, and `-v`
 *      commits) and always sits at the end of the file; `#` lines that appear
 *      anywhere else are the author's and get scanned.
 *
 * Rule 2 also fixes the mirror-image false positive: `--allow-empty` produces
 * a template with no `#\t` line and no scissors, so the previous marker set
 * missed it and scanned `# On branch <branch>` — a branch named after a
 * registry identifier blocked the commit.
 *
 * Two residual fail-opens are accepted deliberately, both requiring the author
 * to reproduce git's own template shape in a `-m` body: an identifier written
 * ON a `#\t` line inside a trailing block, and an identifier inside a trailing
 * comment block that also contains a bare `#` line. The alternative is
 * scanning git's template, whose false positives are not rare-and-contrived
 * but routine — and a gate that blocks routine commits is a gate that gets
 * turned off. Do NOT "simplify" this predicate in either direction; each half
 * is load-bearing against a bypass that shipped.
 *
 * Blanking rather than removing keeps reported line numbers matching the file
 * the author sees in their editor.
 */
const GIT_SCISSORS = /^# -{24} >8 -{24}$/m;
const GIT_BARE_COMMENT = /^#[ \t]*$/;

function commitMessageInput(messagePath: string): ScanInput {
  const raw = fs.readFileSync(messagePath, 'utf8');
  // `commit -v` appends the staged diff below the scissors rule, un-prefixed.
  // Git discards everything from that line down, so it never ships — and
  // pre-commit already gates that same content under its real filenames.
  const scissors = raw.search(GIT_SCISSORS);
  const lines = (scissors === -1 ? raw : raw.slice(0, scissors)).split('\n');

  // Walk back over the trailing run of comment and blank lines: that, and
  // only that, is where git's template can live.
  let blockStart = lines.length;
  while (blockStart > 0) {
    const line = lines[blockStart - 1];
    if (line.startsWith('#') || line.trim() === '') blockStart--;
    else break;
  }

  if (lines.slice(blockStart).some((line) => GIT_BARE_COMMENT.test(line))) {
    for (let i = blockStart; i < lines.length; i++) {
      if (lines[i].startsWith('#')) lines[i] = '';
    }
  }

  return { file: path.basename(messagePath), content: Buffer.from(lines.join('\n'), 'utf8') };
}

export function runReport(options: ScanOptions): RunReport {
  const privateIdentifiers = new Set<string>();
  let registryOrigin: IdentifierOrigin | 'skipped' = 'skipped';
  let identifiersOrigin: IdentifierOrigin | 'skipped' = 'skipped';

  if (!options.portable) {
    const mainCheckoutRoot = findMainCheckoutRoot(options.root);
    const registry = resolveIdentifierSet(
      options.dbPath,
      options.root,
      mainCheckoutRoot,
      DEFAULT_DB_RELATIVE,
      loadRegistryIdentifiers,
    );
    registryOrigin = registry.origin;
    for (const value of registry.identifiers) privateIdentifiers.add(value);

    const identifiers = resolveIdentifierSet(
      options.identifiersPath,
      options.root,
      mainCheckoutRoot,
      DEFAULT_IDENTIFIERS_RELATIVE,
      loadLocalIdentifiers,
    );
    identifiersOrigin = identifiers.origin;
    for (const value of identifiers.identifiers) privateIdentifiers.add(value);
  }

  const mode: RunReport['mode'] = options.portable
    ? 'portable'
    : registryOrigin === 'none' && identifiersOrigin === 'none'
      ? 'structural-fallback'
      : 'install-aware';

  const findings = scanInputs(
    options.messagePath ? [commitMessageInput(options.messagePath)] : trackedInputs(options.root, options.index),
    privateIdentifiers,
    loadAllowlist(options.allowlistPath),
  );
  return { findings, mode, registryOrigin, identifiersOrigin };
}

export function run(options: ScanOptions): Finding[] {
  return runReport(options).findings;
}

function describeMode(report: RunReport): string {
  if (report.mode === 'portable') return 'portable — structural patterns only';
  if (report.mode === 'structural-fallback') return 'structural patterns only — no identifier registry found';
  const usedFallback = report.registryOrigin === 'main-checkout' || report.identifiersOrigin === 'main-checkout';
  return usedFallback ? 'identifiers from main checkout' : 'identifiers from local install';
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const options = resolveOptions(argv);
    const report = runReport(options);
    const { findings } = report;
    if (report.mode === 'structural-fallback') {
      process.stderr.write(
        'WARNING: no identifier registry found (locally or in the main checkout) — running structural-pattern checks only; real names and tenant identifiers will NOT be caught\n',
      );
    }
    const scanned = options.messagePath ? 'commit message' : options.index ? 'index' : 'worktree';
    const surface = `${scanned}, ${describeMode(report)}`;
    if (findings.length === 0) {
      process.stdout.write(`public boundary check passed (${surface})\n`);
      return 0;
    }
    for (const finding of findings) {
      process.stderr.write(`${finding.file}:${finding.line} ${finding.category}\n`);
    }
    process.stderr.write(`public boundary check failed with ${findings.length} redacted finding(s) (${surface})\n`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown checker error';
    process.stderr.write(`public boundary check could not run: ${message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
