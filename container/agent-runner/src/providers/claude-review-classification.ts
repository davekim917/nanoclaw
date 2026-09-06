/** SDK-free quota classification shared by native and CLI review rotation. */
const QUOTA_PATTERN_BODY =
  "You['’]?(re|ve) (out of (extra |daily |weekly )?usage|(hit|reached) your ((org['’]?s |team['’]?s |account['’]?s |individual |session |usage |weekly |daily |monthly |annual |spend(ing)? |token |credit )*)limit)\\b";

export const QUOTA_RESULT_RE = new RegExp(`^\\s*${QUOTA_PATTERN_BODY}`, 'i');
export const QUOTA_EMBEDDED_RE = new RegExp(QUOTA_PATTERN_BODY, 'i');

const SUBSCRIPTION_BLOCKED_PATTERN_BODY =
  'Your (organization|org|team|admin|account) has disabled Claude( Code)?( subscription)? access\\b';

export const SUBSCRIPTION_BLOCKED_RE = new RegExp(`^\\s*${SUBSCRIPTION_BLOCKED_PATTERN_BODY}`, 'i');
export const SUBSCRIPTION_BLOCKED_EMBEDDED_RE = new RegExp(SUBSCRIPTION_BLOCKED_PATTERN_BODY, 'i');

/** Only known account-local failures with no inference are safe to rotate. */
export function isPreInferenceCredentialFailure(stdout: string): boolean {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    return false;
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  if (record.is_error !== true || typeof record.result !== 'string') return false;
  const usage = record.usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return false;
  const usageRecord = usage as Record<string, unknown>;
  const zeroUsageFields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  if (!zeroUsageFields.every((field) => usageRecord[field] === 0)) return false;
  if (!allNumbersZero(usageRecord.output_tokens_details) || !allNumbersZero(usageRecord.server_tool_use)) return false;
  if (!allNumbersZero(record.modelUsage)) return false;
  return QUOTA_RESULT_RE.test(record.result) || SUBSCRIPTION_BLOCKED_RE.test(record.result);
}

/** Undefined is fine; any supplied numeric usage counter must be zero. */
function allNumbersZero(value: unknown, depth = 0): boolean {
  if (value === undefined || value === null) return true;
  if (depth > 5) return false;
  if (typeof value === 'number') return value === 0;
  if (Array.isArray(value)) return value.every((entry) => allNumbersZero(entry, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.values(value).every((entry) => allNumbersZero(entry, depth + 1));
}
