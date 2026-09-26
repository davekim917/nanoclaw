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
import { execFileSync, spawnSync } from 'node:child_process';
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
  allowStructural: boolean;
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
  // A committed message is serialized history, not an editor buffer. Unlike
  // the commit-msg input, its scissors and comment text must be scanned.
  messageRaw: boolean;
  baselinePath?: string;
  writeBaseline: boolean;
  acceptGrowth: boolean;
}

const DEFAULT_DB_RELATIVE = path.join('data', 'v2.db');
const DEFAULT_IDENTIFIERS_RELATIVE = path.join('.nanoclaw', 'public-boundary-identifiers');
const DEFAULT_BASELINE_RELATIVE = '.public-boundary-baseline.json';

// A repository name built only from these words names a kind of repository,
// not a client, and would match ordinary prose across the whole tree.
const GENERIC_REPOSITORY_WORDS = new Set([
  'admin',
  'agent',
  'analytics',
  'android',
  'api',
  'app',
  'apps',
  'backend',
  'bot',
  'cli',
  'client',
  'config',
  'core',
  'dashboard',
  'data',
  'dbt',
  'demo',
  'deploy',
  'dev',
  'docs',
  'etl',
  'frontend',
  'infra',
  'integrations',
  'ios',
  'lib',
  'looker',
  'main',
  'maintenance',
  'mobile',
  'ops',
  'pipeline',
  'platform',
  'prod',
  'qa',
  'report',
  'scripts',
  'sdk',
  'segment',
  'server',
  'service',
  'services',
  'site',
  'snowflake',
  'stage',
  'staging',
  'table',
  'template',
  'templates',
  'terraform',
  'test',
  'tests',
  'tools',
  'ui',
  'viz',
  'web',
  'website',
  'wiki',
]);

// A three-letter all-caps name normally matches as a bare word (see
// normalizedIdentifierPattern). These acronyms appear throughout ordinary
// code, so a client repository named after one keeps the contextual match.
const COMMON_ACRONYMS = new Set([
  'api',
  'app',
  'aws',
  'cli',
  'csv',
  'css',
  'dbt',
  'dev',
  'dns',
  'etl',
  'gcp',
  'git',
  'ios',
  'jwt',
  'llm',
  'mcp',
  'npm',
  'ops',
  'pdf',
  'sdk',
  'sql',
  'ssh',
  'ssl',
  'tls',
  'uri',
  'url',
  'web',
  'xml',
  'yml',
  'zip',
]);

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
  // An all-caps three-letter name is a product or code name; the contextual
  // rule below let one appear hundreds of times in tracked files unflagged.
  if (/^[A-Z][A-Z0-9]{2}$/.test(value) && !COMMON_ACRONYMS.has(value.toLowerCase())) {
    return new RegExp(`(^|[^A-Za-z0-9])${value}(?=$|[^A-Za-z0-9])`, 'gi');
  }
  if (normalizedLength < 4) {
    const identifier = tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}');
    const context =
      '(?:agent|client|customer|data|datafold|discord|group|slack|tenant|token|workspace|workgroup|[amw]g)';
    return new RegExp(
      `(^|[^A-Za-z0-9])(?:${context}[^A-Za-z0-9]{1,4}${identifier}|${identifier}[^A-Za-z0-9]{1,4}${context})(?=$|[^A-Za-z0-9])`,
      'gi',
    );
  }
  if (normalizedLength < 6) {
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(value)}(?=$|[^A-Za-z0-9])`, 'gi');
  }
  return new RegExp(`(^|[^A-Za-z0-9])${tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}')}(?=$|[^A-Za-z0-9])`, 'gi');
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
  } catch (err) {
    throw new Error('install registry is unreadable', { cause: err });
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
    'SELECT assistant_name FROM container_configs',
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

export interface RemoteRepository {
  host: string;
  owner: string;
  repo: string;
}

/** Host, owner and repository from a clone URL (https, ssh://, or scp-style); null for anything else. */
export function remoteOwnerRepo(url: string): RemoteRepository | null {
  const trimmed = url.trim();
  let host: string;
  let remotePath: string;
  // git's scp-like form is `[user@]host:path`, recognized only with no slash before the first colon.
  const scpStyle = /^(?:[^/@\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scpStyle) {
    host = scpStyle[1];
    remotePath = scpStyle[2];
  } else {
    if (!URL.canParse(trimmed)) return null;
    const parsed = new URL(trimmed);
    if (!/^(?:https?|ssh|git):$/.test(parsed.protocol)) return null;
    host = parsed.hostname;
    remotePath = parsed.pathname;
  }
  const segments = remotePath
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) return null;
  return { host: host.toLowerCase(), owner: segments[segments.length - 2], repo: segments[segments.length - 1] };
}

// A hook exports its own repository's GIT_DIR and friends; left in place they
// would make a lookup in another checkout read the committing repository.
const REPOSITORY_SELECTION_ENV =
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/;

function repositoryNeutralEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_SELECTION_ENV.test(key)));
}

