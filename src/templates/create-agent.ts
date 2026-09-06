import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../config.js';
import { CONTAINER_PLUGINS_DIR, updateContainerConfig, type ParsedMcpServerConfig } from '../container-config.js';
import { createAgentGroup } from '../db/agent-groups.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import { assertValidGroupFolder, resolveGroupFolderPath } from '../group-folder.js';
import { canonicalizeIanaTimezone } from '../timezone.js';
import { stageGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import { createScheduledTask, prepareScheduledTask } from '../modules/scheduling/create.js';
import type { AgentGroup } from '../types.js';
import { resolveLocalTemplate } from './local-dir.js';
import { pluginDataCwdSubpaths } from './mcp.js';
import { parseTemplate } from './parse.js';
import { copyPluginDir } from './plugin-dir.js';

export interface CreateAgentOptions {
  name?: string;
  /** IANA timezone for the new group; template task schedules fire in it. Omit to follow the install default. */
  timezone?: string;
}

export interface CreateAgentResult {
  group: AgentGroup;
  /** Named skip/ignore notices from the plugin reader — surface these to the caller. */
  report: string[];
}

/** Group-private skills overlay — where plugin skills are discovered and executed from. */
export function groupSkillsOverlayDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared', 'skills');
}

/**
 * Mark a template's servers for the CONTAINER: the container-side `pluginRoot`
 * on stdio servers so the agent-runner can expand ${PLUGIN_ROOT}/${PLUGIN_DATA}
 * and inject both env vars. A stdio server that omits `cwd` gets
 * `${PLUGIN_ROOT}` here — the spec default (§7.2.1: the plugin root MUST be the
 * working directory) materialized once at stamp time so every provider's config
 * writer sees an explicit value. All values are container paths — a host path
 * never leaks into config.
 *
 * The `plugin` OWNERSHIP marker is deliberately not added here; see
 * `withPluginOwner`.
 */
export function markPluginServers(
  servers: Record<string, ParsedMcpServerConfig>,
  pluginName: string,
): Record<string, ParsedMcpServerConfig> {
  const pluginRoot = `${CONTAINER_PLUGINS_DIR}/${pluginName}`;
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, server]) => [
      serverName,
      server.type === 'http' ? { ...server } : { cwd: '${PLUGIN_ROOT}', ...server, pluginRoot },
    ]),
  );
}

/**
 * Add the `plugin` ownership marker — the DB projection only.
 *
 * Upstream is DB-first and re-materializes container.json at spawn, so it can
 * carry the marker on the single stored copy and strip it on the way out. This
 * fork is file-first: container.json IS what the runner reads, so a host
 * bookkeeping field written there would flow straight into every provider's
 * server map. The guard sites all already hold the config ROW
 * (`groups.ts` reads `row.mcp_servers`, self-mod reads `getContainerConfig`),
 * so ownership lives there and the file stays free of it.
 */
export function withPluginOwner(
  servers: Record<string, ParsedMcpServerConfig>,
  pluginName: string,
): Record<string, ParsedMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([serverName, server]) => [serverName, { ...server, plugin: pluginName }]),
  );
}

/**
 * Stamp a self-contained agent group from a LOCAL plugin ref under
 * TEMPLATES_DIR. The plugin carries skills and MCP servers (portable Agent
 * Plugins surface) plus the optional NanoClaw extension (persona, context
 * extras, paused recurring tasks), but nothing else (no policy, packages, or
 * provider).
 *
 * The template persona is written to the provider-neutral standing-instructions
 * file (see src/group-persona.ts). Each provider's project-doc composer inlines it at
 * the TOP of the doc it generates every spawn, so the persona is system-prompt
 * tier regardless of which provider the group ends up running. Because the file
 * is provider-agnostic, placement needs no provider knowledge at stamp time (the
 * provider is DB-resolved later, at first spawn).
 *
 * Security invariant: plugin content is data on the host and code only in the
 * container. Everything copied out of the plugin goes through the hardened
 * copier; nothing in the plugin is ever executed host-side.
 *
 * Returns the created group + the reader's report; the caller wires the group
 * to a channel as usual.
 */
