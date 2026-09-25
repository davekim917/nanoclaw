/**
 * The only Claude CLI form allowed to borrow runner-held credentials.
 *
 * Keeping this grammar small is deliberate: callers cannot turn the local
 * review socket into a general privileged process launcher.
 */
export const CLAUDE_REVIEW_SOCKET_ENV = 'NANOCLAW_CLAUDE_REVIEW_SOCKET';
export const MAX_CLAUDE_REVIEW_PROMPT_BYTES = 32 * 1024 * 1024;
export const MAX_CLAUDE_REVIEW_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CLAUDE_REVIEW_CWD_BYTES = 4096;
const MAX_CLAUDE_REVIEW_SCHEMA_BYTES = 256 * 1024;
// JSON can expand each control byte to six ASCII bytes. Raw input/output limits
// remain authoritative; these caps also accommodate their wire representation.
export const MAX_CLAUDE_REVIEW_REQUEST_BYTES =
  Math.ceil((MAX_CLAUDE_REVIEW_PROMPT_BYTES * 4) / 3) +
  6 * (MAX_CLAUDE_REVIEW_SCHEMA_BYTES + MAX_CLAUDE_REVIEW_CWD_BYTES + 1024);
export const MAX_CLAUDE_REVIEW_RESPONSE_BYTES = 6 * MAX_CLAUDE_REVIEW_OUTPUT_BYTES + 1024 * 1024;

export interface ClaudeReviewArgs {
  model: string;
  effort: string;
  jsonSchema?: string;
}

export interface ClaudeReviewRequest extends ClaudeReviewArgs {
  /** Raw stdin, carried as canonical base64 over the local JSON socket. */
  stdin: Buffer;
  cwd: string;
}

export interface ClaudeReviewWireRequest extends ClaudeReviewArgs {
  stdinBase64: string;
  cwd: string;
}

export interface ClaudeReviewResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const VALUE_OPTIONS = new Set([
  '--model',
  '--effort',
  '--permission-mode',
  '--tools',
  '--output-format',
  '--json-schema',
]);
const FLAG_OPTIONS = new Set(['-p', '--print', '--safe-mode', '--no-session-persistence', '--strict-mcp-config']);

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function isNonEmptyValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !hasNul(value);
}

/**
 * Return the constrained review details, or null when this is an ordinary
 * Claude CLI call. Null must always pass through to the pinned original CLI.
 */
export function parseClaudeReviewArgs(argv: readonly string[]): ClaudeReviewArgs | null {
  const seen = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (FLAG_OPTIONS.has(option)) {
      const canonical = option === '-p' || option === '--print' ? 'print' : option;
      if (seen.has(canonical)) return null;
      seen.add(canonical);
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) return null;
    if (seen.has(option)) return null;
    const value = argv[++index];
    // --tools intentionally has one safe value; every other option needs a
    // non-switch value so a flag can never be smuggled in as an argument.
    if (option === '--tools') {
      if (value !== '') return null;
    } else if (!isNonEmptyValue(value)) {
      return null;
    }
    seen.add(option);
    values.set(option, value);
  }

  const requiredFlags = ['print', '--safe-mode', '--no-session-persistence', '--strict-mcp-config'];
  const requiredValues: Array<[string, string]> = [
    ['--model', ''],
    ['--effort', ''],
    ['--permission-mode', 'plan'],
    ['--tools', ''],
    ['--output-format', 'json'],
  ];
  if (!requiredFlags.every((flag) => seen.has(flag))) return null;
  if (
    !requiredValues.every(
      ([option, expected]) => values.has(option) && (expected === '' || values.get(option) === expected),
    )
  ) {
    return null;
  }
  const model = values.get('--model');
  const effort = values.get('--effort');
  if (!model || !effort) return null;
  const jsonSchema = values.get('--json-schema');
  return jsonSchema === undefined ? { model, effort } : { model, effort, jsonSchema };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes: number, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || hasNul(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`invalid Claude review ${field}`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`Claude review ${field} exceeds ${maxBytes} bytes`);
  return value;
}

/** Service-side validation remains strict even for a locally connected client. */
export function validateClaudeReviewRequest(value: unknown): ClaudeReviewRequest {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('invalid Claude review request');
  }
  const allowed = new Set(['stdinBase64', 'cwd', 'model', 'effort', 'jsonSchema']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid Claude review request field');
  const stdinBase64 = boundedString(value.stdinBase64, MAX_CLAUDE_REVIEW_REQUEST_BYTES, 'stdin', true);
  // Do not use a grouped base64 regexp here: V8/Bun can hit a backtracking
  // guard on a valid multi-megabyte prompt. The canonical round-trip below
  // validates padding and grouping without a second unbounded parser.
  if (stdinBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(stdinBase64)) {
    throw new Error('invalid Claude review stdin');
  }
  const stdin = Buffer.from(stdinBase64, 'base64');
  if (stdin.byteLength > MAX_CLAUDE_REVIEW_PROMPT_BYTES || stdin.toString('base64') !== stdinBase64) {
    throw new Error('invalid Claude review stdin');
  }
  const cwd = boundedString(value.cwd, MAX_CLAUDE_REVIEW_CWD_BYTES, 'cwd');
  if (!cwd.startsWith('/')) throw new Error('invalid Claude review cwd');
  const model = boundedString(value.model, 512, 'model');
  const effort = boundedString(value.effort, 64, 'effort');
  const jsonSchema =
    value.jsonSchema === undefined
      ? undefined
      : boundedString(value.jsonSchema, MAX_CLAUDE_REVIEW_SCHEMA_BYTES, 'json schema');
  if (model.startsWith('-') || effort.startsWith('-') || jsonSchema?.startsWith('-')) {
    throw new Error('invalid Claude review option value');
  }
  return jsonSchema === undefined ? { stdin, cwd, model, effort } : { stdin, cwd, model, effort, jsonSchema };
}

export function toClaudeReviewWireRequest(request: ClaudeReviewRequest): ClaudeReviewWireRequest {
  return {
    cwd: request.cwd,
    model: request.model,
    effort: request.effort,
    stdinBase64: request.stdin.toString('base64'),
    ...(request.jsonSchema === undefined ? {} : { jsonSchema: request.jsonSchema }),
  };
}

export function isClaudeReviewResponse(value: unknown): value is ClaudeReviewResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

export function reviewCliArgs(request: ClaudeReviewRequest): string[] {
  const args = [
    '-p',
    '--model',
    request.model,
    '--effort',
    request.effort,
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode',
    'plan',
    '--tools',
    '',
    '--strict-mcp-config',
    '--output-format',
    'json',
  ];
  if (request.jsonSchema !== undefined) args.push('--json-schema', request.jsonSchema);
  return args;
}