/**
 * `git config` lines, or null when the lookup failed for a reason other than
 * "no such key" (exit 1): an unreadable or malformed config.
 */
function gitConfigLines(args: string[], cwd: string): string[] | null {
  const result = spawnSync('git', ['config', ...args], {
    cwd,
    env: repositoryNeutralEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status === 1) return [];
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\n').filter(Boolean);
}

function repositoryKey(remote: RemoteRepository): string {
  return `${remote.host}/${remote.owner}/${remote.repo}`.toLowerCase();
}

export interface PublicRemotes {
  /** Owners of the scanned and install checkouts' remotes: their names appear in public URLs. */
  owners: Set<string>;
  /** Exactly those remotes. Another repository under the same owner may be private. */
  repositories: Set<string>;
}

// Unlike identifier discovery, a failure here fails strict: an unread remote
// only exempts less, so a root that is not a readable checkout is skipped.
export function publicRemotes(roots: string[]): PublicRemotes {
  const remotes: PublicRemotes = { owners: new Set(), repositories: new Set() };
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const lines = gitConfigLines(['--local', '--get-regexp', '^remote\\..*\\.url$'], root);
    if (lines === null) continue;
    for (const line of lines) {
      const parsed = remoteOwnerRepo(line.replace(/^\S+\s+/, ''));
      if (!parsed) continue;
      remotes.owners.add(parsed.owner.toLowerCase());
      remotes.repositories.add(repositoryKey(parsed));
    }
  }
  return remotes;
}

/**
 * The install checkout that holds `dbPath`, only for the `<install>/data/<db>`
 * layout. An explicit registry elsewhere names no checkout: its grandparent
 * must not contribute groups, clones, or public remotes.
 */
function installRootOf(dbPath: string): string | null {
  const dataDir = path.dirname(path.resolve(dbPath));
  return path.basename(dataDir) === 'data' ? path.dirname(dataDir) : null;
}

function isGenericRepositoryName(name: string): boolean {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.every((word) => GENERIC_REPOSITORY_WORDS.has(word));
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

type SourceRead<T> = { ok: true; value: T } | { ok: false; absent: boolean };

// Absent is fine: an install need not have groups or clones. Any other
// failure means a source exists but its names are unknown.
function readSource<T>(read: () => T): SourceRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    return { ok: false, absent: errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR' };
  }
}

function listSource(dir: string, problems: string[], what: string): string[] {
  const listed = readSource(() => fs.readdirSync(dir));
  if (listed.ok) return listed.value;
  if (!listed.absent) problems.push(`${what} could not be listed`);
  return [];
}

/**
 * Names the install holds outside the registry tables: agent persona names
 * from each group's container.json, and the owner and name of every cloned
 * client repository. Derived rather than listed by hand, so a new client is
 * covered the moment its group or repository exists. A source that exists but
 * cannot be read is recorded in `problems` (never by name) rather than
 * silently contributing nothing.
 */
