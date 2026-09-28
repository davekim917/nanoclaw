#!/usr/bin/env tsx
/**
 * Public repository boundary checker. Install-aware checks add identifiers derived from the local
 * registry and an ignored operator-maintained file. Findings intentionally omit the matched value.
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
  | 'forbidden-artifact-path'
  | 'unscannable-content'
  | 'unreadable-content';

export interface Finding {
  file: string;
  line: number;
  category: ScanCategory;
  /** A path match: no baseline holds it, and `file` has matching segments redacted in every finding for that path. */
  inPath?: true;
}

interface AllowlistEntry {
  path: string;
  value: string;
  reason: string;
}

interface ScanInput {
  file: string;
  /** Null: no content on this surface (deleted, or a submodule), though the path still publishes. */
  content: Buffer | null | 'unreadable';
}

export interface ScanOptions {
  root: string;
  index: boolean;
  portable: boolean;
  allowStructural: boolean;
  dbPath?: string;
  // Undefined: resolve the local default, then the main checkout's.
  identifiersPath?: string;
  // Undefined: the scanned surface's own copy (the index copy for an index scan).
  allowlistPath?: string;
  // Scan ONE text file (the commit-msg hook's message file): messages publish with the branch.
  messagePath?: string;
  // A committed message is history, not an editor buffer: scan its scissors and comment text too.
  messageRaw: boolean;
  baselinePath?: string;
  writeBaseline: boolean;
  acceptGrowth: boolean;
}

const DEFAULT_DB_RELATIVE = path.join('data', 'v2.db');
const DEFAULT_IDENTIFIERS_RELATIVE = path.join('.nanoclaw', 'public-boundary-identifiers');
const DEFAULT_BASELINE_RELATIVE = '.public-boundary-baseline.json';
const DEFAULT_ALLOWLIST_RELATIVE = '.public-boundary-allowlist.json';

// A repository name built only from these words names a kind of repository, not a client.
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
  'sandbox',
  'scratch',
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

