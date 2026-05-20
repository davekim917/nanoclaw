import type Database from 'better-sqlite3';

import type { SlackUserTokenConfig } from '../../container-config.js';

/**
 * Per-spawn permission gate for the Slack user-token MCP.
 *
 * The agent's container.json sets `slack_user_token.enabled: true` to grant
 * the CAPABILITY at all. This function decides whether — for THIS session's
 * messaging context — the MCP should be registered in the per-spawn config.
 *
 * Fail-closed semantics:
 *   - Capability not enabled → never register
 *   - Session has no messaging_group (e.g., admin shell) → never register
 *   - Default: only register when the session is in a 1:1 DM AND a global
 *     OWNER has been recorded with a DM in the same WORKGROUP as the
 *     session's agent. The Slack MCP reads from the owner's lens; surfacing
 *     it in a shared channel (is_group=1) or in a workgroup where no owner
 *     has registered a DM would let teammates query the owner's Slack
 *     through the agent.
 *   - Override: `also_allowed_in` is an operator-curated list of
 *     `messaging_group.id` values that bypass the default. Use for trusted
 *     private channels (e.g., a channel that's just the owner + a vetted
 *     collaborator where queries from the owner's lens are acceptable).
 *
 * Matching identity across sibling adapters:
 *
 *   Codex twins (and any future sibling agent with its own bot user) get
 *   their own channel adapter, so the same human appears as TWO distinct
 *   `users` rows — `slack-madisonreed:U0…` for the bo DM and
 *   `slack-madisonreed-codex:U0…` for the bo-codex DM. A naive exact-match
 *   gate only sees owner on the adapter the operator originally talked to.
 *
 *   Earlier iterations of this fix tried to fold sibling identities by
 *   parsing channel_type strings (`familyOf`, `slackWorkspaceOf` with
 *   suffix-stripping). Codex's review correctly flagged TWO bypasses with
 *   that approach: (1) `slack-*` family collapse let any Slack workspace
 *   match another's owner via handle collision, (2) stripping `-codex` from
 *   the end let a workspace literally named `acme-codex` collide with `acme`.
 *
 *   The fix uses TWO orthogonal checks, both required:
 *
 *     (a) HANDLE equality. user_ids are formatted `<channel_type>:<handle>`
 *         per the schema's documented contract. The handle segment after
 *         the first colon is reliable — no operator-defined suffixes to
 *         mis-parse. We compare the session-DM user's handle to the global
 *         owner's handle.
 *
 *     (b) WORKGROUP membership. The session's messaging_group is wired to
 *         an agent_group with a workgroup_id; the owner's recorded DM
 *         (user_dms entry) must be wired to an agent in the SAME
 *         workgroup. Different Slack workspaces have different workgroups
 *         by construction, so cross-workspace handle collision can't
 *         authorize — even if a different human in a different workspace
 *         happens to have the same Slack user-id handle.
 *
 *   For Dave's install (the production bug that motivated this PR):
 *     - bo-codex session DM user: `slack-mr-codex:UDAVE` (handle UDAVE,
 *       workgroup `mr`).
 *     - Global owner: `slack-mr:UDAVE` (handle UDAVE) with user_dms
 *       wired to ag-bo (workgroup `mr`).
 *     - Handle match (UDAVE) ✓ + workgroup match (`mr`) ✓ → ALLOW.
 *
 *   For the hypothetical workspace-literally-named-codex bypass attempt:
 *     - `acme-codex-ws` is a Slack workspace named `acme-codex` (legitimate).
 *     - Its agent_groups have workgroup_id `acme-codex-ws`, not `acme`.
 *     - The session's workgroup_id is `acme-codex-ws`; the `acme` owner's
 *       user_dms is wired to workgroup `acme`. Workgroup mismatch → DENY.
 *     - No string parsing involved.
 *
 * The check is run at spawn time, not per-tool-call: if the gate denies, the
 * MCP server is never spawned for this session, so the in-container agent
 * cannot invoke its tools at all. That's safer than runtime per-call gating
 * (no risk of an LLM bypass, no per-call DB lookup hot path).
 */
export function canUseSlackUserToken(
  db: Database.Database,
  sessionMessagingGroupId: string | null,
  config: SlackUserTokenConfig | undefined,
): boolean {
  if (!config?.enabled) return false;
  if (!sessionMessagingGroupId) return false;

  if (config.also_allowed_in?.includes(sessionMessagingGroupId)) return true;

  // The default safe path. Requires ALL of:
  //   1. session's messaging_group is a 1:1 DM (is_group = 0)
  //   2. session's messaging_group is wired to an agent with a non-null
  //      workgroup_id (post-migration-036; standalone agents are workgroup-
  //      of-1, which is also fine since the workgroup_id then equals the
  //      agent's own folder slug)
  //   3. the user on the OTHER end of the session's DM (per user_dms) has
  //      the same HANDLE as a global owner (role='owner', agent_group_id
  //      IS NULL)
  //   4. that owner has a user_dms entry wired to an agent in the SAME
  //      workgroup as the session's agent
  //
  // (3) identifies the same human across sibling adapters. (4) constrains
  // it to the trust boundary — different Slack workspaces have different
  // workgroups by construction, so a collision in (3) alone can't
  // authorize. Both must hold.
  //
  // Handle = `substr(user_id, instr(user_id, ':') + 1)`. user_ids follow
  // the format `<channel_type>:<handle>` per schema contract.
  const row = db
    .prepare(
      `SELECT 1
       FROM messaging_group_agents mga_session
       JOIN agent_groups            a_session  ON a_session.id  = mga_session.agent_group_id
       JOIN messaging_groups        mg_session ON mg_session.id = mga_session.messaging_group_id
       JOIN user_dms                ud_session ON ud_session.messaging_group_id = mga_session.messaging_group_id
       JOIN user_roles              ur         ON ur.role = 'owner'
                                                  AND ur.agent_group_id IS NULL
                                                  AND substr(ur.user_id, instr(ur.user_id, ':') + 1)
                                                      = substr(ud_session.user_id, instr(ud_session.user_id, ':') + 1)
       JOIN user_dms                ud_owner   ON ud_owner.user_id = ur.user_id
       JOIN messaging_group_agents  mga_owner  ON mga_owner.messaging_group_id = ud_owner.messaging_group_id
       JOIN agent_groups            a_owner    ON a_owner.id = mga_owner.agent_group_id
       WHERE mga_session.messaging_group_id = ?
         AND mg_session.is_group = 0
         AND a_session.workgroup_id IS NOT NULL
         AND a_owner.workgroup_id  = a_session.workgroup_id
       LIMIT 1`,
    )
    .get(sessionMessagingGroupId);

  return row !== undefined;
}