export function loadInstallIdentifiers(dbPath: string, remotes: PublicRemotes, problems: string[]): Set<string> {
  const identifiers = new Set<string>();
  const installRoot = installRootOf(dbPath);
  if (!installRoot) return identifiers;
  const groupsDir = path.join(installRoot, 'groups');
  for (const folder of listSource(groupsDir, problems, 'the groups directory')) {
    const config = readSource(
      () => JSON.parse(fs.readFileSync(path.join(groupsDir, folder, 'container.json'), 'utf8')) as unknown,
    );
    if (!config.ok) {
      if (!config.absent) problems.push('a group container.json could not be read or parsed');
      continue;
    }
    if (config.value && typeof config.value === 'object')
      addIdentifier(identifiers, (config.value as Record<string, unknown>).assistantName);
  }

  const repositoriesDir = path.join(installRoot, 'data', 'repositories');
  for (const workgroup of listSource(repositoriesDir, problems, 'the repository store')) {
    for (const name of listSource(path.join(repositoriesDir, workgroup), problems, 'a repository directory')) {
      const config = path.join(repositoriesDir, workgroup, name, '.git', 'config');
      const present = readSource(() => fs.statSync(config));
      if (!present.ok) {
        if (!present.absent) problems.push('a cloned repository configuration could not be read');
        continue;
      }
      const lines = gitConfigLines(['--file', config, '--get', 'remote.origin.url'], repositoriesDir);
      if (lines === null) {
        problems.push('a cloned repository configuration could not be read');
        continue;
      }
      const parsed = lines[0] ? remoteOwnerRepo(lines[0]) : null;
      if (!parsed) continue;
      if (!remotes.owners.has(parsed.owner.toLowerCase())) addIdentifier(identifiers, parsed.owner);
      if (!remotes.repositories.has(repositoryKey(parsed)) && !isGenericRepositoryName(parsed.repo))
        addIdentifier(identifiers, parsed.repo);
    }
  }
  return identifiers;
}

