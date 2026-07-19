/**
 * Sibling-parity invariant: shared definition of which container.json fields
 * are allowed to differ between a source group and its sibling created via
 * `/clone-as-codex` / `/clone-as-opencode` (or future `/clone-as-<provider>`).
 *
 * Read by two consumers — they MUST agree:
 *   - `ncl groups parity-check` (`src/cli/resources/groups.ts`) — diffs source
 *     vs sibling, drift on any field NOT in this set.
 *   - The `/clone-as-*` skills — scaffold the sibling's container.json with
 *     fresh values for these fields and inherit everything else from source.
 *
 * Adding a sibling-bound field: add to this set + document why it's allowed
 * to differ. Removing: a field that used to differ must now match across
 * sibling+source; remove from this set, and the next parity-check run will
 * flag drift on any sibling created with the old behavior.
 */

/**
 * Container.json fields that may differ between source and sibling without
 * violating the parity invariant. Everything NOT in this set must match
 * structurally (deep JSON.stringify equality) on every parity-check.
 *
 * Categories:
 *   - Identity-bound: always per-group (folder/group/agent IDs, credentialFolder).
 *   - Provider-bound: the whole point of a sibling (provider, codexHostAuth).
 *   - Operator-tunable scalars: siblings may pick different model/effort
 *     tiers, image tags, or per-call defaults independently without changing
 *     skills/MCPs/tools/secrets.
 *   - Memory + summary: per-sibling memory state; one writer per workgroup.
 */
export const SIBLING_BOUND_FIELDS: ReadonlySet<string> = new Set([
  // Identity-bound (always per-group)
  'groupName',
  'assistantName',
  'agentGroupId',
  'credentialFolder',
  // Provider-bound (the reason siblings exist)
  'provider',
  'codexHostAuth',
  // Operator-tunable scalars
  'model',
  'effort',
  'imageTag',
  'defaultModel',
  'defaultEffort',
  'maxMessagesPerPrompt',
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
