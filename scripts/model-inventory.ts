/**
 * Read-only inventory of every place a model/effort choice lives, layer by layer,
 * plus what actually ran (turn_usage, last N days). Run from the repo root:
 *   pnpm exec tsx scripts/model-inventory.ts [--days 7] [--json]
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_OPUS_MODEL,
  DEFAULT_SONNET_MODEL,
  DEFAULT_HAIKU_MODEL,
  resolveEffectiveModel,
} from '../src/flag-parser.js';
import { discoverClaudeSubagents } from '../src/claude-subagent-discovery.js';
import { isExcludedPluginPath, splitExcludedPlugins } from '../src/plugin-exclusions.js';
import { loadPluginScopes, pluginAllowedForWorkgroup } from '../src/plugin-scopes.js';

const ROOT = process.cwd(); // live data: data/, groups/
// Code defaults are read from the same tree the imported constants come from.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const asJson = args.includes('--json');
const db = new Database(path.join(ROOT, 'data/v2.db'), { readonly: true });

const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const grab = (src: string, re: RegExp) => src.match(re)?.[1] ?? '?';

// ── 1. Install-wide code defaults ───────────────────────────────────────────
const claudeTs = read(path.join(REPO, 'container/agent-runner/src/providers/claude.ts'));
const codexTs = read(path.join(REPO, 'container/agent-runner/src/providers/codex.ts'));
const opencodeTs = read(path.join(REPO, 'src/providers/opencode.ts'));
const dockerfile = read(path.join(REPO, 'container/Dockerfile'));
const runnerPkg = JSON.parse(read(path.join(REPO, 'container/agent-runner/package.json')) || '{}');
const effortFor = (fam: string) =>
  grab(claudeTs, new RegExp(`m === '${fam}'[^\\n]*return '([a-z]+)'`)) !== '?'
    ? grab(claudeTs, new RegExp(`m === '${fam}'[^\\n]*return '([a-z]+)'`))
    : grab(claudeTs, new RegExp(`startsWith\\('claude-${fam}-'\\)\\) return '([a-z]+)'`));
// Mirrors defaultEffortForModel in the container claude.ts: the family default
// follows the RESOLVED model, and Haiku has no effort control at all.
const claudeFamilyEffort = (model: string) => {
  const m = model.replace(/ \(default\)$/, '').toLowerCase();
  if (m === 'haiku' || m.startsWith('claude-haiku-')) return '(none — haiku)';
  if (m === 'opus' || m.startsWith('claude-opus-')) return `${effortFor('opus')} (family default)`;
  if (m === 'sonnet' || m.startsWith('claude-sonnet-')) return `${effortFor('sonnet')} (family default)`;
  if (m.startsWith('claude-fable-')) return `${effortFor('fable')} (family default)`;
  // Anything else (e.g. the accepted `default` value) takes the runtime's
  // final fallback, not a family default.
  return `${grab(claudeTs, /return '([a-z]+)';\n\}\n\n\/\*\*\n \* Effort support per model family/)} (runtime fallback)`;
};
const installDefaults = {
  claude: {
    unpinnedGroupModel: DEFAULT_OPUS_MODEL,
    aliases: { opus: DEFAULT_OPUS_MODEL, sonnet: DEFAULT_SONNET_MODEL, haiku: DEFAULT_HAIKU_MODEL },
    defaultEffort: { opus: effortFor('opus'), sonnet: effortFor('sonnet'), fable: effortFor('fable') },
    cli: grab(dockerfile, /ARG CLAUDE_CODE_VERSION=(\S+)/),
    sdk: runnerPkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? '?',
  },
  codex: {
    model: grab(codexTs, /DEFAULT_CODEX_MODEL = '([^']+)'/),
    effort: grab(codexTs, /DEFAULT_CODEX_EFFORT = '([^']+)'/),
  },
  opencode: {
    model: grab(opencodeTs, /DEFAULT_OPENCODE_MODEL = '([^']+)'/),
    effort: grab(opencodeTs, /DEFAULT_OPENCODE_EFFORT = '([^']+)'/),
  },
};

// ── 2. Per group: container.json (authoritative) vs container_configs (projection)
type Group = { id: string; name: string; folder: string; workgroup_id: string | null };
const groups = db.prepare('select id, name, folder, workgroup_id from agent_groups order by folder').all() as Group[];
const dbCfg = new Map(
  (db.prepare('select agent_group_id, provider, model, effort from container_configs').all() as any[]).map((r) => [
    r.agent_group_id,
    r,
  ]),
);
const groupRows = groups.map((g) => {
  const cj = JSON.parse(read(path.join(ROOT, 'groups', g.folder, 'container.json')) || '{}');
  const provider = cj.provider || 'claude';
  const model = cj.model || cj.defaultModel || '';
  const effort = cj.effort || cj.defaultEffort || '';
  const d = dbCfg.get(g.id) ?? {};
  const inst = (installDefaults as any)[provider] ?? {};
  const effModel = model
    ? provider === 'claude'
      ? resolveEffectiveModel(model)
      : model
    : provider === 'claude'
      ? `${DEFAULT_OPUS_MODEL} (default)`
      : `${inst.model} (default)`;
  const effEffort =
    effort || (provider === 'claude' ? claudeFamilyEffort(effModel) : `${inst.effort} (default)`);
  const drift =
    (d.provider || 'claude') !== provider || (d.model ?? '') !== (cj.model ?? '') || (d.effort ?? '') !== (cj.effort ?? '')
      ? `DB=${d.provider || 'claude'}:${d.model || '-'}/${d.effort || '-'}`
      : '';
  return { folder: g.folder, id: g.id, provider, model: effModel, effort: effEffort, drift };
});
const byId = new Map(groups.map((g) => [g.id, g.folder]));

// ── 3. Channel wiring overrides ─────────────────────────────────────────────
const wirings = db
  .prepare(
    `select mg.name channel, mg.platform_id, mga.agent_group_id, mga.default_model model, mga.default_effort effort
       from messaging_group_agents mga join messaging_groups mg on mg.id = mga.messaging_group_id
      where coalesce(mga.default_model,'') <> '' or coalesce(mga.default_effort,'') <> ''
      order by mg.name`,
  )
  .all() as any[];

// ── 4. Scheduled-task pins (live series) ───────────────────────────────────
// Tasks live in each group's system-session inbound.db; `ncl tasks list --json`
// is the one reader that already knows where.
let tasks: any[];
try {
  const raw = JSON.parse(execFileSync('ncl', ['tasks', 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  tasks = Array.isArray(raw) ? raw : (raw.data ?? raw.tasks ?? []);
} catch (e) {
  tasks = [];
  console.error(`WARN: ncl tasks list failed — task pins NOT inventoried (${(e as Error).message.split('\n')[0]})`);
}
const pinned = tasks
  .filter((t) => t.model_pin || t.effort_pin)
  .map((t) => ({
    series: t.series_id,
    group: byId.get(t.agent_group_id) ?? t.agent_group_id,
    recurrence: t.recurrence ?? 'one-shot',
    model: t.model_pin || '(group)',
    effort: t.effort_pin || '(group)',
  }));
const unpinnedCount = tasks.length - pinned.length;

// ── 5. Subagent definitions (per group + plugin) ────────────────────────────
const subagents: { where: string; name: string; model: string; effort: string }[] = [];
const fm = (src: string, key: string) => grab(src, new RegExp(`^${key}:\\s*(.+)$`, 'm'));
const toml = (src: string, key: string) => grab(src, new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
for (const g of groups) {
  for (const [dir, kind] of [
    ['.claude/agents', 'md'],
    ['.codex/agents', 'toml'],
  ] as const) {
    const d = path.join(ROOT, 'groups', g.folder, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((f) => f.endsWith(`.${kind}`))) {
      const src = read(path.join(d, f));
      const model = kind === 'md' ? fm(src, 'model') : toml(src, 'model');
      const effort = kind === 'md' ? fm(src, 'effort') : toml(src, 'model_reasoning_effort');
      // No model and no effort = pure inherit; effort-only worker-* shims are dispatch
      // plumbing (the dispatch names the model), not a standing choice.
      if (model === '?' && (effort === '?' || /^worker-/.test(f))) continue;
      subagents.push({
        where: `${g.folder}/${dir}`,
        name: f,
        model: model === '?' ? '(inherit)' : model,
        effort: effort === '?' ? '(inherit)' : effort,
      });
    }
  }
}

// Plugin agent defs: every ~/plugins/<repo> is mounted into every group unless
// that group excludes it (container.json excludePlugins, top-level or sub-path)
// or the plugin is scoped to other workgroups — the same two predicates the
// spawn path and the in-container walkers apply.
const pluginsRoot = path.join(os.homedir(), 'plugins');
const scopes = loadPluginScopes();
const groupMeta = groups.map((g) => {
  const cj = JSON.parse(read(path.join(ROOT, 'groups', g.folder, 'container.json')) || '{}');
  // Same precedence as resolveWorkgroupIdAtSpawn: the file wins over the DB projection.
  const wg = cj.workgroup_id !== undefined ? cj.workgroup_id : (g.workgroup_id ?? g.folder);
  return { folder: g.folder, wg, excluded: splitExcludedPlugins(cj.excludePlugins) };
});
const reachLabel = (reached: string[]) => {
  const missing = groupMeta.map((g) => g.folder).filter((f) => !reached.includes(f));
  if (!missing.length) return 'all groups';
  if (!reached.length) return 'no group';
  return missing.length < reached.length ? `all except ${missing.join(',')}` : reached.join(',');
};
// The set comes from the runtime's own walk (discoverClaudeSubagents: depth
// limit, deprecated/ and runtime-copy dirs skipped), not a second walker. It
// omits workgroup-scoped plugins, which that walk never mirrors either.
for (const def of discoverClaudeSubagents().filter((d) => d.source === 'plugin')) {
  const rel = path.relative(pluginsRoot, def.path).split(path.sep).join('/');
  const src = read(def.path);
  const model = fm(src, 'model');
  const effort = fm(src, 'effort');
  if ((model === '?' || model === 'inherit') && (effort === '?' || /\/worker-[^/]+$/.test(rel))) continue;
  const repo = rel.split('/')[0];
  // Mirrors IN_TREE_SHADOWED_PLUGINS in src/container-runner.ts: never mounted.
  if (repo === 'design-artifact-loop' || repo === 'gitnexus') continue;
  const pluginDir = rel.replace(/\/agents\/[^/]+$/, '');
  const reach = groupMeta.filter(
    (g) => pluginAllowedForWorkgroup(repo, g.wg, scopes) && !isExcludedPluginPath(pluginDir, g.excluded),
  );
  subagents.push({
    where: `plugin:${pluginDir} → ${reachLabel(reach.map((g) => g.folder))}`,
    name: path.basename(rel),
    model: model === '?' ? '(inherit)' : model,
    effort: effort === '?' ? '(inherit)' : effort,
  });
}

// ── 6. Session sticky pins (-m/-e sticky) on active sessions ────────────────
const stickies: any[] = [];
const stickyReadFailures: string[] = [];
for (const s of db
  .prepare(
    `select s.id, s.agent_group_id, mg.name channel from sessions s
       left join messaging_groups mg on mg.id = s.messaging_group_id where s.status = 'active'`,
  )
  .all() as any[]) {
  const p = path.join(ROOT, 'data/v2-sessions', s.agent_group_id, s.id, 'outbound.db');
  if (!fs.existsSync(p)) continue;
  let o: Database.Database | undefined;
  try {
    o = new Database(p, { readonly: true, fileMustExist: true });
    const kv = Object.fromEntries(
      (o.prepare(`select key, value from session_state where key in ('sticky_model','sticky_effort')`).all() as any[]).map(
        (r) => [r.key, r.value],
      ),
    );
    if (kv.sticky_model || kv.sticky_effort)
      stickies.push({
        group: byId.get(s.agent_group_id),
        channel: s.channel ?? '(system)',
        session: s.id,
        model: kv.sticky_model ?? '-',
        effort: kv.sticky_effort ?? '-',
      });
  } catch (e) {
    // An outbound DB older than session_state has nothing sticky; any other
    // failure hides a possible pin, so it is reported, never swallowed.
    if (!/no such table: session_state/.test((e as Error).message)) {
      stickyReadFailures.push(`${s.id}: ${(e as Error).message}`);
    }
  } finally {
    o?.close();
  }
}

// ── 7. What actually ran (turn_usage) ───────────────────────────────────────
const since = new Date(Date.now() - days * 864e5).toISOString();
const observed = db
  .prepare(
    `select agent_group_id g, trigger, model, coalesce(effort,'-') effort, count(*) n
       from turn_usage where ts > ? group by 1,2,3,4 order by 1, n desc`,
  )
  .all(since) as any[];

const out = { stickyReadFailures, installDefaults, groups: groupRows, wirings, pinned, unpinnedCount, subagents, stickies, observed };
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const table = (title: string, rows: Record<string, unknown>[]) => {
  console.log(`\n## ${title}`);
  if (!rows.length) return console.log('(none)');
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
};
const ic = installDefaults.claude;
console.log('## Install defaults (code)');
console.log(
  `claude   unpinned=${ic.unpinnedGroupModel}  effort opus/sonnet/fable=${ic.defaultEffort.opus}/${ic.defaultEffort.sonnet}/${ic.defaultEffort.fable}  cli=${ic.cli} sdk=${ic.sdk}`,
);
console.log(`         aliases opus→${ic.aliases.opus} sonnet→${ic.aliases.sonnet} haiku→${ic.aliases.haiku}`);
console.log(`codex    ${installDefaults.codex.model} / ${installDefaults.codex.effort}`);
console.log(`opencode ${installDefaults.opencode.model} / ${installDefaults.opencode.effort}`);
table('Agent groups (effective; container.json → install default)', groupRows.map(({ id, ...r }) => r));
table('Channel wiring overrides', wirings.map((w) => ({ ...w, agent_group_id: byId.get(w.agent_group_id) ?? w.agent_group_id })));
table(`Scheduled-task pins (${pinned.length} pinned, ${unpinnedCount} follow their group)`, pinned);
table('Subagent defs with a model or effort', subagents);
table('Sticky -m/-e on active sessions', stickies);
for (const f of stickyReadFailures) console.log(`WARN sticky state unreadable — ${f}`);
table(
  `Observed last ${days}d (turn_usage)`,
  observed.map((r) => ({ group: byId.get(r.g) ?? r.g, trigger: r.trigger, model: r.model, effort: r.effort, turns: r.n })),
);
