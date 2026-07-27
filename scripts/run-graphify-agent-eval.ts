#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface EvalTask {
  id: string;
  prompt: string;
  expectedFiles: string[];
  claims: EvalClaim[];
}

export interface EvalClaim {
  id: string;
  question: string;
  type: 'boolean' | 'number' | 'string' | 'enum';
  expected: boolean | number | string;
  options?: string[];
}

export interface EvalTaskFile {
  version: 1;
  tasks: EvalTask[];
}

export interface EvalToolCall {
  name: string;
  arguments: string;
  output: string;
  exitCode?: number | null;
  exitClassification?: EvalCommandExitClassification;
  startedSequence?: number | null;
  completedSequence?: number;
}

export type EvalCommandExitClassification = 'success' | 'nonfatal-search-miss' | 'nonfatal-partial-rg' | 'fatal';

export interface EvalRun {
  runId: string;
  taskId: string;
  arm: 'graphify' | 'source-only';
  repetition: number;
  protocolVersion: string;
  model: string;
  modelVersion: string;
  reasoningEffort: string;
  candidateImageId: string;
  codexCliVersion: string;
  sourceSnapshotFingerprint: string;
  sourceSnapshotFingerprintAfter: string;
  sourceSnapshotFileCount: number;
  repositoryCommit: string;
  taskPrompt: string;
  systemPromptSha256: string;
  claimContractSha256: string;
  privateProtocolSha256: string;
  evaluatorSourceSha256: string;
  toolIdentityAllowlist: string[];
  maxToolCalls: number;
  toolCallCount: number;
  toolCalls: EvalToolCall[];
  toolOutputBytes: number;
  filesOpened: string[];
  sourceBytes: number;
  wallTimeMs: number;
  peakCgroupMemoryBytes: number;
  errors: string[];
  answerClaims: Record<string, unknown>;
  rawTrace: string;
  runtimeStderr: string;
  threadId: string;
  instructionIsolation: 'instruction-free-eval-root-with-nested-repo' | string;
  filesOpenedMeasurementMethod: 'trace-command-and-path-prefixed-output' | string;
  readonly: boolean;
  freshSession: boolean;
  byteCountingMethod: 'utf8-buffer-byte-length' | string;
  cgroupMeasurementMethod: 'cgroup-v2-memory-peak' | string;
}

export interface ScoredEvalRun {
  runId: string;
  taskId: string;
  arm: EvalRun['arm'];
  repetition: number;
  correct: boolean;
  missingClaims: string[];
  extraClaims: string[];
  invalidClaims: string[];
  executionGrounded: boolean;
  treatmentAdherent: boolean;
  filesOpened: number;
  toolOutputBytes: number;
  sourceBytes: number;
  wallTimeMs: number;
  peakCgroupMemoryBytes: number;
  errors: string[];
}

export interface EvalMetrics {
  graphifyRunCount: number;
  sourceOnlyRunCount: number;
  graphifyCorrectness: number;
  sourceOnlyCorrectness: number;
  graphifyTreatmentAdherentRuns: number;
  graphifyTreatmentAdherence: number;
  graphifyMedianFilesOpened: number;
  sourceOnlyMedianFilesOpened: number;
  graphifyMedianToolOutputBytes: number;
  sourceOnlyMedianToolOutputBytes: number;
}

export interface EvalValidationResult {
  passed: boolean;
  failures: string[];
  summary?: {
    runs: ScoredEvalRun[];
    metrics: EvalMetrics;
    activation: ReturnType<typeof scoreEvalActivationGate>;
  };
}

export interface CodexEvalDockerOptions {
  image: string;
  containerName: string;
  worktreesPath: string;
  cachePath: string;
  runtimePath: string;
  codexHomePath: string;
}

export interface ParsedCodexTrace {
  toolCalls: EvalToolCall[];
  toolOutputBytes: number;
  filesOpened: string[];
  answerClaims: Record<string, unknown>;
  errors: string[];
  threadId: string;
}

export interface EvalSystemPrompts {
  graphify: string;
  'source-only': string;
}

const EVAL_PROTOCOL = {
  version: 'v4',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'xhigh',
  toolIdentityAllowlist: ['shell'],
  maxToolCalls: 12,
  instructionIsolation: 'instruction-free-eval-root-with-nested-repo',
  filesOpenedMeasurementMethod: 'trace-command-and-path-prefixed-output',
  byteCountingMethod: 'utf8-buffer-byte-length',
  cgroupMeasurementMethod: 'cgroup-v2-memory-peak',
  responseSchema: { claims: 'object with exactly one typed value for every claim id' },
} as const;

export function buildCodexEvalDockerCommand(options: CodexEvalDockerOptions): string[] {
  return [
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    options.containerName,
    '--user',
    '1001:1001',
    '--memory',
    '5g',
    '--memory-reservation',
    '2g',
    '--memory-swap',
    '5g',
    '--pids-limit',
    '256',
    '-e',
    'NANOCLAW_CONTAINER=1',
    '-e',
    'CODEX_HOME=/home/node/.codex',
    '--tmpfs',
    '/workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001',
    '-v',
    `${path.resolve(options.worktreesPath)}:/workspace/worktrees:ro`,
    '-v',
    `${path.resolve(options.cachePath)}:/workspace/.cache/graphify`,
    '-v',
    `${path.resolve(options.runtimePath)}:/run/nanoclaw-graphify`,
    '-v',
    `${path.resolve(options.codexHomePath)}:/home/node/.codex`,
    '--workdir',
    '/workspace/worktrees/eval-root',
    '--entrypoint',
    '/bin/sh',
    options.image,
    '-lc',
    'while :; do sleep 3600; done',
  ];
}

export function buildCodexExecCommand(containerName: string, model: string, reasoningEffort: string): string[] {
  return [
    'docker',
    'exec',
    '-i',
    containerName,
    '/pnpm/codex',
    'exec',
    '--json',
    '--yolo',
    '--skip-git-repo-check',
    '-C',
    '/workspace/worktrees/eval-root',
    '-m',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '-',
  ];
}

export function buildCandidateCliVersionCommand(candidateImageId: string): string[] {
  if (!/^sha256:[0-9a-f]{64}$/.test(candidateImageId))
    throw new Error('candidate image ID must be an immutable sha256 digest');
  return ['docker', 'run', '--rm', '--entrypoint', '/pnpm/codex', candidateImageId, '--version'];
}

export function buildPinnedCodexEvalDockerCommand(
  candidateImageId: string,
  options: Omit<CodexEvalDockerOptions, 'image'>,
): string[] {
  if (!/^sha256:[0-9a-f]{64}$/.test(candidateImageId))
    throw new Error('candidate image ID must be an immutable sha256 digest');
  return buildCodexEvalDockerCommand({ ...options, image: candidateImageId });
}