// Short acronyms and words common in code and prose: a name matching one keeps the contextual match, not bare-word.
const COMMON_ACRONYMS = new Set([
  'ai',
  'am',
  'cd',
  'ci',
  'db',
  'dr',
  'go',
  'id',
  'io',
  'ip',
  'it',
  'js',
  'mr',
  'no',
  'ok',
  'os',
  'pm',
  'pr',
  'qa',
  'st',
  'ts',
  'ui',
  'us',
  'ux',
  'vm',
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
  // Common words that can also be channel names; the channel's platform ID stays banned.
  'commercial',
  'dbt cloud',
  'discord',
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
  // Slack's built-in bot and its platform ID: identical in every workspace, not install-specific.
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

const CONTEXT_WORDS =
  '(?:agent|client|customer|data|datafold|discord|group|slack|tenant|token|workspace|workgroup|[amw]g)';

interface IdentifierMatcher {
  identifier: string;
  /** Empty: the matcher cannot express this identifier, which discovery reports. */
  patterns: RegExp[];
  contextOnly: boolean;
  unicode: boolean;
}

function contextualPattern(identifier: string, word: string, flags: string): RegExp {
  const other = word === 'A-Za-z0-9' ? '[^A-Za-z0-9]' : `[^${word}]`;
  return new RegExp(
    `(^|${other})(?:${CONTEXT_WORDS}${other}{1,4}${identifier}|${identifier}${other}{1,4}${CONTEXT_WORDS})(?=$|${other})`,
    flags,
  );
}

// A short name always matches beside a context word, and as a case-exact bare word only when it is
// two or three letters with a capital: lowercase or with a digit, such a token is ordinary code.
function asciiPatterns(value: string): { patterns: RegExp[]; contextOnly: boolean } {
  const tokens = value.match(/[A-Za-z0-9]+/g) ?? [];
  if (tokens.length === 0) return { patterns: [], contextOnly: false };
  const normalizedLength = tokens.reduce((sum, token) => sum + token.length, 0);
  const common = COMMON_ACRONYMS.has(value.toLowerCase());
  // An all-caps three-letter name is a product or code name: match it as a bare word.
  if (/^[A-Z][A-Z0-9]{2}$/.test(value) && !common) {
    return { patterns: [new RegExp(`(^|[^A-Za-z0-9])${value}(?=$|[^A-Za-z0-9])`, 'gi')], contextOnly: false };
  }
  if (normalizedLength < 4) {
    const patterns = [contextualPattern(tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}'), 'A-Za-z0-9', 'gi')];
    const cased = /^[A-Za-z]{2,3}$/.test(value) && /[A-Z]/.test(value) && !common;
    if (cased) patterns.push(new RegExp(`(^|[^A-Za-z0-9])${value}(?=$|[^A-Za-z0-9])`, 'g'));
    return { patterns, contextOnly: !cased };
  }
  if (normalizedLength < 6) {
    return {
      patterns: [new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(value)}(?=$|[^A-Za-z0-9])`, 'gi')],
      contextOnly: false,
    };
  }
  return {
    patterns: [
      new RegExp(`(^|[^A-Za-z0-9])${tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}')}(?=$|[^A-Za-z0-9])`, 'gi'),
    ],
    contextOnly: false,
  };
}

const UNICODE_WORD = String.raw`\p{L}\p{N}\p{M}`;
// Scripts written without spaces between words: a name in one is found inside running text.
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// Non-ASCII: literal on NFC text, Unicode case-insensitive, plus any diacritic-free ASCII spelling.
function identifierMatcher(identifier: string): IdentifierMatcher {
  if (!/[^\p{ASCII}]/u.test(identifier)) return { identifier, ...asciiPatterns(identifier), unicode: false };
  const value = identifier.normalize('NFC');
  const tokens = value.match(new RegExp(`[${UNICODE_WORD}]+`, 'gu')) ?? [];
  if (tokens.length === 0) return { identifier, patterns: [], contextOnly: false, unicode: true };
  const joined = tokens.map(escapeRegex).join(`[^${UNICODE_WORD}]{0,4}`);
  const chars = [...tokens.join('')];
  const length = chars.length;
  let patterns: RegExp[];
  if (length < 2) {
    patterns = [contextualPattern(joined, UNICODE_WORD, 'giu')];
  } else {
    const first = chars[0] ?? '';
    const last = chars.at(-1) ?? '';
    const before = UNSPACED_SCRIPT.test(first) ? '()' : `(^|[^${UNICODE_WORD}])`;
    const after = UNSPACED_SCRIPT.test(last) ? '' : `(?=$|[^${UNICODE_WORD}])`;
    patterns = [new RegExp(`${before}${joined}${after}`, 'giu')];
  }
  const folded = value.normalize('NFD').replace(/\p{M}/gu, '');
  const ascii = folded !== value && !/[^\p{ASCII}]/u.test(folded) ? asciiPatterns(folded) : null;
  if (ascii) patterns.push(...ascii.patterns);
  return { identifier, patterns, contextOnly: length < 2 && (ascii?.contextOnly ?? true), unicode: true };
}

function addIdentifier(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim().replace(/^#/, '');
  if (!trimmed || GENERIC_IDENTIFIERS.has(trimmed.toLowerCase())) return;
  target.add(trimmed);
  for (const platformId of trimmed.match(/[CDGUWT][A-Z0-9]{8,}|\d{17,20}/g) ?? []) {
    if (GENERIC_IDENTIFIERS.has(platformId.toLowerCase())) continue;
    target.add(platformId);
  }
}

// SELECT * rather than naming columns: a column an older or newer schema lacks costs only that column.
const REGISTRY_COLUMNS: Record<string, string[]> = {
  workgroups: ['id', 'display_name'],
  agent_groups: ['id', 'name', 'folder', 'workgroup_id'],
  messaging_groups: ['id', 'platform_id', 'instance', 'name'],
  users: ['id', 'display_name'],
  container_configs: ['assistant_name'],
};

export function loadRegistryIdentifiers(dbPath: string): Set<string> {
  if (!fs.existsSync(dbPath)) throw new Error('install registry is missing');
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error('install registry is unreadable', { cause: err });
  }

  const identifiers = new Set<string>();
  try {
    for (const [table, columns] of Object.entries(REGISTRY_COLUMNS)) {
      let rows: Record<string, unknown>[];
      try {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE")
          .get(table);
        if (!exists) continue;
        rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      } catch (err) {
        throw new Error('install registry is unreadable', { cause: err });
      }
      for (const row of rows) {
        // system:* ids are constants in tracked host scripts, not install-private.
        if (table === 'users' && /^system:/i.test(String(row.id))) continue;
        for (const column of columns) addIdentifier(identifiers, row[column]);
      }
    }
  } finally {
    db.close();
  }
  if (identifiers.size === 0) throw new Error('install registry contained no usable identifiers');
  return identifiers;
}

export type ParsedRemote =
  | { kind: 'network'; host: string; owner: string; repo: string; key: string }
  | { kind: 'local' }
  | { kind: 'unsupported' };

// The only network shapes the repository store uses. A name never starts with
// a dot, so `.` and `..` segments cannot hide the repository git reaches.
const REMOTE_HOST = String.raw`[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`;
const REMOTE_NAME = String.raw`[A-Za-z0-9_-][A-Za-z0-9._-]*`;
const NETWORK_REMOTES = [
  new RegExp(`^https://(${REMOTE_HOST})/(${REMOTE_NAME})/(${REMOTE_NAME})$`),
  new RegExp(`^git@(${REMOTE_HOST}):(${REMOTE_NAME})/(${REMOTE_NAME})$`),
];

/** The key is case-folded only on github.com, whose paths are case-insensitive. */
export function parseRemote(url: string): ParsedRemote {
  const trimmed = url.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('file://')) return { kind: 'local' };
  const match = NETWORK_REMOTES.map((pattern) => pattern.exec(trimmed)).find(Boolean);
  if (!match) return { kind: 'unsupported' };
  const [, rawHost, owner, rawRepo] = match;
  const host = rawHost.toLowerCase();
  const repo = rawRepo.replace(/\.git$/, '');
  const repoPath = `${owner}/${repo}`;
  return {
    kind: 'network',
    host,
    owner,
    repo,
    key: `${host}/${host === 'github.com' ? repoPath.toLowerCase() : repoPath}`,
  };
}

// A hook exports its own repository's GIT_DIR and friends; left in place they
// would make a lookup in another checkout read the committing repository.
const REPOSITORY_SELECTION_ENV =
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/;

function repositoryNeutralEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_SELECTION_ENV.test(key)));
}

