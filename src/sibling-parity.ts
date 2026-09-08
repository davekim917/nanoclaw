import { isDeepStrictEqual } from 'node:util';

/**
 * Sibling-parity invariant: shared definition of which container.json fields
 * are allowed to differ between a source group and its sibling created via
 * `/clone-as-codex` / `/clone-as-opencode` (or future `/clone-as-<provider>`).
 *
 * Read by two consumers — they MUST agree:
 *   - `ncl groups parity-check` (`src/cli/resources/groups.ts`) — diffs source
 *     vs sibling via `findSiblingParityDrifts` below.
 *   - The `/clone-as-*` skills — replace identity/provider state, preserve a
 *     safe resource baseline, and normalize identity-scoped nested fields.
 *
 * Adding a sibling-bound field: add to this set + document why it's allowed
 * to differ. Removing: a field that used to differ must now match across
 * sibling+source; remove from this set, and the next parity-check run will
 * flag drift on any sibling created with the old behavior.
 */

/**
 * Container.json fields that may differ between source and sibling without
 * violating the parity invariant. Everything NOT in this set must match
 * structurally on every parity-check, except for the semantic comparisons in
 * `findSiblingParityDrifts`.
 *
 * Categories:
 *   - Identity-bound: always per-group (folder/group/agent IDs, credentialFolder).
 *   - Provider-bound: the whole point of a sibling (provider, Codex auth).
 *   - Operator-tunable runtime: siblings may pick different model/effort
 *     tiers, image tags, per-call defaults, or resource budgets independently
 *     without changing skills/MCPs/tools/secrets.
 *   - Memory + summary: per-sibling memory state; one writer per workgroup.
 */
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
  'codexHostAuth',
  'codexAuthFallbacks',
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

/**
 * Convenience predicate for callers diffing two container.json objects.
 * Returns `true` for fields whose drift is expected/allowed.
 */
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
 * Diff two sibling configs on capability parity rather than raw serialization.
 * Slack's capability grant must match, while `also_allowed_in` contains exact
 * messaging-group IDs and is therefore identity-bound to each adapter.
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