export async function createAgentFromTemplate(ref: string, opts?: CreateAgentOptions): Promise<CreateAgentResult> {
  const dir = resolveLocalTemplate(ref);
  const tpl = parseTemplate(dir);
  // The group doesn't exist yet, so resolveGroupTimezone can't apply — the
  // effective timezone is derived from the option here and stamped onto the
  // config row below, BEFORE tasks are created, so a template task's first
  // run and its later re-arms agree on the same zone.
  const timezone = (opts?.timezone && canonicalizeIanaTimezone(opts.timezone)) || undefined;
  // TODO(T5 PR 5): route through `prepareTemplateTasks` (src/templates/tasks.ts)
  // once the scheduling theme lands `taskNameSlug` — restamp needs the id-slug
  // collision gate to match a live series.
  const tasks = tpl.tasks.map((task) => {
    try {
      return prepareScheduledTask({
        name: task.name,
        prompt: task.prompt,
        recurrence: task.schedule,
        script: task.script,
        timezone: timezone ?? TIMEZONE,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid template task ${task.source}: ${message}`, { cause: err });
    }
  });

  const id = `ag-${randomUUID()}`;
  // Display-name fallback chain: explicit option → manifest extension
  // agentName → plugin folder leaf (exactly the pre-plugin derivation).
  const name = opts?.name ?? tpl.agentName ?? path.basename(dir);
  let folder = normalizeName(name);
  assertValidGroupFolder(folder);
  // Folder uniqueness is a filesystem check plus a random suffix, never a DB
  // read — see the allowlist reason in src/db/insert-or-adopt.test.ts.
  if (fs.existsSync(resolveGroupFolderPath(folder))) folder = `${folder}-${randomUUID().slice(0, 8)}`;

  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(group);
  await ensureContainerConfig(id);
  // Dual-write, same as `groups config update`: the DB row is the read-side
  // projection (`config get`, scheduling), container.json is what the spawn
  // path hands the container as its TZ.
  if (timezone) {
    await updateContainerConfigScalars(id, { timezone });
    updateContainerConfig(folder, (config) => {
      config.timezone = timezone;
    });
  }

  // group-init.ts owns the mkdir at first spawn, but it isn't called here — so we
  // create the dir ourselves to land the standing-instructions file + context/.
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Persona → provider-neutral prepend, inlined at the top of the group's
  // CLAUDE.md/AGENTS.md every spawn (system-prompt tier on any provider).
  // Optional: a plain conformant plugin has no persona and stamps without one.
  if (tpl.instructions !== undefined) stageGroupPersona(groupDir, tpl.instructions);

  // Context extras keep their template-relative layout, placed next to the doc
  // the persona is inlined into — so a reference written in instructions.md
  // (e.g. `additional_context/faq.md`) resolves unchanged in the agent's
  // workspace. Nothing is injected into the persona; referencing each file from
  // instructions.md is the template author's job (docs/templates.md).
  for (const { name: file, content } of tpl.contextExtras) {
    const dest = path.join(groupDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }

  // Whole-plugin copy: gives stdio servers a real PLUGIN_ROOT, keeps skill
  // references into sibling plugin files working, and makes re-stamping
  // idempotent (the directory is replaced). Mounted read-only in the
  // container; only plugin-data/ is writable, matching the spec's contract.
  copyPluginDir(dir, path.join(groupDir, 'plugins', tpl.name));
  fs.mkdirSync(path.join(groupDir, 'plugin-data', tpl.name), { recursive: true });
  for (const sub of pluginDataCwdSubpaths(tpl.mcpServers)) {
    fs.mkdirSync(path.join(groupDir, 'plugin-data', tpl.name, sub), { recursive: true });
  }

  // Dual-write, same as every other MCP write path: container.json is what
  // the spawn reads. Writing only the DB projection left a stamped template's
  // servers unwired on first spawn, where the absent file materializes as an
  // empty config. The file carries the container-side marks; the ownership
  // marker rides only on the projection (see `withPluginOwner`).
  const marked = markPluginServers(tpl.mcpServers, tpl.name);
  updateContainerConfig(folder, (config) => {
    config.mcpServers = { ...(config.mcpServers ?? {}), ...marked };
  });
  await updateContainerConfigJson(id, 'mcp_servers', withPluginOwner(marked, tpl.name));

  // Per-group skills overlay — keyed by group id, never shared. Copied through
  // the hardened copier like everything else that leaves the plugin.
  const skillsDir = groupSkillsOverlayDir(id);
  for (const { name: skill, srcDir } of tpl.skills) {
    copyPluginDir(srcDir, path.join(skillsDir, skill));
  }

  // Template tasks require explicit activation. The later welcome flow can
  // present these exact paused tasks and resume only the ones the user accepts.
  for (const task of tasks) await createScheduledTask(id, task, { status: 'paused' });

  for (const line of tpl.report) log.warn('Template reader notice', { ref, notice: line });

  return { group, report: tpl.report };
}
