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
import './slack-agent-flow/index.js';
import './self-mod/index.js';
import './remote-control/index.js';
import './channel-auto-wire/index.js';
// Bash-gate depends on approvals and the delivery action registry, both loaded above.
import './bash-gate/index.js';
import './orchestrator-dispatch/index.js';
import './sweep-orchestrator/index.js';
import './backlog/index.js';
// Channel-config depends on permissions (isAdminOfAgentGroup).
import './channel-config/index.js';
import './support-threads/index.js';
import './scheduled-wake/index.js';
import './provider-fallback/index.js';
import './repository-workspaces/index.js';
import './sweep-storage/index.js';

import './escalation/index.js';

import './sweep-idle-reap/index.js';
import './sweep-central/index.js';
import './sweep-repo-fence/index.js';
import './sweep-scheduled-move/index.js';
import './wiki-admission/index.js';
import './sweep-container-health/index.js';
import './sweep-egress/index.js';
import './sweep-claims/index.js';
// No second import for sweep-storage: its duty registration rides the import above.
import './sweep-usage/index.js';
import './sweep-session-core/index.js';

import './sweep-continuation/index.js';
import './sweep-promise-watch/index.js';

import './sweep-scheduling/index.js';

import './sweep-task-escalation/index.js';

import './mcp-oauth/index.js';
