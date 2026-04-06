/**
 * Outbound secret scrubber.
 *
 * readSecrets() registers credential values at container launch.
 * formatOutbound() calls scrub() before text reaches any channel.
 */

const secretValues = new Set<string>();

/** Minimum length to register — avoids false positives on short values. */
const MIN_LENGTH = 8;

/**
 * Register secret values for scrubbing. Called once per container launch
 * with the secrets that were piped to stdin.
 */
export function registerSecrets(secrets: Record<string, string>): void {
  for (const value of Object.values(secrets)) {
    if (value && value.length >= MIN_LENGTH) {
      secretValues.add(value);
    }
  }
}

/**
 * Replace any registered secret values in text with [REDACTED].
 * Fast no-op when no secrets are registered.
 */
export function scrubSecrets(text: string): string {
  if (secretValues.size === 0 || !text) return text;
  let result = text;
  for (const secret of secretValues) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, '[REDACTED]');
    }
  }
  return result;
}