type RemoteUrl = { kind: 'url'; url: string } | { kind: 'absent' } | { kind: 'unreadable' };

// Git resolves its own config (includes, insteadOf); never parse it. Exit 2 is "no such remote";
// anything else is unknown.
function remoteUrl(dir: string, name: string, env: NodeJS.ProcessEnv): RemoteUrl {
  const result = runGit(['remote', 'get-url', name], dir, env);
  if (result.status === 0 && result.stdout.trim()) return { kind: 'url', url: result.stdout.trim() };
  return result.status === 2 ? { kind: 'absent' } : { kind: 'unreadable' };
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
  const env = repositoryNeutralEnv();
  for (const root of roots) {
    const names = runGit(['remote'], root, env);
    if (names.status !== 0) continue;
    for (const name of names.stdout.split('\n').filter(Boolean)) {
      const lookup = remoteUrl(root, name, env);
      const parsed = lookup.kind === 'url' ? parseRemote(lookup.url) : null;
      if (parsed?.kind !== 'network') continue;
      remotes.owners.add(parsed.owner.toLowerCase());
      remotes.repositories.add(parsed.key);
    }
  }
  return remotes;
}

/** Only for the `<install>/data/<db>` layout: a registry elsewhere names no checkout. */
function installRootOf(dbPath: string): string | null {
  const dataDir = path.dirname(path.resolve(dbPath));
  return path.basename(dataDir) === 'data' ? path.dirname(dataDir) : null;
}

function isGenericRepositoryName(name: string): boolean {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.every((word) => GENERIC_REPOSITORY_WORDS.has(word));
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

type SourceRead<T> = { ok: true; value: T } | { ok: false; absent: boolean };

function isMissingPath(err: unknown): boolean {
  return errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR';
}

// Absent is fine; any other failure means a source's names are unknown and discovery is incomplete.
function readSource<T>(read: () => T): SourceRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    return { ok: false, absent: isMissingPath(err) };
  }
}

function listSource(dir: string, problems: string[], what: string): string[] {
  const listed = readSource(() => fs.readdirSync(dir));
  if (listed.ok) return listed.value;
  if (!listed.absent) problems.push(`${what} could not be listed`);
  return [];
}

