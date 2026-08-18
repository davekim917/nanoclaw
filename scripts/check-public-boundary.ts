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
  identifiersPath: string;
  allowlistPath: string;
}

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
      /ALLOWED|CHANNEL|COLLIDE|DEST|EXAMPLE|FIXTURE|OTHER|PROJECT|TARGET|TEAM|TEST|UNKNOWN|USER|WORKSPACE/i.test(
        value,
      ),
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
  return new RegExp(
    `(^|[^A-Za-z0-9])${tokens.map(escapeRegex).join('[^A-Za-z0-9]{0,4}')}(?=$|[^A-Za-z0-9])`,
    'i',
  );
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
  return (
    path.basename(file) === '.public-boundary-allowlist.json' &&
    allowlist.some((entry) => entry.value === value)
  );
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
        existing.file === finding.file &&
        existing.line === finding.line &&
        existing.category === finding.category,
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
      if (isAllowed(input.file, identifier, allowlist)) continue;
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
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
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
    identifiersPath: '.nanoclaw/public-boundary-identifiers',
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
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.root) throw new Error('--root requires a path');
  options.root = path.resolve(options.root);
  options.identifiersPath = path.resolve(options.root, options.identifiersPath);
  options.allowlistPath = path.resolve(options.root, options.allowlistPath);
  if (options.dbPath) options.dbPath = path.resolve(options.root, options.dbPath);
  return options;
}

export function run(options: ScanOptions): Finding[] {
  const installMarker = fs.existsSync(path.join(options.root, 'data', 'v2.db'));
  const installAware = !options.portable && (options.dbPath !== undefined || installMarker);
  const privateIdentifiers = new Set<string>();
  if (installAware) {
    const dbPath = options.dbPath ?? path.join(options.root, 'data', 'v2.db');
    for (const value of loadRegistryIdentifiers(dbPath)) privateIdentifiers.add(value);
    for (const value of loadLocalIdentifiers(options.identifiersPath)) privateIdentifiers.add(value);
  }
  return scanInputs(trackedInputs(options.root, options.index), privateIdentifiers, loadAllowlist(options.allowlistPath));
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const options = resolveOptions(argv);
    const findings = run(options);
    if (findings.length === 0) {
      process.stdout.write(`public boundary check passed (${options.index ? 'index' : 'worktree'})\n`);
      return 0;
    }
    for (const finding of findings) {
      process.stderr.write(`${finding.file}:${finding.line} ${finding.category}\n`);
    }
    process.stderr.write(`public boundary check failed with ${findings.length} redacted finding(s)\n`);
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