export function commandAccessesForbiddenInstructions(command: string): boolean {
  const boundary = String.raw`(?:^|[\s'"=;|&()])`;
  const end = String.raw`(?=$|[\s'";|&()])`;
  const rootFile = new RegExp(`${boundary}(?:\\./)?(?:repo/)?(?:AGENTS|CLAUDE)\\.md${end}`, 'i');
  const absoluteRootFile = /\/repo\/(?:AGENTS|CLAUDE)\.md(?=$|[\s'";|&()])/i;
  const rootTree = new RegExp(`${boundary}(?:\\./)?(?:repo/)?\\.(?:claude|codex)(?:/[^\s'";|&()]*)?${end}`, 'i');
  const absoluteRootTree = /\/repo\/\.(?:claude|codex)(?:\/[^\s'";|&()]*)?(?=$|[\s'";|&()])/i;
  return (
    rootFile.test(command) || absoluteRootFile.test(command) || rootTree.test(command) || absoluteRootTree.test(command)
  );
}

export function isEvaluationSourcePath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === 'AGENTS.md' || normalized === 'CLAUDE.md') return false;
  if (normalized.startsWith('.claude/') || normalized.startsWith('.codex/')) return false;
  if (normalized.endsWith('.pyc')) return false;
  if (normalized.startsWith('docs/specs/graphify-container-code-intelligence/eval/')) return false;
  if (normalized.startsWith('.claude/tmp/graphify-agent-eval/')) return false;
  if (normalized === 'scripts/run-graphify-agent-eval.ts' || normalized === 'scripts/run-graphify-agent-eval.test.ts') {
    return false;
  }
  return true;
}

export function filterEvaluationSourcePaths(files: string[]): string[] {
  return files.filter(isEvaluationSourcePath).sort();
}

export function fingerprintSourceSnapshot(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const file of [...files.keys()].sort()) {
    const bytes = files.get(file);
    if (!bytes) throw new Error(`source snapshot file disappeared: ${file}`);
    hash.update(file);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function parseFinalJson(text: string): { claims: Record<string, unknown> } | null {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).join(',') !== 'claims') return null;
    if (typeof value.claims !== 'object' || value.claims === null || Array.isArray(value.claims)) return null;
    return { claims: value.claims as Record<string, unknown> };
  } catch {
    return null;
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandExplicitlyReadsFile(command: string, file: string): boolean {
  const escaped = regexEscape(file);
  const prefix = String.raw`(?:\/workspace\/worktrees\/eval-root\/repo\/|(?:\.\/)?repo\/|(?:\.\/)?)`;
  return new RegExp(String.raw`(?:^|[\s'"=;(])${prefix}${escaped}(?=$|[\s'";|&):])`).test(command);
}

function commandReadsSourceContent(command: string): boolean {
  if (/\brg\b[^\n]*\s--files(?:\s|$)/.test(command)) return false;
  return /(?:^|[\s;&|'\"])(cat|sed|grep|rg|head|tail|awk|wc)(?:\s|$)/.test(command);
}

interface ShellToken {
  kind: 'word' | 'operator';
  value: string;
}

interface ShellInvocation {
  executable: string;
  arguments: string[];
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let wordStarted = false;
  let quote: 'single' | 'double' | null = null;
  const flushWord = (): void => {
    if (!wordStarted) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '\\' && index + 1 < command.length) word += command[(index += 1)];
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double';
      wordStarted = true;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      wordStarted = true;
      word += command[(index += 1)];
      continue;
    }
    if (/\s/.test(character)) {
      flushWord();
      if (character === '\n') tokens.push({ kind: 'operator', value: '\n' });
      continue;
    }
    if (';&|(){}'.includes(character)) {
      flushWord();
      const pair = command.slice(index, index + 2);
      if (pair === '&&' || pair === '||') {
        tokens.push({ kind: 'operator', value: pair });
        index += 1;
      } else {
        tokens.push({ kind: 'operator', value: character });
      }
      continue;
    }
    wordStarted = true;
    word += character;
  }
  flushWord();
  return tokens;
}

function shellInvocations(command: string, depth = 0): ShellInvocation[] {
  if (depth > 4) return [];
  const tokens = tokenizeShell(command);
  const invocations: ShellInvocation[] = [];
  for (let index = 0; index < tokens.length; ) {
    while (tokens[index]?.kind === 'operator') index += 1;
    const words: string[] = [];
    while (tokens[index]?.kind === 'word') words.push(tokens[index++].value);
    if (words.length === 0) continue;

    let executableIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] ?? '')) executableIndex += 1;
    while (['command', 'exec', 'env', 'sudo', 'time'].includes(path.posix.basename(words[executableIndex] ?? ''))) {
      executableIndex += 1;
      while (/^-/.test(words[executableIndex] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] ?? '')) {
        executableIndex += 1;
      }
    }
    const executable = words[executableIndex];
    if (!executable) continue;
    const arguments_ = words.slice(executableIndex + 1);
    const basename = path.posix.basename(executable);
    invocations.push({ executable: basename, arguments: arguments_ });
    if (['bash', 'sh', 'zsh', 'dash'].includes(basename)) {
      const commandFlag = arguments_.findIndex((argument) => argument === '-c' || argument === '-lc');
      if (commandFlag >= 0 && arguments_[commandFlag + 1]) {
        invocations.push(...shellInvocations(arguments_[commandFlag + 1], depth + 1));
      }
    }
  }
  return invocations;
}

function invokesShellCommand(command: string, commandPattern: string): boolean {
  const executablePattern = new RegExp(`^(?:${commandPattern})$`, 'i');
  return shellInvocations(command).some((invocation) => executablePattern.test(invocation.executable));
}

export function commandInvokesGraphify(command: string): boolean {
  return shellInvocations(command).some((invocation) => invocation.executable.toLowerCase() === 'graphify');
}

export function commandInvokesGraphifyRead(command: string): boolean {
  return shellInvocations(command).some((invocation) => {
    if (invocation.executable.toLowerCase() !== 'graphify') return false;
    if (!['query', 'path', 'explain', 'affected'].includes(invocation.arguments[0]?.toLowerCase())) return false;
    const firstValue = invocation.arguments[1]?.toLowerCase();
    return Boolean(firstValue && firstValue !== '--help' && firstValue !== '-h');
  });
}

