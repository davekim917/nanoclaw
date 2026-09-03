/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). Core runs with an empty barrel — the registries have inline
 * fallbacks and `sqlite_master` guards.
 *
 * Default modules (ship with main, direct core import):
 *   - src/modules/typing/        → imported directly by router/delivery/container-runner
 *   - src/modules/mount-security/ → imported directly by container-runner
 *
 * Registry-based modules (installed via /add-<name> skills, pulled from the
 * `modules` branch): append imports below. The singular mailbox slot is the
 * exception: skills replace mailbox/compose.ts and leave this import intact.
 */
import '../mailbox/compose.js';

// Approvals (default tier) must load before self-mod (optional) so the
// registerApprovalHandler / requestApproval symbols are bound when self-mod
// registers its handlers at import time.
import './approvals/index.js';
import './interactive/index.js';
import './permissions/index.js';
import './agent-to-agent/index.js';
import './self-mod/index.js';
import './remote-control/index.js';
import './channel-auto-wire/index.js';
// Bash-gate depends on approvals (registers an approval handler) and on
// the delivery action registry being up — both satisfied by the order above.
import './bash-gate/index.js';
// Orchestrator dispatch — task dispatch pipeline + reconciler.
import './orchestrator-dispatch/index.js';
// Backlog + ship-log delivery action handlers (add_ship_log, add/update/delete_backlog_item).
import './backlog/index.js';
// Channel-config registers delivery actions for set_channel_model /
// set_channel_effort. Depends on permissions (for isAdminOfAgentGroup).
import './channel-config/index.js';
// Support-threads — dispatch_support_issue: route each support email thread to
// its own Slack thread + per-issue session. Depends on the delivery action
// registry being up (satisfied by import order).
import './support-threads/index.js';
// Scheduled-wake — schedule_wake delivery action: the container `wait` tool's
// in-session delayed wake (process_after row in the caller's own session).
import './scheduled-wake/index.js';
// Provider fallback — provider_unavailable: a container reports its own
// exhausted provider account; the host records the outage window and
// respawns that session onto the group's declared fallback provider.
import './provider-fallback/index.js';
// Repository workspaces — durable clone publication, local canonical refresh,
// and exact topic-to-topic linked-worktree transfer.
import './repository-workspaces/index.js';

import './escalation/index.js';

// Sweep duty families (convergence seam 2) — each self-registers its duties
// on the host-sweep.ts registry at import time, same pattern as above.
// sweep-egress: T2 egress-network-reheal (S2-PR6).
import './sweep-egress/index.js';
// sweep-storage: T13 storage-maintenance, plus its own start/stop pair
// (S2-PR1 module timers, carried in the same file — S2-PR6).
import './sweep-storage/index.js';
// sweep-claims: T20 claims-reconcile, T21 claims-self-heal (S2-PR6).
import './sweep-claims/index.js';
