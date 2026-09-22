import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import {
  assertMcpServerNotPluginOwned,
  effectiveStatusSubtext,
  parseMcpServerConfig,
  readContainerConfig,
  resolveContainerSecurity,
  validateMcpServerName,
  type AdditionalMountConfig,
  type McpServerConfig,
  updateContainerConfig,
  resolveGroupProvider,
} from '../../container-config.js';
import { resolveContainerResources, type ContainerResources } from '../../container-resources.js';
import { FLEET_MCP_SERVERS_PATH, readFleetMcpServers, updateFleetMcpServers } from '../../fleet-mcp-servers.js';
import { buildAgentGroupImage, killContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { requestWake } from '../../request-wake.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { centralTransaction } from '../../db/central-lease.js';
import { getDb, hasTable } from '../../db/connection.js';
import { insertOrAdopt } from '../../db/insert-or-adopt.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  resolveProviderName,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import { getDeniedModel } from '../../db/denied-models.js';
import { auditTaskPins, formatStrandedPins, formatLateStrandedPins } from '../../modules/scheduling/pin-audit.js';
import { assertValidGroupFolder, groupFolderExistsOnDisk } from '../../group-folder.js';
import { log } from '../../log.js';
import { canonicalizeIanaTimezone, timezoneRejectionReason } from '../../timezone.js';
import { initGroupFilesystem } from '../../group-init.js';
import { findSiblingParityDrifts } from '../../sibling-parity.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import type { AgentGroup, ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/**
 * Parse a --timezone flag: undefined = not passed, null = explicit clear
 * (empty string → follow the install default), otherwise the CANONICAL IANA
 * id. Invalid ids throw here, in the handler — for agent callers that is after
 * approval (rare, self-healing: a retry raises a fresh card).
 *
 * Validated against the zone database, not merely Intl-acceptable: the stored
 * string is handed to the container as POSIX `TZ` and opened there as a
 * case-sensitive file path, so only a spelling the database actually has can
 * keep host scheduling and the container clock on the same zone.
 */
function parseTimezoneFlag(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const tz = String(value);
  if (tz === '') return null;
  const canonical = canonicalizeIanaTimezone(tz);
  if (canonical === null) {
    throw new Error(`invalid --timezone: ${timezoneRejectionReason(tz)}. Pass "" to follow the install default`);
  }
  return canonical;
}

/** Deserialize JSON columns for display. */
/**
 * One parse for both doors — a group's container.json and the fleet defaults —
 * so `--fleet` cannot end up with a looser intake than `--id` (the URL
 * credential refusals live in `parseMcpServerConfig`).
 */
function parseMcpServerEntry(args: Record<string, unknown>): McpServerConfig {
  return parseMcpServerConfig({
    command: args.command,
    url: args.url,
    args: args.args === undefined ? undefined : JSON.parse(String(args.args)),
    env: args.env === undefined ? undefined : JSON.parse(String(args.env)),
    headers: args.headers === undefined ? undefined : JSON.parse(String(args.headers)),
    description: args.description,
    displayName: args['display-name'] ?? args.display_name,
  });
}

function presentConfig(row: ContainerConfigRow, folder?: string): Record<string, unknown> {
  const fileConfig = folder ? readContainerConfig(folder) : undefined;
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    timezone: row.timezone,
    resources: fileConfig?.resources ?? null,
    effective_resources: fileConfig ? resolveContainerResources(fileConfig.resources) : null,
    // Privilege overrides are the whole point of auditing this: a config that
    // narrows capDrop, adds a capability back, or turns off no-new-privileges
    // must be visible here, not only in the spawn's docker args.
    security: fileConfig?.security ?? null,
    effective_security: fileConfig ? resolveContainerSecurity(fileConfig.security) : null,
    // Stored AND effective, like resources/security above: the stored value is
    // `false` only for a group that explicitly opted out, and null otherwise,
    // so an operator auditing `--status-subtext off` can tell a deliberate
    // opt-out from a group riding the default.
    status_subtext: fileConfig?.statusSubtext ?? null,
    effective_status_subtext: fileConfig ? effectiveStatusSubtext(fileConfig) : null,
    updated_at: row.updated_at,
  };
}

function optionalNumberArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = args[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${names[0]} must be a positive number`);
    return value;
  }
  return undefined;
}

function optionalIntegerArg(args: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = optionalNumberArg(args, ...names);
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`--${names[0]} must be a positive integer`);
  }
  return value;
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` and `delete` are custom (below): create needs a `--template`
  // branch, and the generic create inserts a bare agent_groups row but never
  // the container_config a working group needs; the generic single-table
  // DELETE violates FK constraints (#2525).
  operations: { list: 'open', get: 'open', update: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create (or return the existing) agent group with its container config. Idempotent on --folder. ' +
        'With --template <ref>, stamp from a local Agent Plugins 1.0.0 plugin directory under templates/ ' +
        '(plugin.json, plus optional skills/, mcp.json and an ai.nanoco.nanoclaw/ extension carrying ' +
        'instructions, context extras and paused recurring tasks). The plugin is copied to ' +
        'groups/<folder>/plugins/<name> read-only, with plugin-data/<name> as its writable sibling; ' +
        'a pre-plugin template folder is refused with a migration error. Use --folder <slug> and --name <display name>. ' +
        'Optional --timezone <IANA id> sets the group timezone (template task schedules fire in it); like --name, it is ignored when the folder already exists.',
      handler: async (args) => {
        const timezone = parseTimezoneFlag(args.timezone) ?? undefined;
        if (args.template) {
          // `report` names every plugin component that was skipped (a
          // non-conforming skill, an invalid server, an ignored manifest field).
          // Surfaced to the operator who ran the stamp, not only logged; the
          // result shape is unchanged when the plugin was clean.
          const { group: stamped, report } = await createAgentFromTemplate(String(args.template), {
            name: args.name ? String(args.name) : undefined,
            timezone,
          });
          return report.length > 0 ? { ...stamped, report } : stamped;
        }
        const folder = args.folder as string;
        if (!folder) throw new Error('--folder is required');
        const name = (args.name as string) ?? folder;
        const existing = await getAgentGroupByFolder(folder);
        if (existing) {
          initGroupFilesystem(existing); // ensure a reused group is fully configured too (idempotent; also repairs a missing workspace folder)
          return existing;
        }
        // A folder on disk with no claiming DB row is deleted-group residue
        // (delete never removes groups/<folder>/) or an operator-placed dir —
        // minting a new id over it would silently re-scope the old group's
        // data under a new identity. Checked before the grammar validation
        // below on purpose (see that comment).
        if (groupFolderExistsOnDisk(folder)) {
          throw new Error(
            `group folder 'groups/${folder}' already exists on disk but no agent group claims it — ` +
              `deleting a group never removes its folder, and creating a new group over it would silently ` +
              `adopt the old group's data under a new identity. Move or remove the folder, or pick a different --folder.`,
          );
        }
        // Fresh-create branch only, and after both the lookup above and the
        // on-disk probe say the folder is genuinely absent — validating
        // earlier would refuse to reuse a LIVE group whose folder predates
        // the current grammar (accepted by an older bare-create path),
        // breaking documented idempotence on --folder for it (github Codex
        // review, PR #486). The template path validates through
        // createAgentFromTemplate; the bare path used to validate nowhere for
        // a truly fresh create, minting folders the runtime label grammar
        // refuses at every spawn.
        assertValidGroupFolder(folder);
        const id = `ag-${randomUUID()}`;
        const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
        // `getAgentGroupByFolder` yields (async driver), so two concurrent
        // `groups create` calls for one folder can both miss and both insert
        // on the UNIQUE folder key. This operation is documented idempotent on
        // --folder, so the loser adopts the winner and provisions it exactly as
        // the existing-row branch above does — both callers return ok, one row.
        const { row: adopted, created } = await insertOrAdopt(group, createAgentGroup, () =>
          getAgentGroupByFolder(folder),
        );
        if (!created) {
          initGroupFilesystem(adopted);
          return adopted;
        }
        // Provision the workspace folder and the `container_configs` row that
        // `getContainerConfig` and the spawn path require. Without this, a
        // group created via `ncl groups create` would throw "Container config
        // not found" on first spawn and stay broken until the host restart
        // backfill ran (#2415). The template branch above provisions its own
        // config + folder in `createAgentFromTemplate`; this covers the bare
        // path. Mirrors what `setup/register.ts` does after creating an agent
        // group via the setup flow.
        initGroupFilesystem(group);
        // `initGroupFilesystem` deliberately does NOT insert the config row —
        // its caller in the create-agent flow runs it before the agent_groups
        // insert, where the FK would fail (see the note in group-init.ts). The
        // row exists by here only because the insert above already ran, so
        // stamp it explicitly. Idempotent (INSERT OR IGNORE), and without it
        // the scalar write below silently updates zero rows and the group's
        // scheduling keeps following the install timezone until the next host
        // startup backfill.
        await ensureContainerConfig(id);
        if (timezone) {
          await updateContainerConfigScalars(id, { timezone });
          await updateContainerConfig(folder, (config) => {
            config.timezone = timezone;
          });
        }
        return await getAgentGroupByFolder(folder);
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/. ' +
        'The leftover groups/<folder>/ blocks re-creating a group under the same folder name until it is moved or removed.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        // This is a fast-path UX check only, NOT the authoritative one: it is
        // an awaited read, and two overlapping approved `groups delete` calls
        // for the same id can both pass it before either's transaction runs.
        // The re-check inside the transaction below (immediately before any
        // DELETE) is what actually prevents the second caller from running a
        // full cascade over an already-deleted row and reporting success with
        // every count at 0 (github Codex review, PR #437, groups.ts:218).
        const exists = await getDb().get('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1', id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = await hasTable(getDb(), 'agent_destinations');
        const hasPendingApprovals = await hasTable(getDb(), 'pending_approvals');
        const hasWorkgroups = await hasTable(getDb(), 'workgroups');

        const db = getDb();

        // FK-ordered cascade. One central transaction (`centralTransaction`,
        // plan §4.4) — the driver rolls back the whole thing if any statement
        // throws (e.g. an FK constraint we missed), so the central DB stays
        // consistent. The driver opens it IMMEDIATE, so a parallel INSERT into
        // agent_groups between the sibling-refuse check and the dependent
        // DELETEs can't slip through and surface as a FK error. The closure is
        // DB-only: driver statements, awaited in sequence.
        //
        // The `removed` counts are sourced from each DELETE's `changes` so
        // they describe exactly what the transaction did, not a separate
        // pre-flight snapshot.
        const cascade = async (groupId: string) => {
          // The AUTHORITATIVE existence check — repeated here, inside the
          // transaction, because the awaited one above can go stale between
          // two overlapping deletes for the same id. Without this, the
          // second caller runs the whole cascade below against a row that's
          // already gone: every DELETE matches 0 rows, and the handler would
          // return `{ deleted: id, removed: {...all zeros} }` as if it had
          // succeeded. The driver opens the transaction IMMEDIATE, so the
          // writer lock is held by the time this runs and nothing can delete
          // the row out from under this check before the DELETEs run.
          if (!(await db.get('SELECT 1 FROM agent_groups WHERE id = ?', groupId))) {
            throw new Error(`group not found: ${groupId}`);
          }
          // Pre-flight: refuse to delete a paired sibling. A workgroup is the
          // data-pool boundary (CLAUDE.md, docs/workgroups.md) — deleting the
          // seed leaves the twin with a dangling workgroup_id, which after
          // any later workgroups-row cleanup silently falls through to
          // per-agent store = amnesia. Force the operator to unpair (set
          // sibling workgroup_id = NULL) or migrate the twin before retrying.
          let workgroupIdToCleanup: string | null = null;
          if (hasWorkgroups) {
            const ag = await db.get<{ workgroup_id: string | null }>(
              'SELECT workgroup_id FROM agent_groups WHERE id = ?',
              groupId,
            );
            if (ag?.workgroup_id) {
              const siblings = await db.all<{ id: string; folder: string }>(
                `SELECT id, folder FROM agent_groups WHERE workgroup_id = ? AND id != ?`,
                ag.workgroup_id,
                groupId,
              );
              if (siblings.length > 0) {
                throw new Error(
                  `group ${groupId} is paired in workgroup ${ag.workgroup_id} with ${siblings.length} sibling(s): ` +
                    siblings.map((s) => `${s.id} (${s.folder})`).join(', ') +
                    '. Refusing to delete — unpair the siblings first ' +
                    '(UPDATE agent_groups SET workgroup_id = NULL WHERE id IN (...)) ' +
                    'or migrate them to a new workgroup, then retry.',
                );
              }
              workgroupIdToCleanup = ag.workgroup_id;
            }
          }
          const counts = {
            sessions: 0,
            cli_request_executions: 0,
            delivery_attempts: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
            container_configs: 0,
            workgroups: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = (
              await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ?', groupId)
            ).changes;
            counts.agent_destinations_pointing = (
              await db.run('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?', 'agent', groupId)
            ).changes;
          }
          counts.pending_questions = (
            await db.run(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              groupId,
            )
          ).changes;
          // The ncl execution ledger (src/cli/request-ledger.ts) retains its
          // newest claim per session on a terminal signal, not a clock, so a
          // deleted session's claim would otherwise never expire. Must run
          // before the sessions delete below — it resolves them by subquery.
          counts.cli_request_executions = (
            await db.run(
              'DELETE FROM cli_request_executions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              groupId,
            )
          ).changes;
          // Delivery retry counts (migration 071) are keyed to the session and
          // have no cascading foreign key. Nothing clears an orphan afterwards:
          // the row is only ever cleared by a delivery loop for a session that
          // no longer exists. Must run before the sessions delete below — it
          // resolves them by subquery.
          counts.delivery_attempts = (
            await db.run(
              'DELETE FROM delivery_attempts WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              groupId,
            )
          ).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = (
              await db.run(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
                groupId,
                groupId,
              )
            ).changes;
          }
          counts.sessions = (await db.run('DELETE FROM sessions WHERE agent_group_id = ?', groupId)).changes;
          counts.pending_sender_approvals = (
            await db.run('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?', groupId)
          ).changes;
          counts.pending_channel_approvals = (
            await db.run('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?', groupId)
          ).changes;
          counts.messaging_group_agents = (
            await db.run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', groupId)
          ).changes;
          counts.agent_group_members = (
            await db.run('DELETE FROM agent_group_members WHERE agent_group_id = ?', groupId)
          ).changes;
          counts.user_roles = (await db.run('DELETE FROM user_roles WHERE agent_group_id = ?', groupId)).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = (
            await db.run('DELETE FROM container_configs WHERE agent_group_id = ?', groupId)
          ).changes;
          await db.run('DELETE FROM agent_groups WHERE id = ?', groupId);
          // Clean up the now-orphan workgroup row (only set when no siblings
          // existed at pre-flight; the sibling-refuse path above never reaches
          // this point). Done last so the FK from agent_groups.workgroup_id is
          // already gone.
          if (workgroupIdToCleanup) {
            counts.workgroups = (await db.run('DELETE FROM workgroups WHERE id = ?', workgroupIdToCleanup)).changes;
          }
          return counts;
        };
        const removed = await centralTransaction(() => cascade(id), 'ncl groups delete');

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the container image first (required for package changes). ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await buildAgentGroupImage(id);
        }
        const message = args.message as string | undefined;

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message) {
            await writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            message
              ? async () => {
                  const s = await getSession(ctx.sessionId);
                  if (s) {
                    void requestWake(s, 'cli').catch((err) =>
                      log.error('Failed to wake container after ncl restart', { err, sessionId: ctx.sessionId }),
                    );
                  }
                }
              : undefined,
            // `--message` is what makes this a restart rather than a stop, on
            // the durable row as well as in process memory.
            message ? 'respawn_after_stop' : 'stop',
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = await restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description:
        'Show the container config for a group. Use --id <group-id>, or --fleet for the fleet-wide MCP defaults ' +
        'every group inherits (data/fleet-mcp-servers.json).',
      handler: async (args) => {
        if (args.fleet) {
          if (args.id) throw new Error('--fleet and --id are mutually exclusive');
          return { path: FLEET_MCP_SERVERS_PATH, mcp_servers: readFleetMcpServers() };
        }
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        return presentConfig(row, group.folder);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and scalar flags, or resource flags: --memory-request-mb, --memory-limit-mb, ' +
        '--memory-swap-limit-mb, --cpus, --cpu-shares, --pids-limit. ' +
        '--timezone takes an IANA id like "Europe/Lisbon" ("" clears back to the install default). Tasks created or edited afterwards use the new zone; an already-armed occurrence keeps its absolute fire time and the series moves onto the new grid at its next re-arm. The container clock follows after a restart. ' +
        '--provider REFUSES the switch when any armed scheduled-task pin would be invalid under the new provider (model/effort vocabularies do not nest: claude has ultracode, codex has ultra, opencode has neither and no xhigh). ' +
        'Task pins are never rewritten for you and there is no --force: clear the refusal with `ncl tasks repin --target-provider <new>`, which validates against the provider you are moving TO and therefore works before the switch. ' +
        "--status-subtext on|off controls the small model/effort/context line under this group's own replies (on everywhere by default; turn it off for a group whose conversations include people outside the fleet). It is written to container.json only and takes effect at the next restart.",
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            | 'provider'
            | 'model'
            | 'effort'
            | 'image_tag'
            | 'assistant_name'
            | 'max_messages_per_prompt'
            | 'cli_scope'
            | 'timezone'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        const timezone = parseTimezoneFlag(args.timezone);
        if (timezone !== undefined) updates.timezone = timezone;
        // Empty is an explicit clear, mirroring --timezone "". A group that
        // matches the provider default must not retain a redundant per-group
        // pin: that would silently defeat a later fleet-wide default change.
        if (args.model !== undefined) updates.model = String(args.model) || null;
        if (args.effort !== undefined) updates.effort = String(args.effort) || null;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        // container.json-only, no DB projection: the flag is read by the
        // in-container runner and by nothing on the host, so a column in
        // `container_configs` — whose job is the `-m`/`-e` flag vocabulary,
        // task-pin validation and image builds — would be a second copy with
        // no reader.
        const statusSubtextArg = args['status-subtext'] ?? args.status_subtext;
        let statusSubtext: boolean | undefined;
        if (statusSubtextArg !== undefined) {
          const raw = String(statusSubtextArg).toLowerCase();
          if (raw === 'on' || raw === 'true') statusSubtext = true;
          else if (raw === 'off' || raw === 'false') statusSubtext = false;
          else throw new Error('--status-subtext must be one of: on, off');
        }

        const memoryRequestMb = optionalIntegerArg(args, 'memory-request-mb', 'memory_request_mb');
        const memoryLimitMb = optionalIntegerArg(args, 'memory-limit-mb', 'memory_limit_mb');
        const memorySwapLimitMb = optionalIntegerArg(args, 'memory-swap-limit-mb', 'memory_swap_limit_mb');
        const cpus = optionalNumberArg(args, 'cpus');
        const cpuShares = optionalIntegerArg(args, 'cpu-shares', 'cpu_shares');
        const pidsLimit = optionalIntegerArg(args, 'pids-limit', 'pids_limit');
        const hasResourceUpdate =
          memoryRequestMb !== undefined ||
          memoryLimitMb !== undefined ||
          memorySwapLimitMb !== undefined ||
          cpus !== undefined ||
          cpuShares !== undefined ||
          pidsLimit !== undefined;

        if (Object.keys(updates).length === 0 && !hasResourceUpdate && statusSubtext === undefined) {
          throw new Error(
            'Nothing to update — provide a scalar config flag, --status-subtext, or one of: --memory-request-mb, --memory-limit-mb, --memory-swap-limit-mb, --cpus, --cpu-shares, --pids-limit',
          );
        }

        // Model deny enforcement: when --model is set, reject if the (provider,
        // slug) pair is in denied_models. Host can't tell whether a model is
        // ACTUALLY reachable (that depends on container-side opencode CLI +
        // auth.json), but it CAN enforce the operator's hard-no list. Use the
        // new provider if it's being changed in the same call; otherwise current.
        if (updates.model !== undefined && updates.model !== null) {
          const effectiveProvider = updates.provider ?? row.provider;
          if (!effectiveProvider) {
            throw new Error('Cannot validate --model without a provider set on the group');
          }
          const denied = await getDeniedModel(effectiveProvider, updates.model);
          if (denied) {
            throw new Error(
              `Model "${updates.model}" is denied for provider "${effectiveProvider}".` +
                (denied.reason ? ` Reason: ${denied.reason}` : '') +
                `\n\nOperator can remove via: ncl denied-models remove --provider ${effectiveProvider} --slug ${updates.model}`,
            );
          }
        }

        // Provider-migration pin audit (2026-09-07 incident). Pins are validated
        // at CREATE time against the then-current provider and never
        // re-validated at fire time, so a bare `--provider` switch strands
        // every pin the new vocabulary rejects and the only symptom is a
        // per-fire provider error nobody is watching for. REFUSE rather than
        // warn: this verb already runs behind an approval gate, so a refusal is
        // read and acted on, while a warning printed into a scrollback is
        // precisely what produced a 14-hour outage. The audit never rewrites a
        // pin — that is the operator's call, via `ncl tasks repin`, whose
        // --target-provider makes the remedy reachable BEFORE the switch and is
        // therefore what makes refusing safe rather than a wedge.
        //
        // Runs before any write, so a refusal leaves both stores untouched.
        // Recorded so the post-write re-audit below knows a switch happened.
        let auditedProvider: string | undefined;
        let fromProviderForReport: string | undefined;
        if (updates.provider !== undefined) {
          // `resolveGroupProvider` is THE resolver (container-config.ts): the
          // authoritative `container.json`, projection only as fallback. Read
          // the projection here instead and a group whose row already says
          // `claude` while its file still says `codex` skips the audit — and
          // this handler then writes the file, performing the real switch with
          // every gpt-* pin carried in unexamined.
          const fromProvider = await resolveGroupProvider(id);
          const toProvider = resolveProviderName(null, updates.provider);
          if (fromProvider !== toProvider) {
            auditedProvider = toProvider;
            fromProviderForReport = fromProvider;
            const stranded = await auditTaskPins(id, toProvider);
            if (stranded.length > 0) {
              log.warn('Refused provider switch: armed task pins would be invalid', {
                agentGroupId: id,
                fromProvider,
                toProvider,
                stranded: stranded.map((p) => ({ seriesId: p.seriesId, model: p.model, effort: p.effort })),
              });
              throw new Error(formatStrandedPins(stranded, id, fromProvider, toProvider));
            }
          }
        }

        // Mirror the runtime-selecting scalars into container.json. The DB row
        // is a read-side projection (flag vocabulary, task-flag validation);
        // the FILE is what the spawn path and the in-container runner actually
        // read for provider/model/effort/assistantName. Writing only the DB silently left a
        // group running its old provider after `config update --provider`,
        // which reads as "the command did nothing" — the update appears in
        // `config get` while the container keeps booting the old runtime.
        // `updateContainerConfig` holds the group's file lock across its
        // read-mutate-write, so a concurrent spawn-time identity write can
        // neither be clobbered by this one nor clobber it.
        //
        // THE FILE COMMITS FIRST, and the projection follows (#840). Either
        // write can fail, so one of the two disagreements has to be the one
        // this command can leave behind; file-ahead is the recoverable half.
        // The container boots what the operator asked for and the CLI's flag
        // vocabulary lags until the command is re-run. Projection-ahead was the
        // other way round: `config get` reports the new provider while the
        // container keeps booting the old one, which is indistinguishable from
        // success at every later read.
        if (
          updates.provider !== undefined ||
          updates.model !== undefined ||
          updates.effort !== undefined ||
          updates.assistant_name !== undefined ||
          updates.timezone !== undefined
        ) {
          await updateContainerConfig(group.folder, (config) => {
            if (updates.provider !== undefined) config.provider = updates.provider as string;
            if (updates.model !== undefined) config.model = (updates.model as string) || undefined;
            if (updates.effort !== undefined) config.effort = (updates.effort as string) || undefined;
            if (updates.assistant_name !== undefined)
              config.assistantName = (updates.assistant_name as string) || undefined;
            // `--timezone ""` maps to null here, which must ERASE the field so
            // the spawn falls back to the install timezone.
            if (updates.timezone !== undefined) config.timezone = updates.timezone ?? undefined;
            return config;
          });
        }

        if (statusSubtext !== undefined) {
          // `true` ERASES the key rather than writing it, so a group that is
          // simply on the default carries no field. Only the opt-out is
          // recorded, which keeps "what has this group changed?" answerable by
          // reading the file.
          await updateContainerConfig(group.folder, (config) => {
            config.statusSubtext = statusSubtext ? undefined : false;
            return config;
          });
        }

        if (Object.keys(updates).length > 0) await updateContainerConfigScalars(id, updates);

        if (hasResourceUpdate) {
          await updateContainerConfig(group.folder, (config) => {
            const resources: ContainerResources = {
              ...(config.resources ?? {}),
              memory: { ...(config.resources?.memory ?? {}) },
            };
            if (memoryRequestMb !== undefined) resources.memory!.requestMb = memoryRequestMb;
            if (memoryLimitMb !== undefined) resources.memory!.limitMb = memoryLimitMb;
            if (memorySwapLimitMb !== undefined) resources.memory!.memorySwapLimitMb = memorySwapLimitMb;
            if (cpus !== undefined) resources.cpus = cpus;
            if (cpuShares !== undefined) resources.cpuShares = cpuShares;
            if (pidsLimit !== undefined) resources.pidsLimit = pidsLimit;
            resolveContainerResources(resources);
            config.resources = resources;
          });
        }

        // ── THE CHECK-TO-WRITE WINDOW, narrowed and made loud ──
        //
        // The audit above runs before the writes below, and the socket server
        // handles each connection independently, so a `tasks create`/`update`
        // (or a recurrence re-arm) can land an old-provider-valid pin in
        // between — stranded by a switch whose audit had already passed.
        //
        // This is NOT closed by a lock here, deliberately. Task pin writes take
        // the central lease via `withCentralSync`, and `assertLeaseNotHeld`
        // forbids nesting, so serializing this handler against them means
        // restructuring how `config update` acquires the lease across its
        // several writes. That is a transactional change to a path that also
        // writes container.json and resource limits, and doing it inside a
        // change about pin semantics is how a fix becomes the next incident.
        //
        // What IS fixed is the outcome that actually hurt: silence. A pin that
        // slips through the window is now REPORTED — the same information the
        // refusal would have carried, after the fact instead of before it. The
        // operator learns immediately rather than at a failed fire, and
        // scheduled-task failure escalation is the backstop underneath.
        if (auditedProvider !== undefined) {
          const late = await auditTaskPins(id, auditedProvider);
          if (late.length > 0) {
            log.warn('Task pins were stranded by a provider switch after its audit passed', {
              agentGroupId: id,
              toProvider: auditedProvider,
              stranded: late.map((p) => ({ seriesId: p.seriesId, model: p.model, effort: p.effort })),
            });
            const updatedLate = (await getContainerConfig(id))!;
            return {
              ...presentConfig(updatedLate, group.folder),
              stranded_after_switch: late,
              // NOT formatStrandedPins: that text says the switch is being
              // refused, and by here it has already landed.
              warning: formatLateStrandedPins(late, id, fromProviderForReport!, auditedProvider),
            };
          }
        }

        const updated = (await getContainerConfig(id))!;
        return presentConfig(updated, group.folder);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group, or to every group with --fleet. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> (or --fleet) --name <server-name> with EITHER --command <cmd> [--args <json-array>] [--env <json-object>] ' +
        'for a local stdio server, OR --url <https-url> [--headers <json-object>] for a remote Streamable HTTP server ' +
        '(plain HTTP only for localhost / host.docker.internal). Credential headers must carry the "onecli-managed" ' +
        'placeholder — the OneCLI gateway substitutes the real secret at the proxy boundary. ' +
        '--description <text> is what the agent reads in its capability list (absent: a generic line naming the transport), ' +
        'and --display-name <text> is the label there. --fleet writes data/fleet-mcp-servers.json, which every group ' +
        'inherits unless it declares that name itself or lists it in container.json excludeMcpServers; no host restart.',
      handler: async (args) => {
        const id = args.id as string;
        const fleet = Boolean(args.fleet);
        if (fleet && id) throw new Error('--fleet and --id are mutually exclusive');
        if (!fleet && !id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        validateMcpServerName(name);

        if (fleet) {
          const entry = parseMcpServerEntry(args);
          const servers = updateFleetMcpServers((current) => {
            current[name] = entry;
          });
          return { added: name, fleet: true, path: FLEET_MCP_SERVERS_PATH, servers };
        }

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const newEntry: McpServerConfig = parseMcpServerEntry(args);

        // Dual-write: container.json (canonical — what the spawn reads via
        // readContainerConfig) + container_configs.mcp_servers (cache — what
        // `ncl groups config get` reads). DB-only writes were silently dead
        // for mcp_servers/additional_mounts since the spawn path never reads
        // those fields from the DB; the backfill-container-configs sync is
        // file→DB one-way, so DB drift gets overwritten on next host start.
        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          assertMcpServerNotPluginOwned(cfg.mcpServers?.[name], name, group.folder);
          if (!cfg.mcpServers) cfg.mcpServers = {};
          cfg.mcpServers[name] = newEntry;
        });
        await updateContainerConfigJson(id, 'mcp_servers', fileConfig.mcpServers ?? {});

        return { added: name, servers: fileConfig.mcpServers ?? {} };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group, or from the fleet defaults with --fleet. Requires `ncl groups restart` ' +
        'to take effect. Use --id <group-id> (or --fleet) --name <server-name>. Removing a fleet entry does NOT touch ' +
        'a group that declares the same name in its own container.json.',
      handler: async (args) => {
        const id = args.id as string;
        const fleet = Boolean(args.fleet);
        if (fleet && id) throw new Error('--fleet and --id are mutually exclusive');
        if (!fleet && !id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        if (fleet) {
          const servers = updateFleetMcpServers((current) => {
            if (!current[name]) throw new Error(`MCP server "${name}" not found in the fleet defaults`);
            delete current[name];
          });
          return { removed: name, fleet: true, path: FLEET_MCP_SERVERS_PATH, servers };
        }

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        // Validate against the canonical file (DB cache may be stale post-
        // operator-edit; file is the source of truth).
        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.mcpServers || !cfg.mcpServers[name]) {
            throw new Error(`MCP server "${name}" not found`);
          }
          assertMcpServerNotPluginOwned(cfg.mcpServers[name], name, group.folder);
          delete cfg.mcpServers[name];
        });
        await updateContainerConfigJson(id, 'mcp_servers', fileConfig.mcpServers ?? {});

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        // Dual-write packages: file (canonical, survives backfill at host
        // restart) + DB (cache, read by buildAgentGroupImage at rebuild time).
        // Build path happens to read from DB too, so package-add WAS working
        // pre-fix — but file would have drifted, leaving operators with stale
        // container.json and a DB that gets clobbered by next backfill.
        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.packages) cfg.packages = { apt: [], npm: [] };
          if (apt && !cfg.packages.apt.includes(apt)) cfg.packages.apt.push(apt);
          if (npm && !cfg.packages.npm.includes(npm)) cfg.packages.npm.push(npm);
        });
        if (apt) await updateContainerConfigJson(id, 'packages_apt', fileConfig.packages.apt);
        if (npm) await updateContainerConfigJson(id, 'packages_npm', fileConfig.packages.npm);

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.packages) cfg.packages = { apt: [], npm: [] };
          if (apt) cfg.packages.apt = cfg.packages.apt.filter((p) => p !== apt);
          if (npm) cfg.packages.npm = cfg.packages.npm.filter((p) => p !== npm);
        });
        if (apt) await updateContainerConfigJson(id, 'packages_apt', fileConfig.packages.apt);
        if (npm) await updateContainerConfigJson(id, 'packages_npm', fileConfig.packages.npm);

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
    'config add-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        "Mount a host directory into a group's containers. OPERATOR-ONLY — never runnable from " +
        'inside a container (mounting host paths is a filesystem-access boundary). Requires ' +
        '`ncl groups restart` to take effect. Use --id <group-id> --host <host-path> --container <container-path> [--ro].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const mount: AdditionalMountConfig = {
          hostPath,
          containerPath,
          ...(args.ro || args.readonly ? { readonly: true } : {}),
        };
        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.additionalMounts) cfg.additionalMounts = [];
          if (!cfg.additionalMounts.some((m) => m.hostPath === hostPath && m.containerPath === containerPath)) {
            cfg.additionalMounts.push(mount);
          }
        });
        await updateContainerConfigJson(id, 'additional_mounts', fileConfig.additionalMounts ?? []);

        return { added: mount, note: `Run \`ncl groups restart --id ${id}\` for the mount to take effect.` };
      },
    },
    'config remove-mount': {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove a host mount from a group. OPERATOR-ONLY. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --host <host-path> --container <container-path>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const hostPath = (args.host ?? args['host-path']) as string | undefined;
        const containerPath = (args.container ?? args['container-path']) as string | undefined;
        if (!hostPath || !containerPath) throw new Error('Provide --host <host-path> and --container <container-path>');

        const group = await getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = await getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const fileConfig = await updateContainerConfig(group.folder, (cfg) => {
          cfg.additionalMounts = (cfg.additionalMounts ?? []).filter(
            (m) => !(m.hostPath === hostPath && m.containerPath === containerPath),
          );
        });
        await updateContainerConfigJson(id, 'additional_mounts', fileConfig.additionalMounts ?? []);

        return { removed: { hostPath, containerPath }, note: `Run \`ncl groups restart --id ${id}\` to apply.` };
      },
    },
    'parity-check': {
      access: 'approval',
      description:
        'Diff a sibling group against its source group on the capability-parity invariant. ' +
        'Use --source <source-folder> --sibling <sibling-folder>. Reads container.json from disk for non-DB fields (onecliSecrets, tools, etc.) ' +
        'plus the DB for wiring + container config scalars. Reports drift, does NOT auto-fix.',
      handler: async (args, ctx) => {
        const sourceFolder = (args.source ?? args['source-folder']) as string | undefined;
        const siblingFolder = (args.sibling ?? args['sibling-folder']) as string | undefined;
        if (!sourceFolder || !siblingFolder) {
          throw new Error('Both --source <folder> and --sibling <folder> are required');
        }
        // Reject path-traversal + reserved names before forming any filesystem
        // path. assertValidGroupFolder enforces `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`.
        assertValidGroupFolder(sourceFolder);
        assertValidGroupFolder(siblingFolder);
        // cli_scope='group' isolation: agent callers may only diff folders that
        // belong to their own agent_group (matches the post-handler scope filter
        // applied to generic ops). Both folders must resolve to the caller's
        // agent_group_id; otherwise we'd leak another group's container.json.
        if (ctx.caller === 'agent') {
          const srcGroup = await getAgentGroupByFolder(sourceFolder);
          const sibGroup = await getAgentGroupByFolder(siblingFolder);
          const callerId = ctx.agentGroupId;
          if (!srcGroup || srcGroup.id !== callerId || !sibGroup || sibGroup.id !== callerId) {
            throw new Error(
              `parity-check from cli_scope='group' is restricted to the caller's own agent_group (${callerId}); ` +
                `requested source=${sourceFolder} sibling=${siblingFolder} resolved to different groups`,
            );
          }
        }
        const readJson = (folder: string): Record<string, unknown> => {
          const p = path.join(GROUPS_DIR, folder, 'container.json');
          if (!fs.existsSync(p)) throw new Error(`container.json missing for ${folder}`);
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
        };
        const src = readJson(sourceFolder);
        const sib = readJson(siblingFolder);

        const drifts = findSiblingParityDrifts(src, sib);

        return {
          source: sourceFolder,
          sibling: siblingFolder,
          status: drifts.length === 0 ? 'parity' : 'drift',
          drifts,
          note:
            'Identity, provider auth, model/runtime tuning, resource budgets, and Slack allowlist IDs may differ. ' +
            'Slack capability, tools, secrets, mounts, packages, and MCP definitions must match. Runtime parity ' +
            '(OneCLI secret assignment, MCP server availability) requires a warm-up spawn + post-spawn verification.',
        };
      },
    },
  },
});
