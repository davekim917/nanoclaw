export type FailureClass = 'recoverable' | 'blocking';
export interface ClassifiedError { class: FailureClass; reason: string; }

const BLOCKING_PATTERNS: Array<[RegExp, string]> = [
  [/ENOENT.*mnemon|mnemon.*not found|command not found/i, 'binary-missing'],
  [/database.*locked|disk image is malformed|store.*not.*found/i, 'store-db-inaccessible'],
  [/schema.*(mismatch|version|incompatible)/i, 'schema-mismatch'],
  [/permission denied/i, 'permission-denied'],
];

const RECOVERABLE_PATTERNS: Array<[RegExp, string]> = [
  [/connection refused.*11434|ollama.*(unreachable|timeout|connection)/i, 'ollama-unavailable'],
  [/network|timeout|ECONNRESET|ETIMEDOUT/i, 'network-transient'],
];

export function classifyError(err: Error): ClassifiedError {
  const msg = err.message;
  for (const [re, reason] of BLOCKING_PATTERNS) if (re.test(msg)) return { class: 'blocking', reason };
  for (const [re, reason] of RECOVERABLE_PATTERNS) if (re.test(msg)) return { class: 'recoverable', reason };
  return { class: 'recoverable', reason: 'unknown' };
}
