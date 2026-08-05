import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import {
  readContainerConfig,
  type AdditionalMountConfig,
  type McpServerConfig,
  updateContainerConfig,
} from '../../container-config.js';
import { resolveContainerResources, type ContainerResources } from '../../container-resources.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import { getDeniedModel } from '../../db/denied-models.js';
import { assertValidGroupFolder } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { findSiblingParityDrifts } from '../../sibling-parity.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import type { AgentGroup, ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display. */
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
    resources: fileConfig?.resources ?? null,
    effective_resources: fileConfig ? resolveContainerResources(fileConfig.resources) : null,
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
        'With --template <ref>, stamp from a local template under templates/ (MCP servers + instructions ' +
        '+ skills + paused recurring tasks). Use --folder <slug> and --name <display name>.',
      handler: async (args) => {
        if (args.template) {
          return createAgentFromTemplate(String(args.template), {
            name: args.name ? String(args.name) : undefined,
          });
        }
        const folder = args.folder as string;
        if (!folder) throw new Error('--folder is required');
        const name = (args.name as string) ?? folder;
        const existing = getAgentGroupByFolder(folder);
        if (existing) {
          initGroupFilesystem(existing); // ensure a reused group is fully configured too (idempotent; also repairs a missing workspace folder)
          return existing;
        }
        const id = `ag-${randomUUID()}`;
        const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
        createAgentGroup(group);
        // Provision the workspace folder and the `container_configs` row that
        // `getContainerConfig` and the spawn path require. Without this, a
        // group created via `ncl groups create` would throw "Container config
        // not found" on first spawn and stay broken until the host restart
        // backfill ran (#2415). The template branch above provisions its own
        // config + folder in `createAgentFromTemplate`; this covers the bare
        // path. Mirrors what `setup/register.ts` does after creating an agent
        // group via the setup flow. The config row is stamped with the
        // instance default provider (`ensureContainerConfig` inside) — per-group
        // `groups config update --provider` still wins.
        initGroupFilesystem(group);
        return getAgentGroupByFolder(folder);
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = hasTable(db, 'agent_destinations');
        const hasPendingApprovals = hasTable(db, 'pending_approvals');
        const hasWorkgroups = hasTable(db, 'workgroups');

        // FK-ordered cascade. Single sync IMMEDIATE transaction — better-sqlite3
        // rolls back the whole thing if any statement throws (e.g. an FK
        // constraint we missed), so the central DB stays consistent. IMMEDIATE
        // grabs the writer lock up front so a parallel INSERT into
        // agent_groups between the sibling-refuse check and the dependent
        // DELETEs can't slip through and surface as a FK error.
        //
        // The `removed` counts are sourced from each DELETE's `changes` so
        // they describe exactly what the transaction did, not a separate
        // pre-flight snapshot.
        const cascade = db.transaction((groupId: string) => {
          // Pre-flight: refuse to delete a paired sibling. A workgroup is the
          // data-pool boundary (CLAUDE.md, docs/workgroups.md) — deleting the
          // seed leaves the twin with a dangling workgroup_id, which after
          // any later workgroups-row cleanup silently falls through to
          // per-agent store = amnesia. Force the operator to unpair (set
          // sibling workgroup_id = NULL) or migrate the twin before retrying.
          let workgroupIdToCleanup: string | null = null;
          if (hasWorkgroups) {
            const ag = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get(groupId) as
              | { workgroup_id: string | null }
              | undefined;
            if (ag?.workgroup_id) {
              const siblings = db
                .prepare(`SELECT id, folder FROM agent_groups WHERE workgroup_id = ? AND id != ?`)
                .all(ag.workgroup_id, groupId) as Array<{ id: string; folder: string }>;
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
            counts.agent_destinations_owned = db
              .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
              .run(groupId).changes;
            counts.agent_destinations_pointing = db
              .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
              .run('agent', groupId).changes;
          }
          counts.pending_questions = db
            .prepare(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
            )
            .run(groupId).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = db
              .prepare(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              )
              .run(groupId, groupId).changes;
          }
          counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
          counts.pending_sender_approvals = db
            .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.pending_channel_approvals = db
            .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.messaging_group_agents = db
            .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.agent_group_members = db
            .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = db
            .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
            .run(groupId).changes;
          db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
          // Clean up the now-orphan workgroup row (only set when no siblings
          // existed at pre-flight; the sibling-refuse path above never reaches
          // this point). Done last so the FK from agent_groups.workgroup_id is
          // already gone.
          if (workgroupIdToCleanup) {
            counts.workgroups = db.prepare('DELETE FROM workgroups WHERE id = ?').run(workgroupIdToCleanup).changes;
          }
          return counts;
        });
        const removed = cascade.immediate(id);

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
            writeSessionMessage(id, ctx.sessionId, {
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
              ? () => {
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', message);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        return presentConfig(row, group.folder);
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and scalar flags, or resource flags: --memory-request-mb, --memory-limit-mb, ' +
        '--memory-swap-limit-mb, --cpus, --pids-limit.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        if (args.model !== undefined) updates.model = args.model as string;
        if (args.effort !== undefined) updates.effort = args.effort as string;
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

        const memoryRequestMb = optionalIntegerArg(args, 'memory-request-mb', 'memory_request_mb');
        const memoryLimitMb = optionalIntegerArg(args, 'memory-limit-mb', 'memory_limit_mb');
        const memorySwapLimitMb = optionalIntegerArg(args, 'memory-swap-limit-mb', 'memory_swap_limit_mb');
        const cpus = optionalNumberArg(args, 'cpus');
        const pidsLimit = optionalIntegerArg(args, 'pids-limit', 'pids_limit');
        const hasResourceUpdate =
          memoryRequestMb !== undefined ||
          memoryLimitMb !== undefined ||
          memorySwapLimitMb !== undefined ||
          cpus !== undefined ||
          pidsLimit !== undefined;

        if (Object.keys(updates).length === 0 && !hasResourceUpdate) {
          throw new Error(
            'Nothing to update — provide a scalar config flag or one of: --memory-request-mb, --memory-limit-mb, --memory-swap-limit-mb, --cpus, --pids-limit',
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
          const denied = getDeniedModel(effectiveProvider, updates.model);
          if (denied) {
            throw new Error(
              `Model "${updates.model}" is denied for provider "${effectiveProvider}".` +
                (denied.reason ? ` Reason: ${denied.reason}` : '') +
                `\n\nOperator can remove via: ncl denied-models remove --provider ${effectiveProvider} --slug ${updates.model}`,
            );
          }
        }

        if (Object.keys(updates).length > 0) updateContainerConfigScalars(id, updates);

        // Mirror the runtime-selecting scalars into container.json. The DB row
        // is a read-side projection (flag vocabulary, task-flag validation);
        // the FILE is what the spawn path and the in-container runner actually
        // read for provider/model/effort. Writing only the DB silently left a
        // group running its old provider after `config update --provider`,
        // which reads as "the command did nothing" — the update appears in
        // `config get` while the container keeps booting the old runtime.
        // updateContainerConfig re-reads before writing, so a concurrent
        // spawn-time identity write is not clobbered.
        if (updates.provider !== undefined || updates.model !== undefined || updates.effort !== undefined) {
          updateContainerConfig(group.folder, (config) => {
            if (updates.provider !== undefined) config.provider = updates.provider as string;
            if (updates.model !== undefined) config.model = (updates.model as string) || undefined;
            if (updates.effort !== undefined) config.effort = (updates.effort as string) || undefined;
            return config;
          });
        }

        if (hasResourceUpdate) {
          updateContainerConfig(group.folder, (config) => {
            const resources: ContainerResources = {
              ...(config.resources ?? {}),
              memory: { ...(config.resources?.memory ?? {}) },
            };
            if (memoryRequestMb !== undefined) resources.memory!.requestMb = memoryRequestMb;
            if (memoryLimitMb !== undefined) resources.memory!.limitMb = memoryLimitMb;
            if (memorySwapLimitMb !== undefined) resources.memory!.memorySwapLimitMb = memorySwapLimitMb;
            if (cpus !== undefined) resources.cpus = cpus;
            if (pidsLimit !== undefined) resources.pidsLimit = pidsLimit;
            resolveContainerResources(resources);
            config.resources = resources;
          });
        }

        const updated = getContainerConfig(id)!;
        return presentConfig(updated, group.folder);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const newEntry: McpServerConfig = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };

        // Dual-write: container.json (canonical — what the spawn reads via
        // readContainerConfig) + container_configs.mcp_servers (cache — what
        // `ncl groups config get` reads). DB-only writes were silently dead
        // for mcp_servers/additional_mounts since the spawn path never reads
        // those fields from the DB; the backfill-container-configs sync is
        // file→DB one-way, so DB drift gets overwritten on next host start.
        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.mcpServers) cfg.mcpServers = {};
          cfg.mcpServers[name] = newEntry;
        });
        updateContainerConfigJson(id, 'mcp_servers', fileConfig.mcpServers ?? {});

        return { added: name, servers: fileConfig.mcpServers ?? {} };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        // Validate against the canonical file (DB cache may be stale post-
        // operator-edit; file is the source of truth).
        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.mcpServers || !cfg.mcpServers[name]) {
            throw new Error(`MCP server "${name}" not found`);
          }
          delete cfg.mcpServers[name];
        });
        updateContainerConfigJson(id, 'mcp_servers', fileConfig.mcpServers ?? {});

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

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        // Dual-write packages: file (canonical, survives backfill at host
        // restart) + DB (cache, read by buildAgentGroupImage at rebuild time).
        // Build path happens to read from DB too, so package-add WAS working
        // pre-fix — but file would have drifted, leaving operators with stale
        // container.json and a DB that gets clobbered by next backfill.
        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.packages) cfg.packages = { apt: [], npm: [] };
          if (apt && !cfg.packages.apt.includes(apt)) cfg.packages.apt.push(apt);
          if (npm && !cfg.packages.npm.includes(npm)) cfg.packages.npm.push(npm);
        });
        if (apt) updateContainerConfigJson(id, 'packages_apt', fileConfig.packages.apt);
        if (npm) updateContainerConfigJson(id, 'packages_npm', fileConfig.packages.npm);

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

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.packages) cfg.packages = { apt: [], npm: [] };
          if (apt) cfg.packages.apt = cfg.packages.apt.filter((p) => p !== apt);
          if (npm) cfg.packages.npm = cfg.packages.npm.filter((p) => p !== npm);
        });
        if (apt) updateContainerConfigJson(id, 'packages_apt', fileConfig.packages.apt);
        if (npm) updateContainerConfigJson(id, 'packages_npm', fileConfig.packages.npm);

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

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const mount: AdditionalMountConfig = {
          hostPath,
          containerPath,
          ...(args.ro || args.readonly ? { readonly: true } : {}),
        };
        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          if (!cfg.additionalMounts) cfg.additionalMounts = [];
          if (!cfg.additionalMounts.some((m) => m.hostPath === hostPath && m.containerPath === containerPath)) {
            cfg.additionalMounts.push(mount);
          }
        });
        updateContainerConfigJson(id, 'additional_mounts', fileConfig.additionalMounts ?? []);

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

        const group = getAgentGroup(id);
        if (!group) throw new Error(`No agent group: ${id}`);
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const fileConfig = updateContainerConfig(group.folder, (cfg) => {
          cfg.additionalMounts = (cfg.additionalMounts ?? []).filter(
            (m) => !(m.hostPath === hostPath && m.containerPath === containerPath),
          );
        });
        updateContainerConfigJson(id, 'additional_mounts', fileConfig.additionalMounts ?? []);

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
          const srcGroup = getAgentGroupByFolder(sourceFolder);
          const sibGroup = getAgentGroupByFolder(siblingFolder);
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
