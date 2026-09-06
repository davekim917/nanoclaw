/**
 * Slack-rooms guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * `rooms.create` — opening a Slack conversation and wiring it to N agent
 * groups is central-DB state plus an outward-facing side effect, so it takes
 * the same posture `agents.create` takes: a trusted `global` cli_scope group
 * acts directly, and everything else — the default `group` scope, and any
 * unknown value, fail-closed — holds for the requesting group's admin chain.
 *
 * `rooms.add_agent` — same, with one widening the fork's data-pool boundary
 * already justifies: adding a SIBLING (an agent group in the caller's own
 * workgroup) is allowed unheld. Siblings already share the workgroup's chat
 * archive, files and secret union, so a room between them exposes nothing an
 * approval would be protecting; a non-sibling crosses that boundary and holds.
 *
 * Both decisions stay SYNCHRONOUS (seam-3 plan §4.5, I-1). The only central
 * read here is `cli_scope`, executed through the container-configs leaf's
 * exported SQL under `withRawDb` — exactly the shape `agents.create` uses. The
 * facts that would otherwise need an await (which agent group a name resolves
 * to, which workgroup each side belongs to) are derived by the delivery
 * guard's PRECHECK and stamped onto the request payload before this runs. The
 * precheck re-runs on every approved replay, so those facts are live on the
 * replay too — a sibling relationship revoked between card and click is
 * caught, and the decision falls back to a hold rather than executing.
 */
import { withRawDb } from '../../db/central-lease.js';
import { CONTAINER_CONFIG_BY_GROUP_SQL } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

/** pending_approvals.action strings — the keys a grant is matched on. */
export const CREATE_ROOM_ACTION = 'create_room';
export const ADD_TO_ROOM_ACTION = 'add_to_room';

/**
 * Payload keys the precheck stamps for the guard. Named here so the two sides
 * cannot drift: a key renamed on one side is a compile error on the other.
 */
export const CALLER_WORKGROUP_KEY = 'caller_workgroup_id';
export const TARGET_WORKGROUP_KEY = 'target_workgroup_id';
export const TARGET_AGENT_GROUP_KEY = 'target_agent_group_id';
export const ROOM_PLATFORM_ID_KEY = 'room_platform_id';
/**
 * The room's Slack workspace. Slack channel ids are workspace-scoped, so the
 * id alone does not identify a room on a multi-workspace install: if the
 * approved room's wiring disappears while the card waits and a sibling room in
 * ANOTHER workspace is left holding the same id, an id-only comparison accepts
 * it and the replay discloses a room the approver never saw.
 */
export const ROOM_TEAM_ID_KEY = 'room_team_id';
/**
 * The Slack account the card said would be invited. `pickApprover` is
 * recomputed on every run, so a role granted while the card waits can change
 * who "your Slack account" resolves to — binding it keeps the approval from
 * admitting a human the approver did not name.
 */
export const OPERATOR_KEY = 'operator_slack_user_id';
/**
 * The resolved roster, as a sorted list of `"<agentGroupId>|<channelType>|<botUserId>|<teamId>"`.
 * A create_room approval binds to it, so a destination repointed between card
 * and click cannot smuggle a different agent — or a different Slack bot for
 * the same agent — into the room the approver said yes to.
 */
export const ROSTER_KEY = 'resolved_roster';

/** Order-insensitive equality over the roster stamps. */
function sameRoster(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return false;
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.every((value, index) => value === right[index]);
}

// Synchronous by design (seam-3 plan §4.5, I-1): runs inside the delivery
// guard's `withCentralSync` block and never awaits. The central read executes
// the leaf's exported SQL through `withRawDb`.
function cliScopeOf(agentGroupId: string): string {
  const row = withRawDb((raw) => raw.prepare(CONTAINER_CONFIG_BY_GROUP_SQL).get(agentGroupId)) as
    | { cli_scope: string | null }
    | undefined;
  return row?.cli_scope ?? 'group';
}

function stringOf(input: GuardInput, key: string): string | null {
  const value = input.payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export const roomsCreate = defineGuardedAction({
  action: 'rooms.create',
  grantActionName: CREATE_ROOM_ACTION,
  /**
   * Bind a create_room grant to the room name AND the resolved roster.
   *
   * The name alone was not enough. A non-global caller's card can sit for a
   * while, and an `agents` destination is repointable in that window: the
   * replay's precheck faithfully re-resolves the new target, and a name-only
   * comparison then let an existing approval authorize inviting a participant
   * the approver never saw. The roster stamp carries each participant's agent
   * group, channel type, bot user id and workspace, so a swap on any of those
   * axes — a different agent, or the same agent on a different Slack bot —
   * fails the check and the replay denies instead of executing.
   *
   * Order-insensitive because the participant order is derived from the
   * caller's argument list, not from anything the approver decided.
   */
  grantCoversRequest: (grant, input) => {
    try {
      const approved = JSON.parse(grant.payload) as Record<string, unknown>;
      return (
        approved.name === input.payload.name &&
        // The operator is a member of the room like any bot is, so a change of
        // WHO gets invited is a change of roster even when the agents match.
        (approved[OPERATOR_KEY] ?? null) === (input.payload[OPERATOR_KEY] ?? null) &&
        sameRoster(approved[ROSTER_KEY], input.payload[ROSTER_KEY])
      );
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_room is a container-originated action.');
    if (cliScopeOf(input.actor.agentGroupId) === 'global') {
      return ALLOW('trusted global-scope agent group');
    }
    return HOLD('agent-initiated create_room requires admin approval');
  },
});

export const roomsAddAgent = defineGuardedAction({
  action: 'rooms.add_agent',
  grantActionName: ADD_TO_ROOM_ACTION,
  /**
   * Bind an add_to_room grant to BOTH halves of what was approved.
   *
   * The room half is bound by id rather than by name (case 12): the precheck
   * deliberately does not re-resolve a stamped `room_platform_id` from the
   * name, so a rename — or a second room created under the same name while the
   * card sat unanswered — cannot redirect the approval.
   *
   * The agent half is NOT symmetric: the precheck re-resolves the agent name
   * through the caller's destination namespace on every run, so this
   * comparison is live. A destination repointed at a different agent group
   * between card and click fails the check and the replay denies rather than
   * adding an agent nobody approved.
   */
  grantCoversRequest: (grant, input) => {
    try {
      const approved = JSON.parse(grant.payload) as Record<string, unknown>;
      return (
        approved[ROOM_PLATFORM_ID_KEY] === input.payload[ROOM_PLATFORM_ID_KEY] &&
        // Workspace as well as id — see ROOM_TEAM_ID_KEY.
        approved[ROOM_TEAM_ID_KEY] === input.payload[ROOM_TEAM_ID_KEY] &&
        approved[TARGET_AGENT_GROUP_KEY] === input.payload[TARGET_AGENT_GROUP_KEY]
      );
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('add_to_room is a container-originated action.');
    if (cliScopeOf(input.actor.agentGroupId) === 'global') {
      return ALLOW('trusted global-scope agent group');
    }
    // Fail closed: an unstamped payload (a hand-rolled consult, or a precheck
    // that could not resolve the workgroups) is never a sibling.
    const callerWorkgroup = stringOf(input, CALLER_WORKGROUP_KEY);
    const targetWorkgroup = stringOf(input, TARGET_WORKGROUP_KEY);
    if (callerWorkgroup && targetWorkgroup && callerWorkgroup === targetWorkgroup) {
      return ALLOW(`sibling agent group — both sides are in workgroup ${callerWorkgroup}`);
    }
    return HOLD('adding an agent outside your workgroup requires admin approval');
  },
});