export function loadLocalIdentifiers(identifiersPath: string): Set<string> {
  let text: string;
  try {
    text = fs.readFileSync(identifiersPath, 'utf8');
  } catch (err) {
    throw new Error('local identifier inventory is missing or unreadable', { cause: err });
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
  } catch (err) {
    throw new Error('public boundary allowlist is missing or invalid', { cause: err });
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
  const identifierPatterns = [...privateIdentifiers].map((identifier) => ({
    identifier,
    pattern: normalizedIdentifierPattern(identifier),
  }));
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

    for (const { identifier, pattern } of identifierPatterns) {
      // The serialized-allowlist exemption matters here too: a registry-derived
      // name (e.g. a workgroup) can only be allowlisted by writing its value
      // into .public-boundary-allowlist.json, which this same scan then reads.
      // The exemption covers exactly the values owner-reviewed via entries —
      // any other private identifier inside the file still flags (see test).
      if (isAllowed(input.file, identifier, allowlist) || isSerializedAllowlistValue(input.file, identifier, allowlist))
        continue;
      if (!pattern) continue;
      // Every matching line, not just the first: the baseline ratchet counts
      // lines, so a second occurrence in an already-baselined file must raise it.
      for (const match of content.matchAll(pattern)) {
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
    allowStructural: false,
    messageRaw: false,
    allowlistPath: '.public-boundary-allowlist.json',
    writeBaseline: false,
    acceptGrowth: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--portable') options.portable = true;
    else if (arg === '--allow-structural') options.allowStructural = true;
    else if (arg === '--staged' || arg === '--index') options.index = true;
    else if (arg === '--root') options.root = argv[++i] ?? '';
    else if (arg === '--db') options.dbPath = argv[++i];
    else if (arg === '--identifiers') options.identifiersPath = argv[++i] ?? '';
    else if (arg === '--allowlist') options.allowlistPath = argv[++i] ?? '';
    else if (arg === '--message') options.messagePath = argv[++i] ?? '';
    else if (arg === '--message-raw') options.messageRaw = true;
    else if (arg === '--baseline') options.baselinePath = argv[++i] ?? '';
    else if (arg === '--write-baseline') options.writeBaseline = true;
    else if (arg === '--accept-growth') options.acceptGrowth = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.root) throw new Error('--root requires a path');
  if (options.messagePath === '') throw new Error('--message requires a path');
  if (options.messageRaw && !options.messagePath) throw new Error('--message-raw requires --message');
  if (options.baselinePath === '') throw new Error('--baseline requires a path');
  if (options.acceptGrowth && !options.writeBaseline) throw new Error('--accept-growth requires --write-baseline');
  if (options.writeBaseline && (options.messagePath || options.portable))
    throw new Error('--write-baseline scans the tracked tree with install identifiers');
  options.root = path.resolve(options.root);
  if (options.messagePath) options.messagePath = path.resolve(options.root, options.messagePath);
  if (options.identifiersPath !== undefined)
    options.identifiersPath = path.resolve(options.root, options.identifiersPath);
  options.allowlistPath = path.resolve(options.root, options.allowlistPath);
  if (options.dbPath) options.dbPath = path.resolve(options.root, options.dbPath);
  if (options.baselinePath) options.baselinePath = path.resolve(options.root, options.baselinePath);
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
): { identifiers: Set<string>; origin: IdentifierOrigin; attemptedPaths: string[] } {
  if (explicitPath !== undefined) {
    return { identifiers: loader(explicitPath), origin: 'explicit', attemptedPaths: [explicitPath] };
  }
  const attemptedPaths = [path.join(root, defaultRelative)];
  try {
    return { identifiers: loader(attemptedPaths[0]), origin: 'local', attemptedPaths };
  } catch {
    // fall through to the main-checkout fallback below
  }
  if (mainCheckoutRoot) {
    const mainCheckoutPath = path.join(mainCheckoutRoot, defaultRelative);
    attemptedPaths.push(mainCheckoutPath);
    try {
      return { identifiers: loader(mainCheckoutPath), origin: 'main-checkout', attemptedPaths };
    } catch {
      // fall through to "none"
    }
  }
  return { identifiers: new Set(), origin: 'none', attemptedPaths };
}

export interface RunReport {
  findings: Finding[];
  mode: 'portable' | 'install-aware' | 'structural-fallback';
  registryOrigin: IdentifierOrigin | 'skipped';
  identifiersOrigin: IdentifierOrigin | 'skipped';
  registryPathsTried: string[];
  identifiersPathsTried: string[];
  baseline: BaselineOutcome;
  /** Identifier sources that exist but could not be read; their names are missing from the scan. */
  discoveryProblems: string[];
}

/**
 * Per-file ratchet over pre-existing private-identifier lines: paths and line
 * counts only, never the values. A file may keep at most its recorded count;
 * a file absent from the baseline may hold none.
 */
export interface Baseline {
  files: Record<string, number>;
}

export interface BaselineOutcome {
  /** Private-identifier lines accepted because their file is within its recorded count. */
  held: number;
  heldFiles: number;
  /** Files whose count rose above their recorded count; their findings stay reported. */
  exceeded: Array<{ file: string; count: number; recorded: number }>;
  /** Files now below their recorded count: `--write-baseline` lowers them. */
  below: string[];
  /** Raw private-identifier line counts per file, before the baseline. */
  counts: Record<string, number>;
}

export function parseBaseline(text: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('public boundary baseline is invalid JSON', { cause: err });
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) => key !== 'files') ||
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    !Object.entries(files).every(([file, count]) => file.length > 0 && Number.isInteger(count) && (count as number) > 0)
  ) {
    throw new Error('public boundary baseline has an invalid schema');
  }
  return { files: files as Record<string, number> };
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

function readBlob(root: string, objectId: string, env: NodeJS.ProcessEnv): string {
  const blob = runGit(['cat-file', 'blob', objectId], root, env);
  if (blob.status !== 0) throw new Error('public boundary baseline object could not be read');
  return blob.stdout;
}

