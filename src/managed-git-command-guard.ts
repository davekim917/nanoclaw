import path from 'node:path';

/**
 * Host-side counterpart of the Bun agent-runner managed Git guard.
 *
 * The host and agent-runner intentionally have separate dependency/runtime
 * trees, so this small parser is duplicated rather than imported across that
 * boundary. Keep the operation matrix in this file aligned with
 * `container/agent-runner/src/managed-git-guard.ts`. Host task scripts have no
 * legitimate reason to mutate shared linked-worktree administration or run
 * object-pruning maintenance; those operations belong to the repository host
 * actions, which hold the canonical lock.
 */

const PROTECTED_WORKTREE_ACTIONS = new Set(['add', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock']);
const PROTECTED_GIT_COMMANDS = new Set(['gc', 'maintenance', 'pack-refs', 'prune', 'repack']);
const PROTECTED_REFLOG_ACTIONS = new Set(['delete', 'expire']);
const PROTECTED_MULTI_PACK_INDEX_ACTIONS = new Set(['expire', 'repack']);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree',
]);
const COMMAND_WRAPPERS = new Set(['builtin', 'command', 'exec', 'nohup']);
const SHELL_CONTROL_PREFIXES = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-k', '--kill-after', '-s', '--signal']);
const NICE_OPTIONS_WITH_VALUE = new Set(['-n', '--adjustment']);
const IONICE_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '--class',
  '-n',
  '--classdata',
  '-p',
  '--pid',
  '-P',
  '--pgid',
  '-u',
  '--uid',
]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(['-i', '--input', '-o', '--output', '-e', '--error']);
const TIME_OPTIONS_WITH_VALUE = new Set(['-f', '--format', '-o', '--output']);

type ShellToken = { kind: 'word' | 'separator'; value: string };

export type ManagedGitCommandDecision = { action: 'allow' } | { action: 'deny'; operation: string; reason: string };

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    if (!word) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index]!;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      word += command[index]!;
      continue;
    }
    if (char === '\n' || char === '\r') {
      flushWord();
      tokens.push({ kind: 'separator', value: char });
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (';&|(){}'.includes(char) || char === '`') {
      flushWord();
      const doubled = index + 1 < command.length && command[index + 1] === char && ';&|'.includes(char);
      tokens.push({ kind: 'separator', value: doubled ? `${char}${char}` : char });
      if (doubled) index += 1;
      continue;
    }
    word += char;
  }
  flushWord();
  return tokens;
}

function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokenizeShell(command)) {
    if (token.kind === 'separator') {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token.value);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function skipWrapperOptions(words: string[], start: number): number {
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === '--') return index + 1;
    if (isAssignment(word)) {
      index += 1;
      continue;
    }
    if (!word.startsWith('-')) return index;
    if (word === '-u' || word === '--unset' || word === '-C' || word === '--chdir') index += 2;
    else index += 1;
  }
  return index;
}

function skipStaticWrapperOptions(words: string[], start: number, optionsWithValue: ReadonlySet<string>): number {
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === '--') return index + 1;
    if (!word.startsWith('-') || word === '-') return index;
    const equals = word.indexOf('=');
    const option = equals > 0 ? word.slice(0, equals) : word;
    if (equals < 0 && optionsWithValue.has(option)) index += 2;
    else index += 1;
  }
  return index;
}

/** Return the argv index executed by a static process-control wrapper. */
function unwrapStaticExecutionWrapper(words: string[], start: number, executable: string): number | null {
  switch (executable) {
    case 'timeout': {
      const duration = skipStaticWrapperOptions(words, start + 1, TIMEOUT_OPTIONS_WITH_VALUE);
      if (duration >= words.length) return words.length;
      return words[duration + 1] === '--' ? duration + 2 : duration + 1;
    }
    case 'nice':
      return skipStaticWrapperOptions(words, start + 1, NICE_OPTIONS_WITH_VALUE);
    case 'ionice':
      return skipStaticWrapperOptions(words, start + 1, IONICE_OPTIONS_WITH_VALUE);
    case 'setsid':
      return skipStaticWrapperOptions(words, start + 1, new Set());
    case 'stdbuf':
      return skipStaticWrapperOptions(words, start + 1, STDBUF_OPTIONS_WITH_VALUE);
    case 'time':
      return skipStaticWrapperOptions(words, start + 1, TIME_OPTIONS_WITH_VALUE);
    default:
      return null;
  }
}

