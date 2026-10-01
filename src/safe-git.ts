import { execFileSync } from 'child_process';
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
  // `log.showSignature` runs `gpg.program` on every `git log` and `stash list`, and a container can set both.
  '-c',
  'log.showSignature=false',
  '-c',
  'gpg.program=/bin/false',
  '-c',
  'gpg.ssh.program=/bin/false',
  '-c',
  'gpg.x509.program=/bin/false',
];

const FILTER_OVERRIDE_ENV = {
  NANOCLAW_GIT_EMPTY: '',
  NANOCLAW_GIT_CAT: '/bin/cat',
  NANOCLAW_GIT_FALSE: 'false',
};

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
    ...FILTER_OVERRIDE_ENV,
  };
}

/** Command-line config outranks repository-local config. Filters use `--config-env`, which splits at the last `=`, so any name stays in the key. */
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
      `--config-env=filter.${name}.process=NANOCLAW_GIT_EMPTY`,
      `--config-env=filter.${name}.clean=NANOCLAW_GIT_CAT`,
      `--config-env=filter.${name}.smudge=NANOCLAW_GIT_CAT`,
      `--config-env=filter.${name}.required=NANOCLAW_GIT_FALSE`,
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
  ];
  return filterNamesFrom(args);
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
  return filterNamesFrom(['config', '--file', configPath, '--includes']);
}

const FILTER_VARIABLES = ['clean', 'smudge', 'process', 'required'];

function filterNamesFrom(configArgs: string[]): string[] {
  let output: Buffer;
  try {
    // In a UTF-8 locale git's regex `.` skips an invalid byte, so such a name would go undiscovered.
    output = execFileSync(
      'git',
      [...configArgs, '--null', '--name-only', '--get-regexp', `^filter\\..*\\.(${FILTER_VARIABLES.join('|')})$`],
      {
        env: safeGitEnv({ LANG: 'C', LC_ALL: 'C' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return [];
    throw error;
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const keys = utf8.decode(output).split('\0');
  if (keys.pop() !== '') throw new Error('unterminated git config key');
  const names = new Set<string>();
  for (const key of keys) {
    const variable = FILTER_VARIABLES.find((name) => key.startsWith('filter.') && key.endsWith(`.${name}`));
    if (variable === undefined || key.length < 'filter.'.length + variable.length + 1) {
      throw new Error(`unexpected git config key: ${JSON.stringify(key)}`);
    }
    names.add(key.slice('filter.'.length, key.length - variable.length - 1));
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

/** Sets exactly one key, leaving every other untouched (a template rewrite would drop non-template keys). */
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

export function repositoryConfigPath(gitDir: string): string {
  return path.join(gitDir, 'config');
}
