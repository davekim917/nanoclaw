import { isDeepStrictEqual } from 'node:util';

/**
 * Which container.json fields may differ between a source group and its `/clone-as-*` sibling. `ncl groups
 * parity-check` and the `/clone-as-*` skills MUST agree on it. Removing a field makes the next parity-check flag
 * siblings created under the old rule.
 */

/** Everything NOT here must match structurally, apart from the semantic comparisons in `findSiblingParityDrifts`. */
export const SIBLING_BOUND_FIELDS: ReadonlySet<string> = new Set([
  // Identity-bound (always per-group)
  'groupName',
  'assistantName',
  'agentGroupId',
  'credentialFolder',
  // Attribution is an explicit per-agent opt-in; a sibling must never inherit it.
  'gitIdentity',
  // Provider-bound (the reason siblings exist)
  'provider',
  'codexAuthFallbacks',
  // Retired key, still ignored: parity-check reads the RAW container.json, where existing files disagree on it.
  // Remove once no `groups/*/container.json` carries it.
  'codexHostAuth',
  // Operator-tunable runtime
  'model',
  'effort',
  'imageTag',
  'defaultModel',
  'defaultEffort',
  'maxMessagesPerPrompt',
  'resources',
  // Memory + summary (per-sibling state; one writer per workgroup)
  'memory',
  'dailySummary',
]);

export function isSiblingBoundField(field: string): boolean {
  return SIBLING_BOUND_FIELDS.has(field);
}

export interface SiblingParityDrift {
  field: string;
  source: unknown;
  sibling: unknown;
}

function comparableSlackUserToken(value: unknown): unknown {
  if (value === null || value === undefined) return { enabled: false };
  if (typeof value !== 'object' || Array.isArray(value)) return value;

  const comparable = { ...(value as Record<string, unknown>) };
  delete comparable.also_allowed_in;
  comparable.enabled ??= false;
  return comparable;
}

function slackUserTokenEnabled(value: unknown): unknown {
  const comparable = comparableSlackUserToken(value);
  if (typeof comparable !== 'object' || comparable === null || Array.isArray(comparable)) return comparable;
  return (comparable as Record<string, unknown>).enabled;
}

/**
 * Diff on capability parity, not raw serialization: Slack's non-identity settings must match (the retired `enabled`
 * flag included), while `also_allowed_in` holds exact messaging-group ids and is identity-bound.
 */
export function findSiblingParityDrifts(
  source: Record<string, unknown>,
  sibling: Record<string, unknown>,
): SiblingParityDrift[] {
  const allKeys = new Set([...Object.keys(source), ...Object.keys(sibling)]);
  const drifts: SiblingParityDrift[] = [];

  for (const field of allKeys) {
    if (field === 'slack_user_token') {
      const sourceSlack = comparableSlackUserToken(source[field]);
      const siblingSlack = comparableSlackUserToken(sibling[field]);
      if (!isDeepStrictEqual(sourceSlack, siblingSlack)) {
        const sourceEnabled = slackUserTokenEnabled(source[field]);
        const siblingEnabled = slackUserTokenEnabled(sibling[field]);
        if (!isDeepStrictEqual(sourceEnabled, siblingEnabled)) {
          drifts.push({ field: 'slack_user_token.enabled', source: sourceEnabled, sibling: siblingEnabled });
        } else {
          drifts.push({ field, source: sourceSlack, sibling: siblingSlack });
        }
      }
      continue;
    }

    if (SIBLING_BOUND_FIELDS.has(field)) continue;
    const sourceValue = source[field] ?? null;
    const siblingValue = sibling[field] ?? null;
    if (!isDeepStrictEqual(sourceValue, siblingValue)) {
      drifts.push({ field, source: source[field], sibling: sibling[field] });
    }
  }

  return drifts;
}
