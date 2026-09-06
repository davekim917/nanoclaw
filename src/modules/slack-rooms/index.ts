/**
 * Slack-rooms module — `create_room` and `add_to_room` from chat, on the bot
 * tokens this install already has (theme T6 PR 5).
 *
 * A "room" is one private Slack channel shared by the operator and N agents.
 * The manual equivalent is the `slack-a2a-rooms` skill's
 * `scripts/open-a2a-room.ts`, which opens the conversation and then PRINTS the
 * `ncl` commands an operator has to run per participating bot; that script
 * stays as the operator fallback, and this module is the same sequence
 * executed by the host under a guard.
 *
 * Registers, exactly like `src/modules/self-mod/`:
 *   - Its guard-catalog entries (./guard.ts) — `rooms.create`,
 *     `rooms.add_agent`.
 *   - Two guard-wrapped delivery actions. Resolution runs as the wrapper's
 *     precheck (./request.ts), which is also what keeps the guard's decide
 *     synchronous; the hold builders card the admin through the generic
 *     approvals primitive; the bodies (./apply.ts) run only on allow.
 *   - Two approval handlers that re-enter the wrapped actions with the
 *     approval row as the grant, so the structural checks re-run live and an
 *     approval executes exactly once.
 *
 * Deliberately NOT ported from upstream's `slack-agent-flow` (t6-scope §3.8,
 * §7): the room canvas, `SLACK_A2A_ROOMS` / `slack-a2a-guard` (this fork
 * admits sibling bots everywhere, so an allowlist would be a regression), and
 * anything needing a manager token — no app is provisioned here, the rooms run
 * on tokens that already exist.
 *
 * Without this module: the container tools still write their outbound rows,
 * delivery logs "Unknown system action" and drops them, and nothing happens.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { handleAddToRoom, handleCreateRoom } from './apply.js';
import { ADD_TO_ROOM_ACTION, CREATE_ROOM_ACTION, roomsAddAgent, roomsCreate } from './guard.js';
import { requestAddToRoomHold, requestCreateRoomHold, validateAddToRoom, validateCreateRoom } from './request.js';

registerDeliveryAction(CREATE_ROOM_ACTION, handleCreateRoom, {
  guardAction: roomsCreate,
  precheck: validateCreateRoom,
  requestHold: requestCreateRoomHold,
  onDeny: (_content, session, reason) => {
    void notifyAgent(session, `create_room denied: ${reason}`).catch((err) =>
      log.error('Failed to notify agent of create_room denial', { err }),
    );
  },
});

registerDeliveryAction(ADD_TO_ROOM_ACTION, handleAddToRoom, {
  guardAction: roomsAddAgent,
  precheck: validateAddToRoom,
  requestHold: requestAddToRoomHold,
  onDeny: (_content, session, reason) => {
    void notifyAgent(session, `add_to_room denied: ${reason}`).catch((err) =>
      log.error('Failed to notify agent of add_to_room denial', { err }),
    );
  },
});

registerApprovalHandler(CREATE_ROOM_ACTION, reenterGuardedDeliveryAction(CREATE_ROOM_ACTION));
registerApprovalHandler(ADD_TO_ROOM_ACTION, reenterGuardedDeliveryAction(ADD_TO_ROOM_ACTION));
