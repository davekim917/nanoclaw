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
// Sweep family: orchestrator, dormant (seam 2, S2-PR5) — T6 reconciler,
// T14 auto-archive, T18 task watchdog. Registers at import.
import './sweep-orchestrator/index.js';
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
// Sweep storage — declares startStorageMaintenanceOnce (called by host-sweep.ts's
// tick) and the onHostShutdown that stops the persistent worker, in one module.
import './sweep-storage/index.js';

import './escalation/index.js';

// Sweep duty families (convergence seam 2) — each self-registers its duties
// on the host-sweep.ts registry at import time, same pattern as above.
// sweep-idle-reap: S12 idle-task-reap, S13 idle-chat-reap (S2-PR3).
import './sweep-idle-reap/index.js';
// Sweep family: central housekeeping (seam 2, S2-PR4) — github-app-token-refresh,
// steer-idempotency-prune, channel-ingress-receipt-prune, session-title-sweep,
// thread-title-retry, dashboard-token-prune (all tick:housekeeping).
import './sweep-central/index.js';
// Sweep-repo-fence (seam 2, PR 8 — G08): T5 approvals-reason-sweep,
// T22 orphaned-repo-fence-release.
import './sweep-repo-fence/index.js';
// Sweep family: scheduled-move recovery (seam 2, S2-PR7) — T11
// scheduled-move-recovery, T12 audit-body-prune on tick:housekeeping.
import './sweep-scheduled-move/index.js';
// Sweep container health — S11 provider self-heal, S14 running-container SLA,
// S16 OOM / memory-pressure notice (convergence seam 2, PR 10).
import './sweep-container-health/index.js';
// sweep-egress: T2 egress-network-reheal (S2-PR6).
import './sweep-egress/index.js';
// sweep-claims: T20 claims-reconcile, T21 claims-self-heal (S2-PR6).
import './sweep-claims/index.js';
// S2-PR6's own barrel line for sweep-storage is deliberately absent: this
// lineage already imports that module above (S2-PR1 owns it for the
// onHostShutdown half), and its T13 registration rides that same import.