// An unreadable source is recorded in `problems`, never by name.
export function loadInstallIdentifiers(dbPath: string, remotes: PublicRemotes, problems: string[]): Set<string> {
  const identifiers = new Set<string>();
  const installRoot = installRootOf(dbPath);
  if (!installRoot) return identifiers;
  const groupsDir = path.join(installRoot, 'groups');
  for (const folder of listSource(groupsDir, problems, 'the groups directory')) {
    const config = readSource(() => {
      const parsed = JSON.parse(fs.readFileSync(path.join(groupsDir, folder, 'container.json'), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a config object');
      const persona = (parsed as Record<string, unknown>).assistantName;
      if (persona !== undefined && (typeof persona !== 'string' || !persona.trim()))
        throw new Error('assistantName is not a non-empty string');
      return persona;
    });
    if (!config.ok) {
      if (!config.absent) problems.push('a group container.json could not be read or parsed');
      continue;
    }
    addIdentifier(identifiers, config.value);
  }

  const repositoriesDir = path.join(installRoot, 'data', 'repositories');
  for (const workgroup of listSource(repositoriesDir, problems, 'the repository store')) {
    for (const name of listSource(path.join(repositoriesDir, workgroup), problems, 'a repository directory')) {
      const clone = path.join(repositoriesDir, workgroup, name);
      const isClone = readSource(() => fs.lstatSync(path.join(clone, '.git')));
      if (!isClone.ok) {
        if (!isClone.absent) problems.push('a cloned repository could not be read');
        continue;
      }
      // Without the ceiling, a clone whose .git vanished answers for the enclosing checkout.
      const origin = remoteUrl(clone, 'origin', {
        ...repositoryNeutralEnv(),
        GIT_CEILING_DIRECTORIES: path.dirname(clone),
      });
      if (origin.kind === 'unreadable') {
        problems.push('a cloned repository configuration could not be read');
        continue;
      }
      const parsed = origin.kind === 'url' ? parseRemote(origin.url) : null;
      if (parsed?.kind === 'unsupported') {
        problems.push('a cloned repository origin could not be interpreted');
        continue;
      }
      // A local-only canonical (no origin, or a local one) is named by its canonical directory.
      if (parsed?.kind !== 'network') {
        if (!isGenericRepositoryName(name)) addIdentifier(identifiers, name);
        continue;
      }
      if (!remotes.owners.has(parsed.owner.toLowerCase()) && !isGenericRepositoryName(parsed.owner))
        addIdentifier(identifiers, parsed.owner);
      if (!remotes.repositories.has(parsed.key) && !isGenericRepositoryName(parsed.repo))
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

// An explicit path must exist. The surface's own copy may be absent, which exempts nothing.
function loadAllowlist(options: ScanOptions): AllowlistEntry[] {
  let text: string | null;
  if (options.allowlistPath !== undefined) {
    try {
      text = fs.readFileSync(options.allowlistPath, 'utf8');
    } catch (err) {
      throw new Error('public boundary allowlist is missing or unreadable', { cause: err });
    }
  } else {
    text = readSurfaceFile(options, DEFAULT_ALLOWLIST_RELATIVE, 'public boundary allowlist');
  }
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('public boundary allowlist is invalid JSON', { cause: err });
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
  return file === DEFAULT_ALLOWLIST_RELATIVE && allowlist.some((entry) => entry.value === value);
}

function lineLocator(text: string): (offset: number) => number {
  let starts: number[] | null = null;
  return (offset) => {
    if (!starts) {
      starts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    }
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// Content that is neither NUL-free nor BOM-marked UTF-16 passes unscanned only under one of these extensions.
const BINARY_EXTENSIONS = new Set([
  '7z',
  'a',
  'avif',
  'bin',
  'bmp',
  'bz2',
  'class',
  'dll',
  'dylib',
  'eot',
  'exe',
  'flac',
  'gif',
  'gz',
  'heic',
  'ico',
  'jar',
  'jpeg',
  'jpg',
  'm4a',
  'mov',
  'mp3',
  'mp4',
  'o',
  'ogg',
  'otf',
  'pdf',
  'png',
  'psd',
  'pyc',
  'rar',
  'so',
  'tar',
  'tgz',
  'tif',
  'tiff',
  'ttf',
  'wasm',
  'wav',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xz',
  'zip',
  'zst',
]);

type DecodedContent = { kind: 'text'; text: string } | { kind: 'binary' } | { kind: 'unscannable' };

function decodeUtf16(body: Buffer, bigEndian: boolean): string | null {
  if (body.length % 2 !== 0) return null;
  const text = (bigEndian ? Buffer.from(body).swap16() : body).toString('utf16le');
  // A U+0000 left after decoding is UTF-32 or binary read as UTF-16.
  return text.includes('\0') ? null : text;
}

function decodeContent(file: string, content: Buffer): DecodedContent {
  const bom = content.length >= 2 ? content.readUInt16BE(0) : 0;
  if (bom === 0xfffe || bom === 0xfeff) {
    const text = decodeUtf16(content.subarray(2), bom === 0xfeff);
    if (text !== null) return { kind: 'text', text };
  } else if (!content.includes(0)) {
    return { kind: 'text', text: content.toString('utf8') };
  }
  const extension = path.extname(file).slice(1).toLowerCase();
  return BINARY_EXTENSIONS.has(extension) ? { kind: 'binary' } : { kind: 'unscannable' };
}

interface Match {
  line: number;
  category: ScanCategory;
  start: number;
  end: number;
}

function findMatches(
  file: string,
  text: string,
  identifierText: string,
  matchers: IdentifierMatcher[],
  allowlist: AllowlistEntry[],
): Match[] {
  const matches: Match[] = [];
  const textLine = lineLocator(text);
  const identifierLine = identifierText === text ? textLine : lineLocator(identifierText);
  for (const rule of STRUCTURAL_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (
        rule.synthetic(value) ||
        isAllowed(file, value, allowlist) ||
        isSerializedAllowlistValue(file, value, allowlist)
      )
        continue;
      matches.push({
        line: textLine(match.index),
        category: rule.category,
        start: match.index,
        end: match.index + value.length,
      });
    }
  }
  for (const { identifier, patterns } of matchers) {
    // The allowlist file itself holds allowlisted values; any other identifier in it still flags.
    if (isAllowed(file, identifier, allowlist) || isSerializedAllowlistValue(file, identifier, allowlist)) continue;
    for (const pattern of patterns) {
      // Every matching line: the baseline ratchet counts lines.
      for (const match of identifierText.matchAll(pattern)) {
        const start = match.index + (match[1]?.length ?? 0);
        matches.push({
          line: identifierLine(start),
          category: 'private-identifier',
          start,
          end: match.index + match[0].length,
        });
      }
    }
  }
  return matches;
}

function redactPath(file: string, matches: Match[]): string {
  let offset = 0;
  return file
    .split('/')
    .map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return matches.some((match) => match.start < start + segment.length && match.end > start)
        ? '<redacted>'
        : segment;
    })
    .join('/');
}

export function scanInputs(
  inputs: ScanInput[],
  privateIdentifiers: Set<string>,
  allowlist: AllowlistEntry[],
): Finding[] {
  const findings = new Map<string, Finding>();
  const addFinding = (finding: Finding): void => {
    const key = [finding.file, finding.line, finding.category, finding.inPath ?? ''].join('\0');
    if (!findings.has(key)) findings.set(key, finding);
  };
  const matchers = [...privateIdentifiers].map(identifierMatcher);
  const normalize = matchers.some((matcher) => matcher.unicode);
  const forIdentifiers = (text: string): string => (normalize ? text.normalize('NFC') : text);
  for (const input of inputs) {
    const pathText = forIdentifiers(input.file);
    const pathMatches = findMatches(input.file, pathText, pathText, matchers, allowlist);
    const file = pathMatches.length > 0 ? redactPath(pathText, pathMatches) : input.file;
    for (const match of pathMatches) addFinding({ file, line: 0, category: match.category, inPath: true });

    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(input.file))) {
      addFinding({ file, line: 1, category: 'forbidden-artifact-path' });
    }
    if (input.content === null) continue;
    if (input.content === 'unreadable') {
      addFinding({ file, line: 1, category: 'unreadable-content' });
      continue;
    }
    const decoded = decodeContent(input.file, input.content);
    if (decoded.kind === 'binary') continue;
    if (decoded.kind === 'unscannable') {
      addFinding({ file, line: 1, category: 'unscannable-content' });
      continue;
    }
    for (const match of findMatches(input.file, decoded.text, forIdentifiers(decoded.text), matchers, allowlist)) {
      addFinding({ file, line: match.line, category: match.category });
    }
  }
  return [...findings.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.category.localeCompare(b.category),
  );
}

const GITLINK_MODE = '160000';
// One read of every index blob; a tree past this reads as unreadable rather than partly scanned.
const MAX_INDEX_BYTES = 1024 * 1024 * 1024;

// A replacement ref would substitute an object that commit and push still publish as the original.
function originalObjectsEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
}

interface IndexEntry {
  mode: string;
  oid: string;
  /** False for a conflicted path, which has no single blob to commit. */
  merged: boolean;
}

function indexEntries(root: string): Map<string, IndexEntry> {
  const listed = execFileSync('git', ['ls-files', '-z', '--stage'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = new Map<string, IndexEntry>();
  for (const record of listed.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/s.exec(record);
    if (!match) throw new Error('the tracked file list could not be parsed');
    const [, mode, oid, stage, file] = match;
    entries.set(file, { mode, oid, merged: stage === '0' });
  }
  return entries;
}

// An object git reports missing, or output that cannot be parsed, leaves that blob out of the map.
function readIndexBlobs(root: string, oids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  if (oids.length === 0) return blobs;
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    env: originalObjectsEnv(),
    input: `${oids.join('\n')}\n`,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: MAX_INDEX_BYTES,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) return blobs;
  const out = result.stdout;
  let at = 0;
  for (const oid of oids) {
    const headerEnd = out.indexOf(10, at);
    if (headerEnd === -1) break;
    const header = /^(\S+) (?:missing|(\S+) (\d+))$/.exec(out.toString('utf8', at, headerEnd));
    if (header?.[1] !== oid) break;
    if (header[3] === undefined) {
      at = headerEnd + 1;
      continue;
    }
    const end = headerEnd + 1 + Number(header[3]);
    if (end >= out.length || out[end] !== 10) break;
    if (header[2] === 'blob') blobs.set(oid, out.subarray(headerEnd + 1, end));
    at = end + 1;
  }
  return blobs;
}

function worktreeContent(root: string, file: string): Buffer | null | 'unreadable' {
  const full = path.join(root, file);
  try {
    // A symlink publishes its target text, which is what git stores as its blob.
    return fs.lstatSync(full).isSymbolicLink() ? fs.readlinkSync(full, { encoding: 'buffer' }) : fs.readFileSync(full);
  } catch (err) {
    return isMissingPath(err) ? null : 'unreadable';
  }
}

function trackedInputs(root: string, index: boolean): ScanInput[] {
  const entries = indexEntries(root);
  const wanted = [...entries.values()].filter((entry) => entry.merged && entry.mode !== GITLINK_MODE);
  const blobs = index ? readIndexBlobs(root, [...new Set(wanted.map((entry) => entry.oid))]) : null;
  return [...entries].map(([file, entry]) => {
    if (entry.mode === GITLINK_MODE) return { file, content: null };
    if (!blobs) return { file, content: worktreeContent(root, file) };
    return { file, content: (entry.merged && blobs.get(entry.oid)) || 'unreadable' };
  });
}

export function resolveOptions(argv: string[], cwd = process.cwd()): ScanOptions {
  const options: ScanOptions = {
    root: cwd,
    index: false,
    portable: false,
    allowStructural: false,
    messageRaw: false,
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
  if (options.allowlistPath === '') throw new Error('--allowlist requires a path');
  if (options.acceptGrowth && !options.writeBaseline) throw new Error('--accept-growth requires --write-baseline');
  if (options.writeBaseline && (options.messagePath || options.portable))
    throw new Error('--write-baseline scans the tracked tree with install identifiers');
  options.root = path.resolve(options.root);
  if (options.messagePath) options.messagePath = path.resolve(options.root, options.messagePath);
  if (options.identifiersPath !== undefined)
    options.identifiersPath = path.resolve(options.root, options.identifiersPath);
  if (options.allowlistPath) options.allowlistPath = path.resolve(options.root, options.allowlistPath);
  if (options.dbPath) options.dbPath = path.resolve(options.root, options.dbPath);
  if (options.baselinePath) options.baselinePath = path.resolve(options.root, options.baselinePath);
  return options;
}

type IdentifierOrigin = 'explicit' | 'local' | 'main-checkout' | 'none';

// Null (never throws) on git failure or when this root already IS the main checkout.
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

// A bad explicit path throws; a missing or broken default is a soft miss (origin 'none'). A linked
// worktree reads only the main checkout's copy: its own (a stub, or a file force-added to a pushed
// snapshot) must never stand in for the install's.
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
  const attemptedPaths = [path.join(mainCheckoutRoot ?? root, defaultRelative)];
  try {
    return {
      identifiers: loader(attemptedPaths[0]),
      origin: mainCheckoutRoot ? 'main-checkout' : 'local',
      attemptedPaths,
    };
  } catch {
    return { identifiers: new Set(), origin: 'none', attemptedPaths };
  }
}

export interface RunReport {
  findings: Finding[];
  mode: 'portable' | 'install-aware' | 'structural-fallback';
  registryOrigin: IdentifierOrigin | 'skipped';
  identifiersOrigin: IdentifierOrigin | 'skipped';
  registryPathsTried: string[];
  identifiersPathsTried: string[];
  baseline: BaselineOutcome;
  /** Identifier sources that exist but could not be read, or names the matcher cannot express. */
  discoveryProblems: string[];
  contextOnlyIdentifiers: number;
}

/** Per-file private-identifier line counts, never values; a file absent from it may hold none. */
export interface Baseline {
  files: Record<string, number>;
}

export interface BaselineOutcome {
  held: number;
  heldFiles: number;
  /** Files whose count rose above their recorded count; their findings stay reported. */
  exceeded: Array<{ file: string; count: number; recorded: number }>;
  below: string[];
  counts: Record<string, number>;
  /** The scanned tree carries no committed baseline, so nothing was held. */
  missing: boolean;
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

// A killed git has status null, which every caller reads as a failure.
const GIT_TIMEOUT_MS = 30_000;

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

// From the index a partial commit will commit. Only the exact path as a regular stage-0 file is
// policy: a directory, symlink, or another spelling grants nothing.
function readIndexFile(root: string, relative: string, what: string): string | null {
  const env: NodeJS.ProcessEnv = { ...originalObjectsEnv(), GIT_LITERAL_PATHSPECS: '1' };
  delete env.GIT_ICASE_PATHSPECS;
  delete env.GIT_GLOB_PATHSPECS;
  delete env.GIT_NOGLOB_PATHSPECS;
  const listed = runGit(['ls-files', '-z', '--stage', '--', relative], root, env);
  if (listed.status !== 0) throw new Error(`${what} could not be read from the index`);
  const entry = listed.stdout
    .split('\0')
    .map((line) => /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(line))
    .find((match) => match?.[4] === relative);
  if (!entry) return null;
  if (entry[1] !== '100644' || entry[3] !== '0') throw new Error(`${what} is not a regular file in the index`);
  const blob = runGit(['cat-file', 'blob', entry[2]], root, env);
  if (blob.status !== 0) throw new Error(`${what} object could not be read`);
  return blob.stdout;
}

function readWorktreeFile(root: string, relative: string, what: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(path.join(root, relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw new Error(`${what} is unreadable or a symlink`, { cause: err });
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${what} is not a regular file`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readSurfaceFile(options: ScanOptions, relative: string, what: string): string | null {
  return options.index ? readIndexFile(options.root, relative, what) : readWorktreeFile(options.root, relative, what);
}

// Explicit --baseline must exist. A tree without its own copy borrows nothing, so every
// private-identifier line it holds fails.
function loadBaseline(options: ScanOptions): Baseline | null {
  if (options.baselinePath) {
    let text: string;
    try {
      text = fs.readFileSync(options.baselinePath, 'utf8');
    } catch (err) {
      throw new Error('public boundary baseline is missing or unreadable', { cause: err });
    }
    return parseBaseline(text);
  }
  const own = readSurfaceFile(options, DEFAULT_BASELINE_RELATIVE, 'public boundary baseline');
  return own === null ? null : parseBaseline(own);
}

export function applyBaseline(
  findings: Finding[],
  baseline: Baseline,
): { findings: Finding[]; outcome: BaselineOutcome } {
  // Null prototype: a tracked file named like an Object.prototype key must count from zero.
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  const held = (finding: Finding): boolean => finding.category === 'private-identifier' && !finding.inPath;
  for (const finding of findings) {
    if (held(finding)) counts[finding.file] = (counts[finding.file] ?? 0) + 1;
  }
  const outcome: BaselineOutcome = { held: 0, heldFiles: 0, exceeded: [], below: [], counts, missing: false };
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
    findings: findings.filter((finding) => !held(finding) || !heldFiles.has(finding.file)),
    outcome,
  };
}

const EMPTY_BASELINE_OUTCOME: BaselineOutcome = {
  held: 0,
  heldFiles: 0,
  exceeded: [],
  below: [],
  counts: {},
  missing: false,
};

/**
 * Git strips `#` lines only on the EDITOR path: `-m`/`-F` keep them verbatim, so blanking every
 * `#` line is fail-open, while scanning git's own template (branch name, staged paths) blocks
 * routine commits. The hook sees only the file, so the template is inferred narrowly: scissors
 * must be git's exact line, and only a CONTIGUOUS TRAILING comment block containing a bare `#`
 * line is blanked. Accepted residual fail-open: a `-m` body that reproduces that trailing-block
 * shape escapes the scan, because scanning git's template instead blocks routine commits. Blanking,
 * not removing, keeps line numbers matching the author's editor.
 */
const GIT_SCISSORS = /^# -{24} >8 -{24}$/m;
const GIT_BARE_COMMENT = /^#[ \t]*$/;

function commitMessageInput(messagePath: string, rawMode: boolean): ScanInput {
  const raw = fs.readFileSync(messagePath, 'utf8');
  if (rawMode) return { file: path.basename(messagePath), content: Buffer.from(raw, 'utf8') };
  // Git discards everything below the scissors; pre-commit gates that diff under its real filenames.
  const scissors = raw.search(GIT_SCISSORS);
  const lines = (scissors === -1 ? raw : raw.slice(0, scissors)).split('\n');

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
  const discoveryProblems: string[] = [];

  if (!options.portable) {
    const mainCheckoutRoot = findMainCheckoutRoot(options.root);
    const registry = resolveIdentifierSet(
      options.dbPath,
      options.root,
      mainCheckoutRoot,
      DEFAULT_DB_RELATIVE,
      (dbPath) => {
        const values = loadRegistryIdentifiers(dbPath);
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

  const matchers = [...privateIdentifiers].map(identifierMatcher);
  const inexpressible = matchers.filter((matcher) => matcher.patterns.length === 0).length;
  if (inexpressible > 0) {
    discoveryProblems.push(
      `${inexpressible} loaded identifier(s) have no letter or digit the matcher can express; remove them or add a letter or digit`,
    );
  }
  const allowlist = loadAllowlist(options);
  const base = {
    mode,
    registryOrigin,
    identifiersOrigin,
    registryPathsTried,
    identifiersPathsTried,
    discoveryProblems: [...new Set(discoveryProblems)].sort(),
    contextOnlyIdentifiers: matchers.filter((matcher) => matcher.contextOnly).length,
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
  const baseline = loadBaseline(options);
  const { findings, outcome } = applyBaseline(scanned, baseline ?? { files: {} });
  outcome.missing = baseline === null;
  return { ...base, findings, baseline: outcome };
}

/** Without --accept-growth it only ratchets down; a file above its count is refused, not absorbed. */
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
  if (report.findings.some((finding) => finding.inPath)) {
    throw new Error('--write-baseline refuses while a tracked path matches; rename it first');
  }
  if (report.findings.some((f) => f.category === 'unscannable-content' || f.category === 'unreadable-content')) {
    throw new Error('--write-baseline refuses while a tracked file cannot be scanned; its count would read as removed');
  }
  const target = options.baselinePath ?? path.join(options.root, DEFAULT_BASELINE_RELATIVE);
  const recorded = loadBaseline(options)?.files ?? {};
  const next: Record<string, number> = Object.create(null) as Record<string, number>;
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
      // A message scan gates publication too (a tag annotation is all its push scans).
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
    if (report.contextOnlyIdentifiers > 0) {
      process.stdout.write(
        `note: ${report.contextOnlyIdentifiers} short identifier(s) match only beside a context word (agent, slack, workspace, …)\n`,
      );
    }
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
      const where = finding.inPath ? `${finding.file} (path)` : `${finding.file}:${finding.line}`;
      process.stderr.write(`${where} ${finding.category}\n`);
    }
    if (findings.some((finding) => finding.category === 'unscannable-content')) {
      process.stderr.write(
        'unscannable-content: a NUL byte without a UTF-16 BOM; escape the NUL or re-encode the file, or give a binary file a binary extension\n',
      );
    }
    if (findings.some((finding) => finding.category === 'unreadable-content')) {
      process.stderr.write(
        'unreadable-content: a tracked file or its index object could not be read (permissions, I/O, a conflicted path); fix it and rerun\n',
      );
    }
    for (const { file, count, recorded } of exceeded) {
      if (recorded > 0) {
        process.stderr.write(`${file}: ${count} private-identifier line(s), above its baseline of ${recorded}\n`);
      }
    }
    if (report.baseline.missing && exceeded.length > 0) {
      process.stderr.write(
        `this tree has no committed ${DEFAULT_BASELINE_RELATIVE}, so no pre-existing line is held; a branch cut before it landed must rebase onto origin/main\n`,
      );
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
