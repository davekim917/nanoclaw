import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';
// Upstream's 017/018 — file numbers clash with local 017/018 (uniqueness is by
// `name`); aliased to dodge the JS identifier collisions.
import { migration017 as agentMessagePolicies } from './017-agent-message-policies.js';
import { migration018 as approvalsApproverUserId } from './018-approvals-approver-user-id.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
// Upstream v2 migrations (012/011/010 on disk = 12/11/10 in code):
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
// Operator's migrations (custom) and upstream's 013 live side-by-side; both files
// happen to be numbered 013 but carry distinct `name` fields (names are the
// uniqueness key for schema_version). Import-alias upstream's to dodge the
// JS identifier collision with `013-memories.js`.
import { migration013 } from './013-memories.js';
import { migration013 as approvalRenderMetadata } from './013-approval-render-metadata.js';
import { migration014 } from './014-channel-defaults.js';
import { migration015 } from './015-backlog.js';
import { migration016 } from './016-channel-tone.js';
import { migration017 } from './017-session-last-archive-at.js';
import { pendingApprovalsThreadId } from './018-pending-approvals-thread-id.js';
import { migration024 } from './024-sessions-channel-root-unique.js';
import { migration025 } from './025-agent-group-capabilities.js';
import { migration026 } from './026-tasks-and-dispatch-routing.js';
import { migration027 } from './027-drop-tasks-target-agent-group-id.js';
import { migration028 } from './028-dashboard-tables.js';
import { migration029 } from './029-tasks-needs-input.js';
import { migration030 } from './030-tasks-archived-at.js';
import { migration031 } from './031-inbox-board-foundations.js';
import { migration032 } from './032-sessions-last-outbound.js';
import { migration033 } from './033-steer-idempotency-drop-task-id.js';
import { migration035 } from './035-drop-thread-walkie-state.js';
import { migration036 } from './036-workgroup-id.js';
import { migration037 } from './037-provider-models.js';
import { migration038 } from './038-provider-models-go-seed-fix.js';
import { migration039 } from './039-denied-models.js';
import { migration040 } from './040-pair-provider-siblings.js';
import { migration041 } from './041-support-threads.js';
import { migration042 } from './042-support-threads-subject-sender.js';
import { migration043 } from './043-scheduled-audit.js';
import { migration044 } from './044-channel-ingress-receipts.js';
import { migration045 } from './045-approval-question-render-metadata.js';
import { migration046 } from './046-provider-health.js';
import { migration047 } from './047-usage-daily.js';
import { migration048 } from './048-task-thread-anchors.js';
import { migration049 } from './049-unique-active-session-triple.js';
import { migration050 } from './050-observatory-item-threads.js';
import { migration051 } from './051-memory-consolidated-facts.js';
import { migration052 } from './052-sessions-engaged-at.js';
import { migration053 } from './053-normalize-naive-timestamps.js';
import { migration054 } from './054-thread-snoozes.js';
import { migration055 } from './055-thread-closures.js';
import { migration056 } from './056-sessions-task-routing-platform-id.js';
import { migration057 } from './057-workgroups-attention-sources.js';
import { migration058 } from './058-observatory-item-assignments.js';
import { migration059 } from './059-central-turn-usage.js';
import { migration060 } from './060-turn-usage-rate-limit.js';
import { migration061 } from './061-turn-usage-turn-id.js';
import { migration062 } from './062-thread-titles.js';
import { migration063 } from './063-channel-instructions-profile.js';
import { migration064 } from './064-container-config-security-json.js';
import { migration065 } from './065-sessions-sweep-quiet-until.js';
// Upstream's 014/015 — file numbers clash with local but uniqueness is by `name`.
// Aliased to avoid JS identifier collisions with the local 014/015 above.
import { migration014 as containerConfigs } from './014-container-configs.js';
import { migration015 as cliScope } from './015-cli-scope.js';
// Upstream's 016 — channel-instance dimension. File number clashes with the
// local 016-channel-tone above; aliased (uniqueness is by `name`). Idempotent
// recreate that backfills instance = channel_type; safe on existing DBs.
import { migration016 as messagingGroupInstance } from './016-messaging-group-instance.js';
import { migration019 } from './019-wiring-threads.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  /**
   * Run with foreign_keys=OFF. Required for table recreates (SQLite can't
   * drop a table-level UNIQUE without DROP+RENAME, and DROP fails FK
   * integrity when child rows exist — see migration 011's header).
   * PRAGMA foreign_keys is a no-op inside a transaction, so the runner
   * toggles it around the transaction and runs PRAGMA foreign_key_check
   * inside it, so violations roll the migration back.
   */
  disableForeignKeys?: boolean;
}