// Same environment as trackedInputs: a partial commit's temporary index is
// what will be committed, so the baseline must come from it too.
function readIndexBaseline(root: string): string | null {
  const listed = runGit(['ls-files', '--stage', '--', DEFAULT_BASELINE_RELATIVE], root, process.env);
  if (listed.status !== 0) throw new Error('public boundary baseline could not be read from the index');
  const objectId = /^\d+ ([0-9a-f]+) 0\t/m.exec(listed.stdout)?.[1];
  return objectId ? readBlob(root, objectId, process.env) : null;
}

function readWorktreeBaseline(root: string): string | null {
  try {
    return fs.readFileSync(path.join(root, DEFAULT_BASELINE_RELATIVE), 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw new Error('public boundary baseline is unreadable', { cause: err });
  }
}

function branchHistoryHasBaseline(root: string): boolean {
  const env = repositoryNeutralEnv();
  const head = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], root, env);
  if (head.status === 1) return false;
  if (head.status !== 0) throw new Error('public boundary baseline history could not be read');
  const touched = runGit(['rev-list', '-1', 'HEAD', '--', DEFAULT_BASELINE_RELATIVE], root, env);
  if (touched.status !== 0) throw new Error('public boundary baseline history could not be read');
  return touched.stdout.trim() !== '';
}

const MERGED_BASELINE_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main'];

// Only a committed, merged revision: a working copy or unpushed commit
// anywhere on the host must not be able to exempt what this branch publishes.
function readMergedBaseline(root: string): string | null {
  const env = repositoryNeutralEnv();
  for (const ref of MERGED_BASELINE_REFS) {
    const resolved = runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, env);
    if (resolved.status === 1) continue;
    if (resolved.status !== 0) throw new Error('public boundary merged baseline could not be resolved');
    const listed = runGit(['ls-tree', resolved.stdout.trim(), '--', DEFAULT_BASELINE_RELATIVE], root, env);
    if (listed.status !== 0) throw new Error('public boundary merged baseline could not be read');
    const objectId = /^\d+ blob ([0-9a-f]+)\t/m.exec(listed.stdout)?.[1];
    if (objectId) return readBlob(root, objectId, env);
  }
  return null;
}

/**
 * Explicit --baseline wins and must exist. Otherwise the scanned tree's own
 * copy (its index for an index scan, since that is what will be committed).
 * A branch whose history carried the file and no longer does gets an empty
 * baseline: deleting it removes its exemptions. A branch cut before the file
 * existed inherits the copy merged on origin. Anything else holds nothing.
 */
function loadBaseline(options: ScanOptions): Baseline {
  if (options.baselinePath) {
    let text: string;
    try {
      text = fs.readFileSync(options.baselinePath, 'utf8');
    } catch (err) {
      throw new Error('public boundary baseline is missing or unreadable', { cause: err });
    }
    return parseBaseline(text);
  }
  const own = options.index ? readIndexBaseline(options.root) : readWorktreeBaseline(options.root);
  if (own !== null) return parseBaseline(own);
  if (branchHistoryHasBaseline(options.root)) return { files: {} };
  const merged = readMergedBaseline(options.root);
  return merged !== null ? parseBaseline(merged) : { files: {} };
}

export function applyBaseline(
  findings: Finding[],
  baseline: Baseline,
): { findings: Finding[]; outcome: BaselineOutcome } {
  // Null prototype: a tracked file named like an Object.prototype key must count from zero.
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const finding of findings) {
    if (finding.category === 'private-identifier') counts[finding.file] = (counts[finding.file] ?? 0) + 1;
  }
  const outcome: BaselineOutcome = { held: 0, heldFiles: 0, exceeded: [], below: [], counts };
  const heldFiles = new Set<string>();
  for (const [file, count] of Object.entries(counts)) {
    const recorded = Object.hasOwn(baseline.files, file) ? baseline.files[file] : 0;
    if (count > recorded) {
      outcome.exceeded.push({ file, count, recorded });
      continue;
    }
    heldFiles.add(file);
    outcome.held += count;
    if (count < recorded) outcome.below.push(file);
  }
  for (const file of Object.keys(baseline.files)) {
    if (!Object.hasOwn(counts, file)) outcome.below.push(file);
  }
  outcome.heldFiles = heldFiles.size;
  outcome.exceeded.sort((a, b) => a.file.localeCompare(b.file));
  outcome.below.sort();
  return {
    findings: findings.filter((finding) => finding.category !== 'private-identifier' || !heldFiles.has(finding.file)),
    outcome,
  };
}