export function commandViolatesAuditableSourceContract(command: string): boolean {
  const repoReference = String.raw`(?:\/workspace\/worktrees\/eval-root\/repo\/|(?:\.\/)?repo\/)`;
  if (invokesShellCommand(command, String.raw`python(?:\d+(?:\.\d+)*)?|node|bun|ruby|deno|php|perl`)) return true;
  if (invokesShellCommand(command, 'xargs')) return true;
  if (/\bfind\b[^\n]*(?:-exec(?:dir)?|-ok(?:dir)?|-delete)\b/i.test(command)) return true;
  if (invokesShellCommand(command, 'git') && /\bgit\b[^\n;&|]*\b(?:grep|show|cat-file|diff|blame|log)\b/i.test(command))
    return true;
  if (invokesShellCommand(command, 'grep|rg') && /(?:^|\s)(?:-h|-I|--no-filename)(?=\s|$)/.test(command)) return true;
  if (new RegExp(String.raw`${repoReference}[^\s'";|&]*[?*\[]`, 'i').test(command)) return true;
  if (
    invokesShellCommand(
      command,
      'dd|strings|tac|cut|sort|uniq|tr|xxd|od|hexdump|base64|jq|more|less|tee|cp|tar|zip|unzip|source',
    )
  )
    return true;
  if (/(?:^|\s)\d*<\s*(?:[./\w-]+\/[^\s'"]+|[\w-]+\.[\w.-]+)(?=\s|['"]|$)/.test(command)) return true;
  if (invokesShellCommand(command, '\\.')) return true;
  if (/(?:^|\s)(?:\.\/)?(?:[^\s'";|&]+\/)*[^\s'";|&]*[?*\[]/.test(command)) return true;
  return false;
}

function outputAttributesFile(output: string, file: string): boolean {
  const escaped = regexEscape(file);
  const prefix = String.raw`(?:\/workspace\/worktrees\/eval-root\/repo\/|(?:\.\/)?repo\/|(?:\.\/)?)`;
  const matcher = new RegExp(String.raw`^${prefix}${escaped}(?=$|:\d*(?::\d*)?:|:)`);
  return output.split(/\r?\n/).some((line) => matcher.test(line));
}

function outputHasPathAttributedMatch(output: string, file: string): boolean {
  const escaped = regexEscape(file);
  const prefix = String.raw`(?:\/workspace\/worktrees\/eval-root\/repo\/|(?:\.\/)?repo\/|(?:\.\/)?)`;
  const matcher = new RegExp(String.raw`^${prefix}${escaped}:`);
  return output.split(/\r?\n/).some((line) => matcher.test(line));
}

function isDirectAuditableRgSearch(command: string, depth = 0): boolean {
  if (depth > 4) return false;
  const tokens = tokenizeShell(command);
  const groups: string[][] = [];
  const operators: string[] = [];
  let words: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'word') {
      words.push(token.value);
      continue;
    }
    if (words.length > 0) groups.push(words);
    words = [];
    operators.push(token.value);
  }
  if (words.length > 0) groups.push(words);
  if (groups.length === 0 || operators.length !== groups.length - 1) return false;

  const directRg = (group: string[]): boolean => {
    if (group.length === 0 || path.posix.basename(group[0]).toLowerCase() !== 'rg') return false;
    return !group.slice(1).includes('--files');
  };
  if (groups.length === 1 && operators.length === 0) {
    if (directRg(groups[0])) return true;
    const executable = path.posix.basename(groups[0][0] ?? '').toLowerCase();
    if (!['bash', 'sh', 'zsh', 'dash'].includes(executable)) return false;
    const commandFlag = groups[0].findIndex((argument) => argument === '-c' || argument === '-lc');
    if (commandFlag < 0 || commandFlag + 2 !== groups[0].length) return false;
    return isDirectAuditableRgSearch(groups[0][commandFlag + 1], depth + 1);
  }
  if (groups.length !== 2 || !['&&', ';', '\n'].includes(operators[0])) return false;
  const cd = groups[0];
  return path.posix.basename(cd[0] ?? '').toLowerCase() === 'cd' && cd.length === 2 && directRg(groups[1]);
}

export function classifyCommandExit(
  command: string,
  exitCode: number,
  output: string,
  repositoryFiles: string[],
): EvalCommandExitClassification {
  if (exitCode === 0) return 'success';
  if (commandViolatesAuditableSourceContract(command)) return 'fatal';
  const auditableSearchMiss =
    exitCode === 1 &&
    /(?:^|(?:&&|\|\||[;|])\s*|(?:-lc|-c)\s+['"]\s*)(?:\/[\w./-]+\/)?(?:grep|rg)(?=\s|$)/.test(command);
  if (auditableSearchMiss) return 'nonfatal-search-miss';
  const attributedPartialRg =
    exitCode === 2 &&
    isDirectAuditableRgSearch(command) &&
    repositoryFiles.some((file) => outputHasPathAttributedMatch(output, file));
  if (attributedPartialRg) return 'nonfatal-partial-rg';
  return 'fatal';
}

export function isNonFatalAuditableSearchMiss(
  command: string,
  exitCode: number,
  output = '',
  repositoryFiles: string[] = [],
): boolean {
  const classification = classifyCommandExit(command, exitCode, output, repositoryFiles);
  return classification === 'nonfatal-search-miss' || classification === 'nonfatal-partial-rg';
}

export function isGraphifyTreatmentAdherent(run: EvalRun): boolean {
  if (run.arm !== 'graphify') return false;
  const graphifyStarts = run.toolCalls
    .filter((call) => call.name === 'shell' && commandInvokesGraphifyRead(call.arguments))
    .map((call) => call.startedSequence)
    .filter((sequence): sequence is number => Number.isInteger(sequence));
  const sourceStarts = run.toolCalls
    .filter((call) => call.name === 'shell' && commandReadsSourceContent(call.arguments))
    .map((call) => call.startedSequence)
    .filter((sequence): sequence is number => Number.isInteger(sequence));
  if (graphifyStarts.length === 0 || sourceStarts.length === 0) return false;
  return Math.min(...graphifyStarts) < Math.min(...sourceStarts);
}

export function parseCodexJsonlTrace(trace: string, repositoryFiles: string[]): ParsedCodexTrace {
  const toolCalls: EvalToolCall[] = [];
  const errors: string[] = [];
  const observedFiles = new Set<string>();
  const commandStarts = new Map<string, { command: string; sequence: number }>();
  const completedCommandIds = new Set<string>();
  let finalText = '';
  let threadId = '';
  let eventSequence = 0;
  for (const rawLine of trace.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    eventSequence += 1;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      errors.push('non-JSON Codex trace line');
      continue;
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      if (threadId) errors.push('multiple Codex threads in one fresh run');
      threadId = event.thread_id;
    } else if (event.type === 'item.started' && item?.type === 'command_execution') {
      const itemId = typeof item.id === 'string' ? item.id : '';
      const command = typeof item.command === 'string' ? item.command : '';
      if (!itemId) errors.push('command item.started omitted id');
      else if (commandStarts.has(itemId)) errors.push('duplicate command item.started id');
      else commandStarts.set(itemId, { command, sequence: eventSequence });
    } else if (event.type === 'item.completed' && item?.type === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '';
      const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const itemId = typeof item.id === 'string' ? item.id : '';
      const started = itemId ? commandStarts.get(itemId) : undefined;
      if (itemId && completedCommandIds.has(itemId)) errors.push('duplicate command item.completed id');
      else if (itemId) completedCommandIds.add(itemId);
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      if (!started) errors.push('command execution missing item.started evidence');
      else if (started.command !== command) errors.push('command changed between item.started and item.completed');
      if (exitCode === null) errors.push('command execution omitted numeric exit code');
      const exitClassification =
        exitCode === null ? 'fatal' : classifyCommandExit(command, exitCode, output, repositoryFiles);
      toolCalls.push({
        name: 'shell',
        arguments: command,
        output,
        exitCode,
        exitClassification,
        startedSequence: started?.sequence ?? null,
        completedSequence: eventSequence,
      });
      if (commandAccessesForbiddenInstructions(command)) {
        errors.push('command accessed forbidden repository instruction files');
      }
      if (commandViolatesAuditableSourceContract(command)) {
        errors.push('command violated auditable source-navigation contract');
      }
      if (exitCode !== null && exitClassification === 'fatal') errors.push(`command exited ${exitCode}`);
      const explicitFiles = repositoryFiles.filter((file) => commandExplicitlyReadsFile(command, file));
      const outputFiles = commandReadsSourceContent(command)
        ? repositoryFiles.filter((file) => outputAttributesFile(output, file))
        : [];
      for (const file of [...explicitFiles, ...outputFiles]) observedFiles.add(file);
      const attemptsBulkRead =
        commandReadsSourceContent(command) &&
        (/(?:repo\/|\.\/)[^\s'";|&]*[*?[]/.test(command) ||
          repositoryFiles.some((file) => {
            const directory = path.posix.dirname(file);
            return (
              directory !== '.' &&
              new RegExp(`(?:^|[\\s'\"])(?:repo/)?${regexEscape(directory)}(?:/)?(?=$|[\\s'\"])`).test(command)
            );
          }));
      if (attemptsBulkRead && output.length > 0 && explicitFiles.length === 0 && outputFiles.length === 0) {
        errors.push('unobservable bulk source read without attributable file paths');
      }
    } else if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      finalText = item.text;
    } else if (
      event.type === 'item.completed' &&
      typeof item?.type === 'string' &&
      ['file_change', 'web_search', 'mcp_tool_call', 'dynamic_tool_call'].includes(item.type)
    ) {
      toolCalls.push({ name: item.type, arguments: JSON.stringify(item), output: '' });
      errors.push(`disallowed actionable Codex item: ${item.type}`);
    } else if (event.type === 'turn.failed' || event.type === 'error' || item?.type === 'error') {
      errors.push('Codex runtime error');
    }
  }
  for (const itemId of commandStarts.keys()) {
    if (!completedCommandIds.has(itemId)) errors.push('command item.started omitted matching item.completed evidence');
  }
  const final = parseFinalJson(finalText);
  if (!final) errors.push('final response is not schema-valid JSON');
  if (!threadId) errors.push('Codex trace omitted a fresh thread id');
  return {
    toolCalls,
    toolOutputBytes: toolCalls.reduce((total, call) => total + Buffer.byteLength(call.output, 'utf8'), 0),
    filesOpened: [...observedFiles].sort(),
    answerClaims: final?.claims ?? {},
    errors,
    threadId,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function valueHasType(value: unknown, type: EvalClaim['type']): boolean {
  if (type === 'enum' || type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
}

export function validateEvalTaskFile(tasksFile: EvalTaskFile): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (typeof tasksFile !== 'object' || tasksFile === null || Array.isArray(tasksFile)) {
    return { passed: false, failures: ['evaluation task file must be an object'] };
  }
  const rawFile = tasksFile as unknown as Record<string, unknown>;
  if (rawFile.version !== 1) failures.push('evaluation task file version must be 1');
  if (!Array.isArray(rawFile.tasks)) {
    return { passed: false, failures: [...failures, 'evaluation requires exactly six tasks'] };
  }
  if (rawFile.tasks.length !== 6) failures.push('evaluation requires exactly six tasks');
  const taskIds = new Set<string>();
  for (const [taskIndex, candidate] of rawFile.tasks.entries()) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      failures.push(`task ${taskIndex}: task must be an object`);
      continue;
    }
    const task = candidate as Record<string, unknown>;
    const taskId = typeof task.id === 'string' ? task.id : '';
    if (!taskId || taskIds.has(taskId)) failures.push(`duplicate or empty task id: ${taskId}`);
    taskIds.add(taskId);
    if (
      typeof task.prompt !== 'string' ||
      task.prompt.length === 0 ||
      !Array.isArray(task.expectedFiles) ||
      task.expectedFiles.length === 0 ||
      !task.expectedFiles.every((file) => typeof file === 'string' && file.length > 0)
    ) {
      failures.push(`${taskId}: task prompt or expected files are missing or invalid`);
    }
    if (!Array.isArray(task.claims) || task.claims.length === 0) {
      failures.push(`${taskId}: structured claims are missing`);
      continue;
    }
    const claimIds = new Set<string>();
    for (const [claimIndex, claimCandidate] of task.claims.entries()) {
      if (typeof claimCandidate !== 'object' || claimCandidate === null || Array.isArray(claimCandidate)) {
        failures.push(`${taskId}: claim ${claimIndex} must be an object`);
        continue;
      }
      const claim = claimCandidate as Record<string, unknown>;
      const claimId = typeof claim.id === 'string' ? claim.id : '';
      if (!claimId || claimIds.has(claimId)) failures.push(`${taskId}: duplicate or empty claim id: ${claimId}`);
      claimIds.add(claimId);
      if (typeof claim.question !== 'string' || claim.question.length === 0)
        failures.push(`${taskId}:${claimId}: claim question is missing`);
      const claimType = claim.type;
      if (!['boolean', 'number', 'string', 'enum'].includes(String(claimType))) {
        failures.push(`${taskId}:${claimId}: unsupported claim type`);
      } else if (!valueHasType(claim.expected, claimType as EvalClaim['type'])) {
        failures.push(`${taskId}:${claimId}: expected value has the wrong type`);
      }
      if (claimType === 'enum') {
        if (
          !Array.isArray(claim.options) ||
          claim.options.length < 2 ||
          !claim.options.every((option) => typeof option === 'string') ||
          new Set(claim.options).size !== claim.options.length ||
          !claim.options.includes(String(claim.expected))
        ) {
          failures.push(`${taskId}:${claimId}: enum options are invalid`);
        }
      } else if (claim.options !== undefined) {
        failures.push(`${taskId}:${claimId}: non-enum claim declares options`);
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

export function buildPublicClaimContract(task: EvalTask): object {
  return {
    responseSchema: {
      claims: 'object with exactly one property for every claim id below',
      additionalTopLevelProperties: false,
    },
    claims: task.claims.map(({ id, question, type, options }) => ({
      id,
      question,
      type,
      ...(options ? { options } : {}),
    })),
  };
}

export function computeClaimContractSha256(task: EvalTask): string {
  return sha256(JSON.stringify(buildPublicClaimContract(task)));
}

export function computeEvaluatorSourceSha256(): string {
  return createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
}

export function computePrivateProtocolSha256(
  tasksFile: EvalTaskFile,
  systems: EvalSystemPrompts,
  evaluatorSourceSha256: string = computeEvaluatorSourceSha256(),
): string {
  return sha256(
    JSON.stringify({
      taskDefinitions: tasksFile,
      systemPromptBytes: systems,
      fixedProtocol: EVAL_PROTOCOL,
      evaluatorSourceSha256,
    }),
  );
}

export function findClaimIdLeaks(tasksFile: EvalTaskFile, files: ReadonlyMap<string, Buffer>): string[] {
  const claimIds = [...new Set(tasksFile.tasks.flatMap((task) => task.claims.map((claim) => claim.id)))];
  const failures: string[] = [];
  for (const [file, bytes] of files) {
    for (const claimId of claimIds) {
      if (bytes.includes(Buffer.from(claimId, 'utf8'))) failures.push(`${file}: leaked claim id ${claimId}`);
    }
  }
  return failures;
}

export function assertNoClaimIdLeaks(tasksFile: EvalTaskFile, files: ReadonlyMap<string, Buffer>): void {
  const failures = findClaimIdLeaks(tasksFile, files);
  if (failures.length > 0) throw new Error(`evaluation snapshot leaks private claim contract: ${failures.join('; ')}`);
}

function assessClaimAnswer(
  task: EvalTask,
  answerClaims: Record<string, unknown>,
): {
  missingClaims: string[];
  extraClaims: string[];
  invalidClaims: string[];
} {
  const expectedIds = new Set(task.claims.map((claim) => claim.id));
  const actualIds = Object.keys(answerClaims);
  const missingClaims = task.claims.filter((claim) => !(claim.id in answerClaims)).map((claim) => claim.id);
  const extraClaims = actualIds.filter((id) => !expectedIds.has(id));
  const invalidClaims = task.claims
    .filter(
      (claim) =>
        claim.id in answerClaims &&
        (!valueHasType(answerClaims[claim.id], claim.type) || !Object.is(answerClaims[claim.id], claim.expected)),
    )
    .map((claim) => claim.id);
  return { missingClaims, extraClaims, invalidClaims };
}

function scoreRun(task: EvalTask, run: EvalRun): ScoredEvalRun {
  const { missingClaims, extraClaims, invalidClaims } = assessClaimAnswer(task, run.answerClaims);
  const opened = new Set(run.filesOpened);
  const missingFiles = task.expectedFiles.filter((file) => !opened.has(file));
  const shellCalls = run.toolCalls.filter((call) => call.name === 'shell');
  const executionGrounded =
    run.errors.length === 0 &&
    missingFiles.length === 0 &&
    run.readonly &&
    run.freshSession &&
    run.toolCalls.every((call) => run.toolIdentityAllowlist.includes(call.name)) &&
    shellCalls.every(
      (call) =>
        !commandAccessesForbiddenInstructions(call.arguments) &&
        !commandViolatesAuditableSourceContract(call.arguments) &&
        Number.isInteger(call.exitCode) &&
        classifyCommandExit(call.arguments, call.exitCode!, call.output, run.filesOpened) !== 'fatal',
    ) &&
    !(run.arm === 'source-only' && shellCalls.some((call) => commandInvokesGraphify(call.arguments)));
  return {
    runId: run.runId,
    taskId: run.taskId,
    arm: run.arm,
    repetition: run.repetition,
    correct: missingClaims.length === 0 && extraClaims.length === 0 && invalidClaims.length === 0,
    missingClaims,
    extraClaims,
    invalidClaims,
    executionGrounded,
    treatmentAdherent: isGraphifyTreatmentAdherent(run),
    filesOpened: new Set(run.filesOpened).size,
    toolOutputBytes: run.toolOutputBytes,
    sourceBytes: run.sourceBytes,
    wallTimeMs: run.wallTimeMs,
    peakCgroupMemoryBytes: run.peakCgroupMemoryBytes,
    errors: [...run.errors],
  };
}

function metricsFor(scored: ScoredEvalRun[]): EvalMetrics {
  const graphify = scored.filter((run) => run.arm === 'graphify');
  const sourceOnly = scored.filter((run) => run.arm === 'source-only');
  const graphifyTreatmentAdherentRuns = graphify.filter((run) => run.treatmentAdherent).length;
  return {
    graphifyRunCount: graphify.length,
    sourceOnlyRunCount: sourceOnly.length,
    graphifyCorrectness: graphify.length > 0 ? graphify.filter((run) => run.correct).length / graphify.length : 0,
    sourceOnlyCorrectness:
      sourceOnly.length > 0 ? sourceOnly.filter((run) => run.correct).length / sourceOnly.length : 0,
    graphifyTreatmentAdherentRuns,
    graphifyTreatmentAdherence: graphify.length > 0 ? graphifyTreatmentAdherentRuns / graphify.length : 0,
    graphifyMedianFilesOpened: median(graphify.map((run) => run.filesOpened)),
    sourceOnlyMedianFilesOpened: median(sourceOnly.map((run) => run.filesOpened)),
    graphifyMedianToolOutputBytes: median(graphify.map((run) => run.toolOutputBytes)),
    sourceOnlyMedianToolOutputBytes: median(sourceOnly.map((run) => run.toolOutputBytes)),
  };
}

export function scoreEvalActivationGate(metrics: EvalMetrics): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (metrics.graphifyCorrectness < 0.9) failures.push('Graphify correctness is below 90%');
  if (metrics.graphifyCorrectness < metrics.sourceOnlyCorrectness) {
    failures.push('Graphify correctness is below source-only correctness');
  }
  if (metrics.graphifyTreatmentAdherence < 0.9) {
    failures.push('Graphify treatment adherence is below 90%');
  }
  const filesImprovement =
    metrics.sourceOnlyMedianFilesOpened > 0 &&
    metrics.graphifyMedianFilesOpened <= metrics.sourceOnlyMedianFilesOpened * 0.8;
  const bytesImprovement =
    metrics.sourceOnlyMedianToolOutputBytes > 0 &&
    metrics.graphifyMedianToolOutputBytes <= metrics.sourceOnlyMedianToolOutputBytes * 0.8;
  const filesBounded = metrics.graphifyMedianFilesOpened <= metrics.sourceOnlyMedianFilesOpened * 1.1;
  const bytesBounded = metrics.graphifyMedianToolOutputBytes <= metrics.sourceOnlyMedianToolOutputBytes * 1.1;
  if (!((filesImprovement && bytesBounded) || (bytesImprovement && filesBounded))) {
    failures.push('Graphify does not improve one median retrieval metric by 20% with the other at most 10% worse');
  }
  return { passed: failures.length === 0, failures };
}

export function validateEvalRuns(
  tasksFile: EvalTaskFile,
  runs: EvalRun[],
  systems: EvalSystemPrompts,
): EvalValidationResult {
  const failures: string[] = [...validateEvalTaskFile(tasksFile).failures];
  if (runs.length !== 36) failures.push(`evaluation requires exactly 36 runs, got ${runs.length}`);
  const tasks = new Map(tasksFile.tasks.map((task) => [task.id, task]));
  const expectedKeys = new Set<string>();
  for (const task of tasksFile.tasks) {
    for (const arm of ['graphify', 'source-only']) {
      for (let repetition = 1; repetition <= 3; repetition += 1) expectedKeys.add(`${task.id}:${arm}:${repetition}`);
    }
  }
  const seen = new Set<string>();
  const threadIds = new Set<string>();
  const baseline = runs[0];
  const systemHashes = new Map<EvalRun['arm'], string>();
  const scored: ScoredEvalRun[] = [];
  const evaluatorSourceSha256 = computeEvaluatorSourceSha256();
  const privateProtocolSha256 = computePrivateProtocolSha256(tasksFile, systems, evaluatorSourceSha256);

  for (const run of runs) {
    const commandStartSequences = new Set<number>();
    const commandCompletionSequences = new Set<number>();
    const key = `${run.taskId}:${run.arm}:${run.repetition}`;
    if (seen.has(key)) failures.push(`duplicate evaluation run: ${key}`);
    seen.add(key);
    const task = tasks.get(run.taskId);
    if (!task) {
      failures.push(`unknown task: ${run.taskId}`);
      continue;
    }
    if (!expectedKeys.has(key)) failures.push(`invalid arm or repetition: ${key}`);
    if (run.runId !== key) failures.push(`${key}: runId drift`);
    if (run.protocolVersion !== EVAL_PROTOCOL.version) failures.push(`${key}: protocol version drift`);
    if (run.taskPrompt !== task.prompt) failures.push(`${key}: task prompt drift`);
    if (run.claimContractSha256 !== computeClaimContractSha256(task))
      failures.push(`${key}: structured claim contract drift`);
    if (run.privateProtocolSha256 !== privateProtocolSha256) failures.push(`${key}: private protocol drift`);
    if (run.evaluatorSourceSha256 !== evaluatorSourceSha256) failures.push(`${key}: evaluator source drift`);
    if (baseline) {
      if (run.model !== baseline.model || run.modelVersion !== baseline.modelVersion)
        failures.push(`${key}: model drift`);
      if (run.reasoningEffort !== baseline.reasoningEffort) failures.push(`${key}: reasoning-effort drift`);
      if (run.protocolVersion !== baseline.protocolVersion)
        failures.push(`${key}: protocol-version drift within matrix`);
      if (run.candidateImageId !== baseline.candidateImageId) failures.push(`${key}: candidate image drift`);
      if (run.codexCliVersion !== baseline.codexCliVersion) failures.push(`${key}: Codex CLI drift`);
      if (run.sourceSnapshotFingerprint !== baseline.sourceSnapshotFingerprint)
        failures.push(`${key}: source snapshot drift`);
      if (run.sourceSnapshotFileCount !== baseline.sourceSnapshotFileCount)
        failures.push(`${key}: source snapshot file-count drift`);
      if (run.repositoryCommit !== baseline.repositoryCommit) failures.push(`${key}: repository commit drift`);
      if (!sameStrings(run.toolIdentityAllowlist, baseline.toolIdentityAllowlist))
        failures.push(`${key}: tool allowlist drift`);
      if (run.maxToolCalls !== baseline.maxToolCalls) failures.push(`${key}: tool-call budget drift`);
    }
    const priorHash = systemHashes.get(run.arm);
    if (priorHash && priorHash !== run.systemPromptSha256) failures.push(`${key}: system prompt drift within arm`);
    systemHashes.set(run.arm, run.systemPromptSha256);
    if (run.systemPromptSha256 !== sha256(systems[run.arm]))
      failures.push(`${key}: system prompt does not match protocol`);
    if (run.maxToolCalls !== EVAL_PROTOCOL.maxToolCalls || run.toolCalls.length > EVAL_PROTOCOL.maxToolCalls)
      failures.push(`${key}: tool-call count exceeds ${EVAL_PROTOCOL.maxToolCalls}`);
    if (run.model !== EVAL_PROTOCOL.model || run.modelVersion !== EVAL_PROTOCOL.model)
      failures.push(`${key}: model is not pinned to gpt-5.6-sol`);
    if (run.reasoningEffort !== EVAL_PROTOCOL.reasoningEffort)
      failures.push(`${key}: reasoning effort is not pinned to xhigh`);
    if (!sameStrings(run.toolIdentityAllowlist, [...EVAL_PROTOCOL.toolIdentityAllowlist]))
      failures.push(`${key}: tool allowlist is not exactly shell-only`);
    if (!/^sha256:[0-9a-f]{64}$/.test(run.candidateImageId)) failures.push(`${key}: invalid candidate image ID`);
    if (!run.codexCliVersion.trim()) failures.push(`${key}: missing Codex CLI version`);
    if (!/^[0-9a-f]{64}$/.test(run.sourceSnapshotFingerprint))
      failures.push(`${key}: invalid source snapshot fingerprint`);
    if (run.sourceSnapshotFingerprintAfter !== run.sourceSnapshotFingerprint)
      failures.push(`${key}: read-only source snapshot changed`);
    if (!Number.isInteger(run.sourceSnapshotFileCount) || run.sourceSnapshotFileCount <= 0)
      failures.push(`${key}: invalid source snapshot file count`);
    if (!run.threadId) failures.push(`${key}: missing fresh Codex thread ID`);
    else if (threadIds.has(run.threadId)) failures.push(`${key}: reused Codex thread ID`);
    else threadIds.add(run.threadId);
    if (run.toolCalls.some((call) => !run.toolIdentityAllowlist.includes(call.name)))
      failures.push(`${key}: tool identity violation`);
    if (run.toolCalls.some((call) => call.name === 'shell' && commandAccessesForbiddenInstructions(call.arguments))) {
      failures.push(`${key}: forbidden repository instruction-file access`);
    }
    if (run.toolCalls.some((call) => call.name === 'shell' && commandViolatesAuditableSourceContract(call.arguments))) {
      failures.push(`${key}: auditable source-navigation contract violation`);
    }
    if (run.toolCallCount !== run.toolCalls.length) failures.push(`${key}: tool-call count evidence mismatch`);
    for (const call of run.toolCalls.filter((candidate) => candidate.name === 'shell')) {
      if (!Number.isInteger(call.startedSequence) || Number(call.startedSequence) <= 0) {
        failures.push(`${key}: shell call omitted valid item.started ordering evidence`);
      } else if (commandStartSequences.has(call.startedSequence!)) {
        failures.push(`${key}: duplicate command item.started sequence`);
      } else {
        commandStartSequences.add(call.startedSequence!);
      }
      if (!Number.isInteger(call.completedSequence) || Number(call.completedSequence) <= 0) {
        failures.push(`${key}: shell call omitted valid item.completed ordering evidence`);
      } else if (commandCompletionSequences.has(call.completedSequence!)) {
        failures.push(`${key}: duplicate command item.completed sequence`);
      } else {
        commandCompletionSequences.add(call.completedSequence!);
      }
      if (
        Number.isInteger(call.startedSequence) &&
        Number.isInteger(call.completedSequence) &&
        call.completedSequence! < call.startedSequence!
      ) {
        failures.push(`${key}: command completed before its recorded start`);
      }
      if (!Number.isInteger(call.exitCode)) {
        failures.push(`${key}: shell call omitted numeric exit-code evidence`);
      } else {
        const classification = classifyCommandExit(call.arguments, call.exitCode!, call.output, run.filesOpened);
        if (call.exitClassification !== classification) {
          failures.push(`${key}: shell exit classification evidence mismatch`);
        }
        if (classification === 'fatal') failures.push(`${key}: fatal command exit ${call.exitCode}`);
      }
    }
    if (
      run.arm === 'source-only' &&
      run.toolCalls.some((call) => call.name === 'shell' && commandInvokesGraphify(call.arguments))
    ) {
      failures.push(`${key}: source-only arm invoked Graphify`);
    }
    const exactBytes = run.toolCalls.reduce((total, call) => total + Buffer.byteLength(call.output, 'utf8'), 0);
    if (run.toolOutputBytes !== exactBytes) failures.push(`${key}: UTF-8 tool-output byte count mismatch`);
    if (!run.readonly) failures.push(`${key}: repository was not read-only`);
    if (!run.freshSession) failures.push(`${key}: session was not fresh`);
    if (run.byteCountingMethod !== EVAL_PROTOCOL.byteCountingMethod)
      failures.push(`${key}: byte-counting method drift`);
    if (run.cgroupMeasurementMethod !== EVAL_PROTOCOL.cgroupMeasurementMethod)
      failures.push(`${key}: cgroup measurement method drift`);
    if (run.instructionIsolation !== EVAL_PROTOCOL.instructionIsolation) {
      failures.push(`${key}: Codex instruction-isolation contract drift`);
    }
    if (run.filesOpenedMeasurementMethod !== EVAL_PROTOCOL.filesOpenedMeasurementMethod) {
      failures.push(`${key}: files-opened measurement method drift`);
    }
    if (!Array.isArray(run.filesOpened) || !run.filesOpened.every((file) => typeof file === 'string')) {
      failures.push(`${key}: files-opened evidence is invalid`);
    }
    const openedFiles = new Set(run.filesOpened);
    for (const expectedFile of task.expectedFiles) {
      if (!openedFiles.has(expectedFile)) failures.push(`${key}: did not read expected source file: ${expectedFile}`);
    }
    for (const error of run.errors) failures.push(`${key}: execution error: ${error}`);
    scored.push(scoreRun(task, run));
  }
  for (const key of expectedKeys) if (!seen.has(key)) failures.push(`missing evaluation run: ${key}`);
  const metrics = metricsFor(scored);
  return {
    passed: failures.length === 0,
    failures,
    summary: { runs: scored, metrics, activation: scoreEvalActivationGate(metrics) },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot resolve repository commit: ${result.stderr}`);
  return result.stdout.trim();
}

interface PreparedSourceSnapshot {
  temporaryRoot: string;
  worktreesPath: string;
  evalRootPath: string;
  repositoryPath: string;
  files: string[];
  fingerprint: string;
}

interface EvalProvenance {
  protocolVersion: string;
  candidateImageId: string;
  codexCliVersion: string;
  sourceSnapshotFingerprint: string;
  sourceSnapshotFileCount: number;
  repositoryCommit: string;
  requestedModel: string;
  reasoningEffort: string;
  instructionIsolation: 'instruction-free-eval-root-with-nested-repo';
  privateProtocolSha256: string;
  evaluatorSourceSha256: string;
}

export interface AgentEvaluationOptions {
  tasksPath: string;
  graphifySystemPath: string;
  sourceOnlySystemPath: string;
  outputDirectory: string;
  repositoryRoot: string;
  image: string;
  model: string;
  reasoningEffort: string;
  codexAuthPath: string;
}

function evaluationOptionFailure(options: AgentEvaluationOptions): string | null {
  if (options.model !== 'gpt-5.6-sol') return 'evaluation model must be gpt-5.6-sol';
  if (options.reasoningEffort !== 'xhigh') return 'evaluation reasoning effort must be xhigh';
  return null;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

function runCommand(command: string[], input?: string, timeout = 15 * 60 * 1000): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error) : undefined,
  };
}

function sourceFileList(repositoryRoot: string): string[] {
  const result = spawnSync('git', ['-C', repositoryRoot, 'ls-files', '-co', '--exclude-standard', '-z'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`cannot enumerate frozen source snapshot: ${String(result.stderr)}`);
  return filterEvaluationSourcePaths(result.stdout.toString('utf8').split('\0').filter(Boolean)).filter((file) => {
    try {
      return statSync(path.join(repositoryRoot, file)).isFile();
    } catch {
      return false;
    }
  });
}

function snapshotBytes(root: string, files: string[]): Map<string, Buffer> {
  return new Map(files.map((file) => [file, readFileSync(path.join(root, file))]));
}

export function buildEvaluationSnapshotBytes(repositoryRoot: string, sourceFiles: string[]): Map<string, Buffer> {
  if (sourceFiles.some((file) => file.replaceAll('\\', '/').startsWith('.claude/'))) {
    throw new Error('evaluation source list contains forbidden authoritative .claude content');
  }
  const bytes = snapshotBytes(repositoryRoot, sourceFiles);
  for (const sourceFile of sourceFiles) {
    const pairing = /^setup\/pair-([a-z0-9-]+)\.ts$/.exec(sourceFile);
    if (!pairing) continue;
    const markerPath = `.claude/skills/add-${pairing[1]}/SKILL.md`;
    const markerAbsolute = path.resolve(repositoryRoot, markerPath);
    try {
      const markerStat = lstatSync(markerAbsolute);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || realpathSync(markerAbsolute) !== markerAbsolute)
        continue;
    } catch {
      continue;
    }
    // This zero-byte file proves only exact operator-installed ownership. Never
    // copy skill bytes into the agent-visible evaluation snapshot.
    bytes.set(markerPath, Buffer.alloc(0));
  }
  return bytes;
}

function prepareSourceSnapshot(repositoryRoot: string, tasksFile: EvalTaskFile): PreparedSourceSnapshot {
  const sourceFiles = sourceFileList(repositoryRoot);
  const bytes = buildEvaluationSnapshotBytes(repositoryRoot, sourceFiles);
  const files = [...bytes.keys()].sort();
  assertNoClaimIdLeaks(tasksFile, bytes);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-graphify-agent-eval-'));
  const worktreesPath = path.join(temporaryRoot, 'worktrees');
  const evalRootPath = path.join(worktreesPath, 'eval-root');
  const repositoryPath = path.join(evalRootPath, 'repo');
  try {
    mkdirSync(repositoryPath, { recursive: true });
    for (const file of files) {
      const destination = path.join(repositoryPath, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, bytes.get(file)!);
    }
    const initialized = runCommand(['git', '-C', evalRootPath, 'init', '-q']);
    if (initialized.exitCode !== 0)
      throw new Error(`cannot initialize instruction-free eval root: ${initialized.stderr}`);
    chmodSync(temporaryRoot, 0o755);
    chmodSync(worktreesPath, 0o755);
    chmodSync(evalRootPath, 0o755);
    chmodSync(repositoryPath, 0o755);
    return {
      temporaryRoot,
      worktreesPath,
      evalRootPath,
      repositoryPath,
      files,
      fingerprint: fingerprintSourceSnapshot(bytes),
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function currentSnapshotFingerprint(snapshot: PreparedSourceSnapshot): string {
  return fingerprintSourceSnapshot(snapshotBytes(snapshot.repositoryPath, snapshot.files));
}

function prepareCodexHome(authPath: string, destination: string): void {
  if (!existsSync(authPath)) throw new Error(`Codex auth file is unavailable: ${authPath}`);
  mkdirSync(destination, { recursive: true });
  cpSync(authPath, path.join(destination, 'auth.json'));
  chmodSync(destination, 0o777);
  chmodSync(path.join(destination, 'auth.json'), 0o644);
}

function inspectProvenance(
  options: AgentEvaluationOptions,
  snapshot: PreparedSourceSnapshot,
  privateProtocolSha256: string,
  evaluatorSourceSha256: string,
): EvalProvenance {
  const image = runCommand(['docker', 'image', 'inspect', options.image, '--format', '{{.Id}}'], undefined, 30_000);
  if (image.exitCode !== 0) throw new Error(`candidate image unavailable: ${image.stderr}`);
  const candidateImageId = image.stdout.trim();
  const cli = runCommand(buildCandidateCliVersionCommand(candidateImageId), undefined, 30_000);
  if (cli.exitCode !== 0) throw new Error(`candidate Codex CLI unavailable: ${cli.stderr}`);
  return {
    protocolVersion: EVAL_PROTOCOL.version,
    candidateImageId,
    codexCliVersion: cli.stdout.trim(),
    sourceSnapshotFingerprint: snapshot.fingerprint,
    sourceSnapshotFileCount: snapshot.files.length,
    repositoryCommit: gitCommit(),
    requestedModel: options.model,
    reasoningEffort: options.reasoningEffort,
    instructionIsolation: 'instruction-free-eval-root-with-nested-repo',
    privateProtocolSha256,
    evaluatorSourceSha256,
  };
}

function buildPrompt(systemPrompt: string, task: EvalTask): string {
  return `${systemPrompt.trim()}\n\nTask:\n${task.prompt}\n\nStructured claim contract:\n${JSON.stringify(buildPublicClaimContract(task), null, 2)}\n\nReturn only JSON with exactly one top-level property, \"claims\". Supply exactly one typed value for every claim ID; do not add prose or extra claims.\n`;
}

function failedRun(
  task: EvalTask,
  arm: EvalRun['arm'],
  repetition: number,
  systemPrompt: string,
  provenance: EvalProvenance,
  error: string,
): EvalRun {
  return {
    runId: `${task.id}:${arm}:${repetition}`,
    taskId: task.id,
    arm,
    repetition,
    protocolVersion: provenance.protocolVersion,
    model: provenance.requestedModel,
    modelVersion: provenance.requestedModel,
    reasoningEffort: provenance.reasoningEffort,
    candidateImageId: provenance.candidateImageId,
    codexCliVersion: provenance.codexCliVersion,
    sourceSnapshotFingerprint: provenance.sourceSnapshotFingerprint,
    sourceSnapshotFingerprintAfter: provenance.sourceSnapshotFingerprint,
    sourceSnapshotFileCount: provenance.sourceSnapshotFileCount,
    repositoryCommit: provenance.repositoryCommit,
    taskPrompt: task.prompt,
    systemPromptSha256: sha256(systemPrompt),
    claimContractSha256: computeClaimContractSha256(task),
    privateProtocolSha256: provenance.privateProtocolSha256,
    evaluatorSourceSha256: provenance.evaluatorSourceSha256,
    toolIdentityAllowlist: [...EVAL_PROTOCOL.toolIdentityAllowlist],
    maxToolCalls: EVAL_PROTOCOL.maxToolCalls,
    toolCallCount: 0,
    toolCalls: [],
    toolOutputBytes: 0,
    filesOpened: [],
    sourceBytes: 0,
    wallTimeMs: 0,
    peakCgroupMemoryBytes: 0,
    errors: [error],
    answerClaims: {},
    rawTrace: '',
    runtimeStderr: '',
    threadId: '',
    instructionIsolation: provenance.instructionIsolation,
    filesOpenedMeasurementMethod: EVAL_PROTOCOL.filesOpenedMeasurementMethod,
    readonly: true,
    freshSession: false,
    byteCountingMethod: EVAL_PROTOCOL.byteCountingMethod,
    cgroupMeasurementMethod: EVAL_PROTOCOL.cgroupMeasurementMethod,
  };
}

function executeCodexRun(
  options: AgentEvaluationOptions,
  snapshot: PreparedSourceSnapshot,
  provenance: EvalProvenance,
  task: EvalTask,
  arm: EvalRun['arm'],
  repetition: number,
  systemPrompt: string,
): EvalRun {
  const runSlug = `${task.id}-${arm}-${repetition}`.replace(/[^a-z0-9_.-]+/gi, '-').toLowerCase();
  const runRoot = path.join(snapshot.temporaryRoot, 'runs', runSlug);
  const cachePath = path.join(runRoot, 'cache');
  const runtimePath = path.join(runRoot, 'runtime');
  const codexHomePath = path.join(runRoot, 'codex-home');
  for (const directory of [cachePath, runtimePath]) {
    mkdirSync(directory, { recursive: true });
    chmodSync(directory, 0o777);
  }
  prepareCodexHome(options.codexAuthPath, codexHomePath);
  const containerName = `graphify-agent-eval-${createHash('sha256').update(runSlug).digest('hex').slice(0, 16)}`;
  const dockerCommand = buildPinnedCodexEvalDockerCommand(provenance.candidateImageId, {
    containerName,
    worktreesPath: snapshot.worktreesPath,
    cachePath,
    runtimePath,
    codexHomePath,
  });
  const started = runCommand(dockerCommand, undefined, 30_000);
  if (started.exitCode !== 0) {
    return failedRun(
      task,
      arm,
      repetition,
      systemPrompt,
      provenance,
      `candidate container failed to start: ${started.error ?? started.stderr}`,
    );
  }
  let trace = '';
  let runtimeStderr = '';
  let wallTimeMs = 0;
  let peakCgroupMemoryBytes = 0;
  let processError: string | undefined;
  try {
    const command = buildCodexExecCommand(containerName, options.model, options.reasoningEffort);
    const began = performance.now();
    const execution = runCommand(command, buildPrompt(systemPrompt, task));
    wallTimeMs = performance.now() - began;
    trace = execution.stdout;
    runtimeStderr = execution.stderr;
    if (execution.exitCode !== 0)
      processError = `Codex exited ${execution.exitCode}: ${execution.error ?? execution.stderr}`;
    const peak = runCommand(['docker', 'exec', containerName, 'cat', '/sys/fs/cgroup/memory.peak'], undefined, 30_000);
    if (peak.exitCode === 0 && /^\d+$/.test(peak.stdout.trim())) peakCgroupMemoryBytes = Number(peak.stdout.trim());
    else
      processError = [processError, `cannot read cgroup memory.peak: ${peak.error ?? peak.stderr}`]
        .filter(Boolean)
        .join('; ');
  } finally {
    runCommand(['docker', 'rm', '-f', containerName], undefined, 30_000);
  }
  const parsed = parseCodexJsonlTrace(trace, snapshot.files);
  const fingerprintAfter = currentSnapshotFingerprint(snapshot);
  const sourceBytes = parsed.filesOpened.reduce(
    (total, file) => total + statSync(path.join(snapshot.repositoryPath, file)).size,
    0,
  );
  const errors = [...parsed.errors];
  if (processError) errors.push(processError);
  if (fingerprintAfter !== provenance.sourceSnapshotFingerprint) errors.push('read-only source snapshot changed');
  return {
    runId: `${task.id}:${arm}:${repetition}`,
    taskId: task.id,
    arm,
    repetition,
    protocolVersion: provenance.protocolVersion,
    model: provenance.requestedModel,
    modelVersion: provenance.requestedModel,
    reasoningEffort: provenance.reasoningEffort,
    candidateImageId: provenance.candidateImageId,
    codexCliVersion: provenance.codexCliVersion,
    sourceSnapshotFingerprint: provenance.sourceSnapshotFingerprint,
    sourceSnapshotFingerprintAfter: fingerprintAfter,
    sourceSnapshotFileCount: provenance.sourceSnapshotFileCount,
    repositoryCommit: provenance.repositoryCommit,
    taskPrompt: task.prompt,
    systemPromptSha256: sha256(systemPrompt),
    claimContractSha256: computeClaimContractSha256(task),
    privateProtocolSha256: provenance.privateProtocolSha256,
    evaluatorSourceSha256: provenance.evaluatorSourceSha256,
    toolIdentityAllowlist: [...EVAL_PROTOCOL.toolIdentityAllowlist],
    maxToolCalls: EVAL_PROTOCOL.maxToolCalls,
    toolCallCount: parsed.toolCalls.length,
    toolCalls: parsed.toolCalls,
    toolOutputBytes: parsed.toolOutputBytes,
    filesOpened: parsed.filesOpened,
    sourceBytes,
    wallTimeMs,
    peakCgroupMemoryBytes,
    errors,
    answerClaims: parsed.answerClaims,
    rawTrace: trace,
    runtimeStderr,
    threadId: parsed.threadId,
    instructionIsolation: provenance.instructionIsolation,
    filesOpenedMeasurementMethod: EVAL_PROTOCOL.filesOpenedMeasurementMethod,
    readonly: fingerprintAfter === provenance.sourceSnapshotFingerprint,
    freshSession: parsed.threadId.length > 0,
    byteCountingMethod: EVAL_PROTOCOL.byteCountingMethod,
    cgroupMeasurementMethod: EVAL_PROTOCOL.cgroupMeasurementMethod,
  };
}

export function runAgentEvaluationProbe(options: AgentEvaluationOptions): {
  status: 'PROBE';
  provenance: EvalProvenance;
  run: EvalRun;
} {
  const tasks = JSON.parse(readFileSync(options.tasksPath, 'utf8')) as EvalTaskFile;
  const taskValidation = validateEvalTaskFile(tasks);
  if (!taskValidation.passed) throw new Error(`invalid evaluation task schema: ${taskValidation.failures.join('; ')}`);
  const optionFailure = evaluationOptionFailure(options);
  if (optionFailure) throw new Error(optionFailure);
  const systems: EvalSystemPrompts = {
    graphify: readFileSync(options.graphifySystemPath, 'utf8'),
    'source-only': readFileSync(options.sourceOnlySystemPath, 'utf8'),
  };
  const evaluatorSourceSha256 = computeEvaluatorSourceSha256();
  const privateProtocolSha256 = computePrivateProtocolSha256(tasks, systems, evaluatorSourceSha256);
  const snapshot = prepareSourceSnapshot(options.repositoryRoot, tasks);
  try {
    const provenance = inspectProvenance(options, snapshot, privateProtocolSha256, evaluatorSourceSha256);
    const run = executeCodexRun(options, snapshot, provenance, tasks.tasks[0], 'graphify', 0, systems.graphify);
    run.runId = `probe:${tasks.tasks[0].id}:graphify:0`;
    mkdirSync(options.outputDirectory, { recursive: true });
    writeFileSync(
      path.join(options.outputDirectory, 'agent-eval-probe.json'),
      `${JSON.stringify({ status: 'PROBE', provenance, run }, null, 2)}\n`,
      'utf8',
    );
    return { status: 'PROBE', provenance, run };
  } finally {
    rmSync(snapshot.temporaryRoot, { recursive: true, force: true });
  }
}

export function runAgentEvaluation(options: AgentEvaluationOptions): {
  status: 'COMPLETE' | 'BLOCKED';
  reason?: string;
  runs: EvalRun[];
  validation?: EvalValidationResult;
  provenance?: EvalProvenance;
} {
  const tasks = JSON.parse(readFileSync(options.tasksPath, 'utf8')) as EvalTaskFile;
  const taskValidation = validateEvalTaskFile(tasks);
  if (!taskValidation.passed) {
    return {
      status: 'BLOCKED',
      reason: `invalid evaluation task schema: ${taskValidation.failures.join('; ')}`,
      runs: [],
    };
  }
  const optionFailure = evaluationOptionFailure(options);
  if (optionFailure) return { status: 'BLOCKED', reason: optionFailure, runs: [] };
  mkdirSync(options.outputDirectory, { recursive: true });
  const rawPath = path.join(options.outputDirectory, 'agent-eval-runs.jsonl');
  const summaryPath = path.join(options.outputDirectory, 'agent-eval-summary.json');
  if (existsSync(rawPath) && readFileSync(rawPath, 'utf8').trim().length > 0) {
    const blocked = {
      status: 'BLOCKED' as const,
      reason: 'raw evaluation runs already exist; refusing to replace or selectively rerun retained evidence',
      requiredRuns: 36,
      retainedRuns: readFileSync(rawPath, 'utf8').split(/\r?\n/).filter(Boolean).length,
    };
    writeFileSync(summaryPath, `${JSON.stringify(blocked, null, 2)}\n`, 'utf8');
    return { ...blocked, runs: [] };
  }

  const systems: EvalSystemPrompts = {
    graphify: readFileSync(options.graphifySystemPath, 'utf8'),
    'source-only': readFileSync(options.sourceOnlySystemPath, 'utf8'),
  };
  const evaluatorSourceSha256 = computeEvaluatorSourceSha256();
  const privateProtocolSha256 = computePrivateProtocolSha256(tasks, systems, evaluatorSourceSha256);
  let snapshot: PreparedSourceSnapshot;
  try {
    snapshot = prepareSourceSnapshot(options.repositoryRoot, tasks);
  } catch (error) {
    return { status: 'BLOCKED', reason: `evaluation snapshot preflight failed: ${String(error)}`, runs: [] };
  }
  const runs: EvalRun[] = [];
  writeFileSync(rawPath, '', 'utf8');
  try {
    const provenance = inspectProvenance(options, snapshot, privateProtocolSha256, evaluatorSourceSha256);
    for (const task of tasks.tasks) {
      for (const arm of ['graphify', 'source-only'] as const) {
        for (let repetition = 1; repetition <= 3; repetition += 1) {
          let run: EvalRun;
          try {
            run = executeCodexRun(options, snapshot, provenance, task, arm, repetition, systems[arm]);
          } catch (error) {
            run = failedRun(
              task,
              arm,
              repetition,
              systems[arm],
              provenance,
              `direct Codex adapter failed: ${String(error)}`,
            );
          }
          runs.push(run);
          appendFileSync(rawPath, `${JSON.stringify(run)}\n`, 'utf8');
        }
      }
    }
    const validation = validateEvalRuns(tasks, runs, systems);
    const complete = {
      status: 'COMPLETE' as const,
      runs: runs.length,
      provenance,
      validation,
    };
    writeFileSync(summaryPath, `${JSON.stringify(complete, null, 2)}\n`, 'utf8');
    return { status: 'COMPLETE', runs, validation, provenance };
  } finally {
    rmSync(snapshot.temporaryRoot, { recursive: true, force: true });
  }
}

function main(): void {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const evalRoot = path.join(root, 'docs/specs/graphify-container-code-intelligence/eval');
  const protocolRoot = path.join(evalRoot, EVAL_PROTOCOL.version);
  const outputDirectory = path.join(
    root,
    '.claude/tmp/graphify-agent-eval',
    EVAL_PROTOCOL.version,
  );
  const mode = process.argv[2];
  if (mode !== '--probe' && mode !== '--full') throw new Error('exactly one mode is required: --probe or --full');
  const options: AgentEvaluationOptions = {
    tasksPath: path.join(evalRoot, 'tasks.json'),
    graphifySystemPath: path.join(protocolRoot, 'system-graphify.md'),
    sourceOnlySystemPath: path.join(protocolRoot, 'system-source-only.md'),
    outputDirectory,
    repositoryRoot: root,
    image: process.env.GRAPHIFY_EVAL_IMAGE ?? 'nanoclaw-agent-v2-2a38bd3e:latest',
    model: process.env.GRAPHIFY_EVAL_MODEL ?? 'gpt-5.6-sol',
    reasoningEffort: process.env.GRAPHIFY_EVAL_REASONING_EFFORT ?? 'xhigh',
    codexAuthPath: process.env.GRAPHIFY_EVAL_CODEX_AUTH ?? path.join(os.homedir(), '.codex', 'auth.json'),
  };
  if (mode === '--probe') {
    const probe = runAgentEvaluationProbe(options);
    process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
    if (probe.run.errors.length > 0 || !probe.run.threadId || !probe.run.readonly) process.exitCode = 1;
    return;
  }
  const result = runAgentEvaluation(options);
  process.stdout.write(
    `${JSON.stringify({ status: result.status, reason: result.reason, provenance: result.provenance, validation: result.validation }, null, 2)}\n`,
  );
  if (
    result.status === 'BLOCKED' ||
    result.validation?.passed !== true ||
    result.validation.summary?.activation.passed !== true
  ) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
