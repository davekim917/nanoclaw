/** Host-side Git execution policy for container-influenced repositories. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import fs from 'fs';
import path from 'path';

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const BASE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'protocol.file.allow=always',
  // Signature verification runs a configured program: `log.showSignature` makes
  // every `git log` (and `stash list`) verify signed commits through
  // `gpg.program`, and a container can set both in a repository it writes.
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=/bin/false',
  '-c',
  'gpg.ssh.program=/bin/false',
  '-c',
  'gpg.x509.program=/bin/false',
];

export function safeGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: SAFE_PATH,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

/** Command-line config has higher priority than repository-local config. */
export function safeGitArgs(
  args: readonly string[],
  localConfigPath?: string,
  additionalFilterNames: readonly string[] = [],
): string[] {
  const overrides = [...BASE_CONFIG];
  const filterNames = new Set(additionalFilterNames);
  if (localConfigPath) for (const name of localFilterNames(localConfigPath)) filterNames.add(name);
  for (const name of [...filterNames].sort()) {
    overrides.push(
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.clean=/bin/cat`,
      '-c',
      `filter.${name}.smudge=/bin/cat`,
      '-c',
      `filter.${name}.required=false`,
    );
  }
  return [...overrides, ...args];
}

/** Resolve filters from the repository's effective local/include/worktree config without executing them. */
export function safeGitFilterNames(gitDir: string, workTree?: string): string[] {
  const args = [
    ...BASE_CONFIG,
    '--git-dir',
    gitDir,
    ...(workTree ? ['--work-tree', workTree] : []),
    'config',
    '--includes',
    '--name-only',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process|required)$',
  ];
  let output: string;
  try {
    output = execFileSync('git', args, {
      encoding: 'utf8',
      env: safeGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
  const names = new Set<string>();
  for (const key of output.split('\n')) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

function localFilterNames(configPath: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe Git config path: ${configPath}`);
  let output: string;
  try {
    output = execFileSync(
      'git',
      [
        'config',
        '--file',
        configPath,
        '--includes',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|smudge|process|required)$',
      ],
      {
        encoding: 'utf8',
        env: safeGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
  const names = new Set<string>();
  for (const key of output.split('\n')) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

export function safeGitConfigGet(configPath: string, key: string): string | null {
  const stat = fs.lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe Git config path: ${configPath}`);
  try {
    return execFileSync('git', ['config', '--file', configPath, '--no-includes', '--get', key], {
      encoding: 'utf8',
      env: safeGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return null;
    throw error;
  }
}

/**
 * Set exactly one key in a config file, leaving every other key untouched.
 * Used for the targeted core.hooksPath migration on EXISTING canonical
 * repositories (managed-git-hooks.ts) rather than a full config rewrite
 * (sanitizeCanonicalConfig's template), which needs the repo's origin and
 * would drop any non-template key the repo happens to carry.
 */
export function safeGitConfigSet(configPath: string, key: string, value: string): void {
  const stat = fs.lstatSync(configPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe Git config path: ${configPath}`);
  execFileSync('git', ['config', '--file', configPath, key, value], {
    encoding: 'utf8',
    env: safeGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

export function safeGitOptions(
  options: Omit<ExecFileSyncOptionsWithStringEncoding, 'encoding' | 'env'> & { env?: NodeJS.ProcessEnv } = {},
): ExecFileSyncOptionsWithStringEncoding {
  return { ...options, encoding: 'utf8', env: safeGitEnv(options.env) };
}

export function repositoryConfigPath(gitDir: string): string {
  return path.join(gitDir, 'config');
}