const EMPTY_BASELINE_OUTCOME: BaselineOutcome = { held: 0, heldFiles: 0, exceeded: [], below: [], counts: {} };

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

function commitMessageInput(messagePath: string, rawMode: boolean): ScanInput {
  const raw = fs.readFileSync(messagePath, 'utf8');
  if (rawMode) return { file: path.basename(messagePath), content: Buffer.from(raw, 'utf8') };
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
  let registryPathsTried: string[] = [];
  let identifiersPathsTried: string[] = [];
  let discoveryProblems: string[] = [];

  if (!options.portable) {
    const mainCheckoutRoot = findMainCheckoutRoot(options.root);
    const registry = resolveIdentifierSet(
      options.dbPath,
      options.root,
      mainCheckoutRoot,
      DEFAULT_DB_RELATIVE,
      (dbPath) => {
        const values = loadRegistryIdentifiers(dbPath);
        // Reset per attempt: only the install that supplies the names reports on them.
        discoveryProblems = [];
        const installRoot = installRootOf(dbPath);
        const remotes = publicRemotes(installRoot ? [options.root, installRoot] : [options.root]);
        for (const value of loadInstallIdentifiers(dbPath, remotes, discoveryProblems)) values.add(value);
        return values;
      },
    );
    registryOrigin = registry.origin;
    registryPathsTried = registry.attemptedPaths;
    for (const value of registry.identifiers) privateIdentifiers.add(value);

    const identifiers = resolveIdentifierSet(
      options.identifiersPath,
      options.root,
      mainCheckoutRoot,
      DEFAULT_IDENTIFIERS_RELATIVE,
      loadLocalIdentifiers,
    );
    identifiersOrigin = identifiers.origin;
    identifiersPathsTried = identifiers.attemptedPaths;
    for (const value of identifiers.identifiers) privateIdentifiers.add(value);
  }

  const mode: RunReport['mode'] = options.portable
    ? 'portable'
    : registryOrigin === 'none' && identifiersOrigin === 'none'
      ? 'structural-fallback'
      : 'install-aware';

  const allowlist = loadAllowlist(options.allowlistPath);
  const base = {
    mode,
    registryOrigin,
    identifiersOrigin,
    registryPathsTried,
    identifiersPathsTried,
    discoveryProblems: [...new Set(discoveryProblems)].sort(),
  };
  // A commit message is not a tracked path, so no baseline entry can hold it.
  if (options.messagePath) {
    const findings = scanInputs(
      [commitMessageInput(options.messagePath, options.messageRaw)],
      privateIdentifiers,
      allowlist,
    );
    return { ...base, findings, baseline: EMPTY_BASELINE_OUTCOME };
  }
  const scanned = scanInputs(trackedInputs(options.root, options.index), privateIdentifiers, allowlist);
  const { findings, outcome } = applyBaseline(scanned, loadBaseline(options));
  return { ...base, findings, baseline: outcome };
}

/**
 * Rewrite the baseline from the current scan. Without --accept-growth it only
 * ratchets down: each file keeps the lower of its recorded and current count,
 * and a file above its recorded count is refused rather than absorbed.
 */