function commandStart(words: string[]): number {
  let index = 0;
  while (index < words.length && isAssignment(words[index]!)) index += 1;
  while (index < words.length) {
    const executable = path.basename(words[index]!).toLowerCase();
    if (SHELL_CONTROL_PREFIXES.has(executable)) {
      index += 1;
      while (index < words.length && isAssignment(words[index]!)) index += 1;
      continue;
    }
    const wrappedCommand = unwrapStaticExecutionWrapper(words, index, executable);
    if (wrappedCommand !== null) {
      index = wrappedCommand;
      continue;
    }
    if (COMMAND_WRAPPERS.has(executable) || executable === 'env' || executable === 'sudo' || executable === 'doas') {
      index = skipWrapperOptions(words, index + 1);
      continue;
    }
    break;
  }
  return index;
}

function gitSubcommand(
  words: string[],
  start: number,
): { command: string; rest: string[]; aliases: Map<string, string> } | null {
  const aliases = new Map<string, string>();
  let index = start;
  while (index < words.length) {
    const word = words[index]!;
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;

    let option = word;
    let value: string | undefined;
    const equals = word.indexOf('=');
    if (equals > 0) {
      option = word.slice(0, equals);
      value = word.slice(equals + 1);
    } else if (word.startsWith('-C') && word.length > 2) {
      option = '-C';
      value = word.slice(2);
    } else if (word.startsWith('-c') && word.length > 2) {
      option = '-c';
      value = word.slice(2);
    }

    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option) && value === undefined) {
      index += 1;
      value = words[index];
    }
    if (option === '-c' && value) {
      const alias = value.match(/^alias\.([^=]+)=(.*)$/s);
      if (alias) aliases.set(alias[1]!, alias[2]!);
    }
    index += 1;
  }

  const command = words[index];
  return command ? { command: command.toLowerCase(), rest: words.slice(index + 1), aliases } : null;
}

function firstAction(words: string[], optionsWithValues: ReadonlySet<string> = new Set()): string | null {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === '--') return words[index + 1]?.toLowerCase() ?? null;
    const option = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
    if (optionsWithValues.has(option) && !word.includes('=')) {
      index += 1;
      continue;
    }
    if (!word.startsWith('-') || word === '-') return word.toLowerCase();
  }
  return null;
}

function protectedGitOperation(words: string[], depth = 0): string | null {
  if (depth > 4) return 'git alias recursion';
  const start = commandStart(words);
  if (start >= words.length) return null;
  const executable = path.basename(words[start]!).toLowerCase();

  if (executable === 'eval') {
    return findProtectedOperation(words.slice(start + 1).join(' '), depth + 1);
  }

  if (executable === 'bash' || executable === 'sh' || executable === 'zsh' || executable === 'dash') {
    const commandFlag = words.findIndex((word, index) => index > start && /^-[^-]*c/.test(word));
    const nested = commandFlag >= 0 ? words[commandFlag + 1] : undefined;
    return nested ? findProtectedOperation(nested, depth + 1) : null;
  }
  if (executable !== 'git' && executable !== 'git.exe') return null;

  const parsed = gitSubcommand(words, start + 1);
  if (!parsed) return null;
  if (PROTECTED_GIT_COMMANDS.has(parsed.command)) return `git ${parsed.command}`;
  if (parsed.command === 'worktree') {
    const action = firstAction(parsed.rest);
    if (action && PROTECTED_WORKTREE_ACTIONS.has(action)) return `git worktree ${action}`;
  }
  if (parsed.command === 'reflog') {
    const action = firstAction(parsed.rest);
    if (action && PROTECTED_REFLOG_ACTIONS.has(action)) return `git reflog ${action}`;
  }
  if (parsed.command === 'multi-pack-index') {
    const action = firstAction(parsed.rest, new Set(['--object-dir']));
    if (action && PROTECTED_MULTI_PACK_INDEX_ACTIONS.has(action)) return `git multi-pack-index ${action}`;
  }

  const alias = parsed.aliases.get(parsed.command);
  if (alias) {
    if (alias.startsWith('!')) return findProtectedOperation(alias.slice(1), depth + 1);
    return protectedGitOperation(['git', ...shellSegments(alias).flat(), ...parsed.rest], depth + 1);
  }
  return null;
}

function findProtectedOperation(command: string, depth = 0): string | null {
  for (const segment of shellSegments(command)) {
    const operation = protectedGitOperation(segment, depth);
    if (operation) return operation;
  }
  return null;
}

/** Pure classification for scripts considered for unsandboxed host execution. */
export function evaluateManagedGitCommand(command: string): ManagedGitCommandDecision {
  if (!command) return { action: 'allow' };
  const operation = findProtectedOperation(command);
  if (!operation) return { action: 'allow' };
  return {
    action: 'deny',
    operation,
    reason:
      `BLOCKED: ${operation} is host-only for NanoClaw managed repositories because canonical Git metadata is shared ` +
      'across topic worktrees. Scheduled scripts must not bypass the repository lock.',
  };
}
