import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { safeGitArgs, safeGitEnv } from '../safe-git.js';
import { digest } from './policy.js';

export interface Replacement {
  path: string;
  replacementMarkdown: string;
  sourceLocators: string[];
}
export function replacements(value: unknown): Replacement[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
  )
    throw new Error('Invalid candidate size');
  const seen = new Set<string>();
  for (const item of value as Replacement[]) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      !/^domain\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(item.path) ||
      seen.has(item.path) ||
      typeof item.replacementMarkdown !== 'string' ||
      !item.replacementMarkdown.trim() ||
      item.replacementMarkdown.includes('\0') ||
      Buffer.byteLength(item.replacementMarkdown) > 256 * 1024 ||
      !Array.isArray(item.sourceLocators) ||
      !item.sourceLocators.length ||
      item.sourceLocators.length > 8 ||
      item.sourceLocators.some((url) => typeof url !== 'string' || url.length > 2048)
    )
      throw new Error('Invalid candidate replacement');
    seen.add(item.path);
  }
  return value as Replacement[];
}

/** A host-created, host-only repository. No container Git configuration is imported. */
export class WikiGit {
  constructor(
    readonly cwd: string,
    readonly remote: string,
    readonly ref: string,
    readonly remoteEnv: () => Promise<NodeJS.ProcessEnv>,
    readonly hooksDirectory: () => string,
  ) {}

  async git(args: string[], remote = false, input?: string, authorizePush?: () => void): Promise<string> {
    const env = remote ? await this.remoteEnv() : {};
    const command = safeGitArgs(args);
    if (remote) {
      // Override safeGitArgs' LOCAL inspection defaults. This trusted hook is
      // mandatory for remote writes (managed-git-hooks.ts:333-364).
      command.splice(
        command.length - args.length,
        0,
        '-c',
        'credential.helper=!gh auth git-credential',
        '-c',
        `core.hooksPath=${this.hooksDirectory()}`,
      );
    }
    const options = {
      cwd: this.cwd,
      env: safeGitEnv(env),
      encoding: 'utf8' as const,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    };
    return new Promise((resolve, reject) => {
      if (args[0] === 'push') {
        if (!remote || !authorizePush) throw new Error('Wiki push requires current publication authority');
        // Credential resolution above can suspend. Recheck synchronously at the exec boundary.
        authorizePush();
      }
      const child = execFile('git', command, options, (error, stdout) => {
        // Subprocess errors can contain stderr/argv. Never propagate them into
        // agent output or logs; callers record a bounded operation class.
        if (error) reject(new Error(`Wiki Git ${args[0]} failed`));
        else resolve(stdout);
      });
      child.stdin?.end(input);
    });
  }
  async initialize(): Promise<string> {
    fs.mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    await this.git(['init', '--quiet', '--object-format=sha1']);
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', this.remote, this.ref], true);
    const base = (await this.git(['rev-parse', 'FETCH_HEAD^{commit}'])).trim();
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Invalid remote base');
    return base;
  }
  async pages(head: string): Promise<Record<string, string>> {
    const entries = (await this.git(['ls-tree', '-r', '-z', head, '--', 'domain/'])).split('\0').filter(Boolean);
    const pages: Record<string, string> = {};
    let bytes = 0;
    for (const entry of entries) {
      const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match || match[1] !== '100644' || !match[3].endsWith('.md'))
        throw new Error('Unsupported domain tree entry');
      const body = await this.git(['cat-file', 'blob', match[2]]);
      bytes += Buffer.byteLength(body);
      if (bytes > 1024 * 1024 || Object.keys(pages).length >= 128) throw new Error('Wiki context too large');
      pages[match[3]] = body;
    }
    return pages;
  }
  async create(
    base: string,
    edits: Replacement[],
    series: string,
    timestamp: string,
  ): Promise<{ head: string; tree: string; diff: string }> {
    const before = await this.pages(base);
    await this.git(['read-tree', base]);
    for (const edit of edits) {
      if (before[edit.path] === edit.replacementMarkdown) throw new Error('Empty candidate change');
      // Blob/index plumbing avoids checkout filters, symlink traversal and
      // executable scripts in the fetched tree altogether.
      const blob = (await this.git(['hash-object', '-w', '--stdin'], false, edit.replacementMarkdown)).trim();
      await this.git(['update-index', '--add', '--cacheinfo', '100644', blob, edit.path]);
    }
    let log = '';
    const logEntry = (await this.git(['ls-tree', base, '--', 'log.md'])).trim();
    if (logEntry) {
      const match = /^100644 blob ([0-9a-f]{40})\tlog\.md$/.exec(logEntry);
      if (!match) throw new Error('Unsupported wiki log entry');
      log = await this.git(['cat-file', 'blob', match[1]]);
      if (Buffer.byteLength(log) > 256 * 1024) throw new Error('Wiki log too large');
    }
    const logText = `${log}${log.endsWith('\n') || !log ? '' : '\n'}- ${timestamp}: sourced correction/addition in ${edits.map((e) => e.path).join(', ')}.\n`;
    const logBlob = (await this.git(['hash-object', '-w', '--stdin'], false, logText)).trim();
    await this.git(['update-index', '--add', '--cacheinfo', '100644', logBlob, 'log.md']);
    const tree = (await this.git(['write-tree'])).trim();
    const message = `Wiki sourced update: ${edits.map((e) => e.path).join(', ')}\n\nWiki-Synthesis: ${series}\n`;
    const head = (
      await this.git(
        ['-c', 'user.name=Wiki admission', '-c', 'user.email=wiki@localhost', 'commit-tree', tree, '-p', base],
        false,
        message,
      )
    ).trim();
    const diff = await this.diff(base, head);
    return { head, tree, diff };
  }
  async diff(base: string, head: string): Promise<string> {
    return this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', base, head, '--']);
  }
  async assertFrozen(base: string, head: string, tree: string, diffDigest: string): Promise<void> {
    await this.git(['merge-base', '--is-ancestor', base, head]);
    if (
      (await this.git(['rev-parse', `${head}^{tree}`])).trim() !== tree ||
      digest(await this.diff(base, head)) !== diffDigest
    ) {
      throw new Error('Frozen candidate changed');
    }
  }
  async remoteHead(): Promise<string> {
    const lines = (await this.git(['ls-remote', '--symref', this.remote, 'HEAD', this.ref], true)).trim().split('\n');
    if (!lines.includes(`ref: ${this.ref}\tHEAD`)) throw new Error('Remote default ref changed');
    const matches = lines.filter((line) => line.endsWith(`\t${this.ref}`));
    if (matches.length !== 1 || !/^[0-9a-f]{40}\t/.test(matches[0])) throw new Error('Remote ref unavailable');
    return matches[0].slice(0, 40);
  }
  async push(base: string, head: string, authorizePush: () => void): Promise<void> {
    await this.git(
      ['push', '--porcelain', `--force-with-lease=${this.ref}:${base}`, this.remote, `${head}:${this.ref}`],
      true,
      undefined,
      authorizePush,
    );
  }
}

export function candidateDirectory(root: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid candidate id');
  return path.join(root, id);
}