export function writeBaseline(options: ScanOptions): { written: string; refused: string[] } {
  const report = runReport(options);
  if (report.mode !== 'install-aware' || report.registryOrigin === 'none' || report.identifiersOrigin === 'none') {
    throw new Error('--write-baseline requires both the install registry and the identifier inventory');
  }
  // Names missing from the scan would read as removed hits and erase their counts.
  if (report.discoveryProblems.length > 0) {
    throw new Error(
      `--write-baseline requires every install identifier source: ${report.discoveryProblems.join('; ')}`,
    );
  }
  const target = options.baselinePath ?? path.join(options.root, DEFAULT_BASELINE_RELATIVE);
  const recorded = loadBaseline(options).files;
  const next: Record<string, number> = {};
  const refused: string[] = [];
  for (const [file, count] of Object.entries(report.baseline.counts)) {
    const previous = Object.hasOwn(recorded, file) ? recorded[file] : 0;
    const kept = options.acceptGrowth ? count : Math.min(count, previous);
    if (count > previous && !options.acceptGrowth) refused.push(file);
    if (kept > 0) next[file] = kept;
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(target, `${JSON.stringify({ files: sorted }, null, 2)}\n`);
  return { written: target, refused: refused.sort() };
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

function describeMissingIdentifierSources(report: RunReport): string {
  const sources: string[] = [];
  if (report.registryOrigin === 'none') {
    sources.push(`missing install registry; registry paths tried: ${report.registryPathsTried.join(', ') || '(none)'}`);
  }
  if (report.identifiersOrigin === 'none') {
    sources.push(
      `missing identifier inventory; identifier inventory paths tried: ${report.identifiersPathsTried.join(', ') || '(none)'}`,
    );
  }
  return sources.join('; ');
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const options = resolveOptions(argv);
    if (options.writeBaseline) {
      const { written, refused } = writeBaseline(options);
      process.stdout.write(`public boundary baseline written: ${path.relative(options.root, written) || written}\n`);
      if (refused.length === 0) return 0;
      for (const file of refused) process.stderr.write(`${file} private-identifier count rose\n`);
      process.stderr.write(
        `public boundary baseline refused growth in ${refused.length} file(s); remove the new occurrences, or pass --accept-growth for a reviewed exception\n`,
      );
      return 1;
    }
    const report = runReport(options);
    const { findings } = report;
    const missingIdentifierSources =
      !options.portable && (report.registryOrigin === 'none' || report.identifiersOrigin === 'none');
    if (missingIdentifierSources) {
      const missing = describeMissingIdentifierSources(report);
      const coverage =
        report.mode === 'structural-fallback'
          ? `no identifier registry found; ${missing} — running structural-pattern checks only; real names and tenant identifiers will NOT be caught`
          : `install-aware checks are incomplete; ${missing}`;
      process.stderr.write(`WARNING: ${coverage}\n`);
      if ((options.index || options.messagePath) && !options.allowStructural) {
        process.stderr.write(
          'public boundary check failed: gating scans require both an install registry and identifier inventory; use --allow-structural only for read-only structural reporting\n',
        );
        return 1;
      }
    }
    if (report.discoveryProblems.length > 0) {
      process.stderr.write(
        `WARNING: install-aware checks are incomplete; ${report.discoveryProblems.join('; ')} — names from those sources will NOT be caught\n`,
      );
      // A message scan gates publication too: a tag annotation on an already
      // published commit is the only thing its push scans.
      if ((options.index || options.messagePath) && !options.allowStructural) {
        process.stderr.write(
          'public boundary check failed: gating scans require every install identifier source to be readable\n',
        );
        return 1;
      }
    }
    const scanned = options.messagePath ? 'commit message' : options.index ? 'index' : 'worktree';
    const { held, heldFiles, exceeded, below } = report.baseline;
    const heldNote =
      held > 0 ? `; ${held} pre-existing line(s) in ${heldFiles} file(s) held by ${DEFAULT_BASELINE_RELATIVE}` : '';
    const surface = `${scanned}, ${describeMode(report)}${heldNote}`;
    if (below.length > 0) {
      process.stdout.write(
        `${below.length} file(s) are below their baseline count; run with --write-baseline to ratchet it down\n`,
      );
    }
    if (findings.length === 0) {
      process.stdout.write(`public boundary check passed (${surface})\n`);
      return 0;
    }
    for (const finding of findings) {
      process.stderr.write(`${finding.file}:${finding.line} ${finding.category}\n`);
    }
    for (const { file, count, recorded } of exceeded) {
      if (recorded > 0) {
        process.stderr.write(`${file}: ${count} private-identifier line(s), above its baseline of ${recorded}\n`);
      }
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