export const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  agentMessagePolicies,
  moduleApprovalsTitleOptions,
  approvalsApproverUserId,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  approvalRenderMetadata,
  migration014,
  migration015,
  migration016,
  migration017,
  pendingApprovalsThreadId,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033,
  migration035,
  migration036,
  migration037,
  migration038,
  migration039,
  migration040,
  migration041,
  migration042,
  migration043,
  migration044,
  migration045,
  migration046,
  migration047,
  migration048,
  migration049,
  migration050,
  migration051,
  migration052,
  // Runs before 053 below, which is fine and deliberate: 053 normalizes an
  // explicit table/column allowlist that does not include thread_snoozes and
  // never will, so position cannot rescue a naive value here. 054 therefore
  // writes ISO at the write site instead of relying on a later sweep.
  migration054,
  // Same reasoning as 054: `thread_closures` and `sessions.done_proposal` are
  // written from JS as ISO-8601 UTC at the write site, so 053's allowlisted
  // normalizer has nothing to do here and position does not matter.
  migration055,
  // Adds a nullable column and writes no timestamp, so 053's position is
  // irrelevant here — same reasoning as 054/055 above.
  migration056,
  migration057,
  // Writes ISO-8601 UTC from JS at the write site, so 053's allowlisted
  // normalizer has nothing to do here — same reasoning as 054/055/056 above.
  migration058,
  // Same reasoning as 058: writes ISO-8601 UTC from JS at the write site.
  migration059,
  migration060,
  migration061,
  migration062,
  migration063,
  containerConfigs,
  cliScope,
  // After cliScope: 064 ALTERs container_configs, which upstream's aliased
  // `containerConfigs` creates. Ordering here is execution order, not file
  // number — registering 064 next to 063 runs it before the table exists.
  migration064,
  // Adds a nullable column and writes no timestamp, so 053's position below is
  // irrelevant here — same reasoning as 054/055/056 above.
  migration065,
  messagingGroupInstance,
  migration019,
  // Last on purpose: normalizes whatever naive timestamps every migration
  // above has left behind (016's messaging_groups recreate copies created_at
  // through as-is).
  migration053,
];

/** Row shape of PRAGMA foreign_key_check. Child rowids are stable across a
 *  parent-table recreate (child tables aren't touched), so this JSON identity
 *  is a reliable before/after diff key. */
interface FkViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

const fkIdentity = (v: FkViolation): string =>
  JSON.stringify({ table: v.table, rowid: v.rowid, parent: v.parent, fkid: v.fkid });

export function runMigrations(db: Database.Database, list: Migration[] = migrations): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules. `version` stays on
  // the Migration object as an ordering hint within the barrel array;
  // the stored `version` column is auto-assigned at insert time as an
  // applied-order number.
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = list.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    // Table recreates need FK enforcement off for the DROP+RENAME window.
    // The pragma must be toggled OUTSIDE the transaction (it's a silent
    // no-op inside one); foreign_key_check runs INSIDE so a violating
    // recreate rolls back atomically with nothing committed.
    if (m.disableForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        // Snapshot violations BEFORE up() runs: live DBs can carry latent
        // FK orphans (e.g. parents deleted through a FK-OFF sqlite3 CLI
        // session — ensureUserDm tolerates exactly this at runtime). The
        // migration must only fail for violations it INTRODUCED; throwing
        // on pre-existing ones would crash-loop the host at every boot
        // (runMigrations runs on startup) until manual DB surgery.
        const preexisting = m.disableForeignKeys
          ? new Set((db.pragma('foreign_key_check') as FkViolation[]).map(fkIdentity))
          : null;
        m.up(db);
        if (m.disableForeignKeys && preexisting) {
          const violations = db.pragma('foreign_key_check') as FkViolation[];
          const introduced = violations.filter((v) => !preexisting.has(fkIdentity(v)));
          const carried = violations.length - introduced.length;
          if (carried > 0) {
            log.warn('Pre-existing FK violations carried through migration (not introduced by it)', {
              migration: m.name,
              count: carried,
            });
          }
          if (introduced.length > 0) {
            throw new Error(`migration ${m.name} left FK violations: ${JSON.stringify(introduced.slice(0, 5))}`);
          }
        }
        const next = (
          db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }
        ).v;
        db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
          next,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (m.disableForeignKeys) db.pragma('foreign_keys = ON');
    }
    log.info('Migration applied', { name: m.name });
  }
}
