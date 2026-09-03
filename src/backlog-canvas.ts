/**
 * Live backlog board, rendered into a Slack channel canvas.
 *
 * Replaces the daily repost of a list that barely changes. A channel canvas is
 * edited in place, so the board is always current and never fills the channel.
 *
 * Source of truth is Linear, not `backlog_items`. Defects are filed as GitHub
 * issues and mirrored into the Linear team by Linear's one-way GitHub Issues
 * Sync, so one query covers both and every row links back to its tracker item.
 *
 * Linear is reached through its hosted MCP endpoint over plain HTTP — the same
 * path containers use (see `mcpServers.linear` in container-runner.ts). The
 * OneCLI gateway injects the credential for `mcp.linear.app`, so there is no
 * key here and none in the environment.
 *
 * Opt-in + routing: a workgroup gets a board IFF some group's container.json
 * declares `backlogCanvas.messagingGroupId`. Declare it on the group whose bot
 * holds `canvases:write`; the canvas belongs to the channel, not the writer.
 *
 * ── How a refresh replaces the board ──
 * `canvases.edit` with `operation: "replace"` and NO `section_id` swaps the
 * whole document in one call. The API reference lists `section_id` as required
 * for replace; it is not, and omitting it is the only way to replace
 * everything. Verified directly: prior content is gone afterwards, not
 * appended to.
 *
 * Do not "fix" this by looking sections up first. Every block is its own
 * section — the heading, each bold group label, each list row — so a 200-row
 * board is ~2000 sections, and `canvases.sections.lookup` cannot enumerate
 * them (its `criteria` demands either `section_types`, which only matches
 * headers, or a `contains_text` that no single string satisfies). Replacing
 * just the heading section inserts the new document above the old body and
 * leaves it there, which stacked eight copies of the board before it was
 * caught.
 *
 * `canvases.edit` also accepts exactly ONE operation per call — the docs show
 * an array, the API rejects a second element.
 *
 * ── The pinned first block ──
 * A CHANNEL canvas keeps its first block permanently: whatever
 * `conversations.canvases.create` wrote there survives every later replace.
 * (A standalone `canvases.create` canvas does not behave this way, so a
 * scratch canvas will not reproduce it.) So the title lives in that pinned
 * block and `renderBoard` deliberately emits NO heading — including one would
 * render a second title under the pinned one on every refresh.
 */
import { OneCLI } from '@onecli-sh/sdk';
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from './config.js';
import { readClaims, renderClaims } from './claims-board.js';
import { readContainerConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { readEnvFileMatching } from './env.js';
import { extractSlackChannelId, parseSlackWorkspaces } from './channels/slack.js';
import { slackPermalink } from './channels/slack-mentions.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import { formatLocalTime } from './timezone.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 90_000;
const LINEAR_MCP = 'https://mcp.linear.app/mcp';
const CANVAS_TITLE = 'Backlog board';
/**
 * One severity scale for two sources. GitHub-synced rows carry a
 * `severity:pN` label and no Linear priority (sync copies labels, not
 * priority); native Linear tickets carry a priority and no severity label.
 * Both fold onto this scale so the board sorts as one list.
 *
 * Linear priority 0 means "not set", NOT "lowest" — it sorts last, below p3.
 */
const SEVERITY_ORDER = ['p0', 'p1', 'p2', 'p3', 'unset'] as const;
type Severity = (typeof SEVERITY_ORDER)[number];
const SEVERITY_ICON: Record<Severity, string> = { p0: '🔴', p1: '🟠', p2: '🟡', p3: '🔵', unset: '⚪' };
const SEVERITY_LABEL: Record<Severity, string> = {
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  unset: 'No severity set',
};
/** Linear priority value → severity. Index is the priority value. */
const PRIORITY_TO_SEVERITY: Severity[] = ['unset', 'p0', 'p1', 'p2', 'p3'];
/**
 * Catch-all for rows carrying no `repo:` label — Linear-native tickets, plus
 * any GitHub issue filed without one. Named as an instruction rather than a
 * category because it is fixable in place: add a `repo:` label in Linear (or on
 * the GitHub issue, which syncs) and the row files itself next refresh.
 */
const NO_REPO = 'Unattributed — add a `repo:` label to file these';

let timer: NodeJS.Timeout | null = null;
let rpcId = 0;

/**
 * Node 20's global `fetch` ignores HTTPS_PROXY, so a bare fetch would go direct
 * and skip the OneCLI gateway — which is where the Linear credential is
 * injected. Without this the Linear call 401s and the Slack call loses its
 * egress path. Lazy-init mirrors llm.ts / session-title-sweep.ts.
 */
let _envProxyDispatcher: Dispatcher | null | undefined;
function getProxyDispatcher(): Dispatcher | null {
  if (_envProxyDispatcher !== undefined) return _envProxyDispatcher;
  const hasProxyEnv = !!(
    process.env['HTTPS_PROXY'] ||
    process.env['https_proxy'] ||
    process.env['HTTP_PROXY'] ||
    process.env['http_proxy']
  );
  _envProxyDispatcher = hasProxyEnv ? new EnvHttpProxyAgent() : null;
  return _envProxyDispatcher;
}

/**
 * Does this proxy URL carry an agent identity (`x:<token>@host`)?
 *
 * Exported only so it can be tested. A URL without userinfo resolves to the
 * Default Agent at the gateway, which is precisely the 401 this whole path
 * exists to avoid — so accepting one would reproduce the bug silently while
 * looking like the fix was applied.
 */
export function carriesAgentIdentity(proxyUrl: string): boolean {
  return /^\w+:\/\/[^@/]+@/.test(proxyUrl);
}

/**
 * Dispatcher carrying a specific agent group's OneCLI identity.
 *
 * The gateway resolves WHICH credentials to inject from the identity in the
 * proxy URL's userinfo (`x:<agent-token>@`). Containers get that from
 * `applyContainerConfig({ agent })`; the host's own `HTTPS_PROXY` has no
 * userinfo at all, so every host-side call is the Default Agent.
 *
 * That is why this refresh 401'd 686 times in a row on one install while the
 * very same Linear call succeeded from inside every one of that workgroup's
 * containers: the Linear secret is scoped to those agents, and the Default
 * Agent does not hold it. Verified against a live gateway — no userinfo, and
 * an explicit Default Agent identity, both return 401; a workgroup agent's
 * identity returns 200.
 *
 * Per group rather than per host, deliberately: the canvas is already a
 * per-folder feature, so it should borrow that workgroup's credentials and
 * nothing else. Granting Linear to the Default Agent would have fixed the
 * symptom by widening a workgroup-scoped credential to every host-side call.
 *
 * Falls back to the env dispatcher when the gateway cannot be reached, so a
 * gateway blip degrades to today's behaviour instead of losing the board.
 */
/**
 * Keep the agent identity, swap the address for one this process can reach.
 *
 * `getContainerConfig` answers with the URL a CONTAINER would use — on this
 * install `host.docker.internal:10255`, which does not resolve from the host
 * and fails as a bare `fetch failed` with no mention of proxies. The identity
 * is the part we came for; the address has to be the host's own.
 *
 * Exported for tests.
 */
export function hostReachableProxy(containerProxyUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const userinfo = /^\w+:\/\/([^@/]+)@/.exec(containerProxyUrl)?.[1];
  if (!userinfo) return containerProxyUrl;
  const hostProxy = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'] || '';
  const hostPart = /^(\w+):\/\/(?:[^@/]+@)?([^/]+)/.exec(hostProxy);
  // No host proxy configured: the container URL is all we have. Better to try
  // it than to silently drop the identity and fall back to Default Agent.
  if (!hostPart) return containerProxyUrl;
  return `${hostPart[1]}://${userinfo}@${hostPart[2]}`;
}

const agentDispatchers = new Map<string, Dispatcher | null>();
async function getAgentProxyDispatcher(agentGroupId: string): Promise<Dispatcher | null> {
  const cached = agentDispatchers.get(agentGroupId);
  if (cached !== undefined) return cached;
  let dispatcher: Dispatcher | null = null;
  try {
    const cfg = await new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 }).getContainerConfig({
      agent: agentGroupId,
    });
    const url = cfg.env['HTTPS_PROXY'] || cfg.env['https_proxy'] || '';
    // Only useful if it actually carries an identity; a bare proxy URL would
    // reproduce the Default Agent 401 with extra steps.
    if (url && carriesAgentIdentity(url)) dispatcher = new ProxyAgent(hostReachableProxy(url));
  } catch (err) {
    log.warn('Backlog canvas: could not resolve agent proxy identity', { agentGroupId, err });
  }
  agentDispatchers.set(agentGroupId, dispatcher);
  return dispatcher;
}

export function startBacklogCanvas(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    runTick().catch((err) => log.error('Backlog canvas tick failed', { err }));
    timer = setTimeout(tick, TICK_INTERVAL_MS);
    timer.unref?.();
  }, STARTUP_DELAY_MS);
  timer.unref?.();
}

export function stopBacklogCanvas(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// Opt-in per workgroup via container.json's backlogCanvas; no declaration
// anywhere means this loops over nothing. Set BACKLOG_CANVAS_ENABLED=0 to
// disable outright. A disabled duty still registers and no-ops, so the
// registration count is stable across configurations.
onHostStart(function backlogCanvasHostStart() {
  if (process.env.BACKLOG_CANVAS_ENABLED !== '0') {
    // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
    startBacklogCanvas();
    log.info('Backlog canvas started');
  }
});

onHostShutdown(function backlogCanvasHostShutdown() {
  try {
    stopBacklogCanvas();
  } catch (err) {
    log.error('Backlog canvas failed to stop', { err });
  }
});

/** Exposed for tests and for `scripts/refresh-backlog-canvas.ts`. */
export async function runTick(): Promise<void> {
  for (const group of getAllAgentGroups()) {
    const config = readContainerConfig(group.folder).backlogCanvas;
    if (!config?.messagingGroupId) continue; // not opted in
    try {
      const team = config.linearTeam || 'XZO';
      await refreshBoard(config.messagingGroupId, team, group.id, group.workgroup_id ?? null);
    } catch (err) {
      log.warn('Backlog canvas refresh failed', { folder: group.folder, err });
    }
  }
}

async function refreshBoard(
  messagingGroupId: string,
  team: string,
  agentGroupId: string,
  workgroupId: string | null,
): Promise<void> {
  const mg = getMessagingGroup(messagingGroupId);
  if (!mg) {
    log.warn('Backlog canvas: messagingGroupId not found — skipping', { messagingGroupId });
    return;
  }
  const token = slackTokenFor(mg.channel_type);
  if (!token) {
    log.warn('Backlog canvas: no Slack token for channel type', { channelType: mg.channel_type });
    return;
  }
  const channelId = extractSlackChannelId(mg.platform_id);
  const issues = await fetchLinearIssues(team, agentGroupId);

  // "Who has it" above "what exists" — a claim needing a human is the only
  // thing on this canvas that is time-sensitive, so it must not sit under a
  // long backlog. Claims are best-effort: a workgroup with no shared FS reads
  // as none, and the backlog board still renders.
  const claims = workgroupId ? readClaims(workgroupId, Date.now()) : [];
  const body = [
    renderClaims(claims, (threadId) => slackPermalink(mg.channel_type, mg.platform_id, threadId)),
    '',
    renderBoard(issues),
  ].join('\n');

  await writeCanvas(token, channelId, body, `${team} backlog board`);
  log.info('Backlog canvas refreshed', { channelId, team, issues: issues.length, claims: claims.length });
}

/** Bot token for a channel type, from the same env parse the adapter uses. */
function slackTokenFor(channelType: string): string | null {
  const workspaces = parseSlackWorkspaces(readEnvFileMatching(/^SLACK_(BOT_TOKEN|SIGNING_SECRET)(_[A-Za-z0-9_]+)?$/));
  return workspaces.find((w) => w.channelType === channelType)?.botToken ?? null;
}

// ── Linear ──

/**
 * Field names here follow Linear's MCP payload, which is NOT the GraphQL shape:
 * the human identifier arrives as `id` (e.g. "XZO-340"), `priority` is an
 * object rather than a number, and the page cursor is `cursor`, not
 * `endCursor`. Verified against a live response.
 */
export interface BoardIssue {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  status: string;
  statusType: string;
  labels: string[];
  updatedAt: string;
}

/**
 * One `tools/call` against the hosted Linear MCP. The transport is
 * streamable-HTTP: the response is an SSE frame whose `data:` line carries the
 * JSON-RPC envelope, and the tool's own payload is JSON *inside* a text content
 * block — hence the double parse.
 */
async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
  dispatcher: Dispatcher | null,
): Promise<Record<string, unknown>> {
  const res = await undiciFetch(LINEAR_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`Linear MCP ${tool}: HTTP ${res.status}`);
  const raw = await res.text();
  for (const line of raw.split('\n')) {
    const trimmed = line.startsWith('data: ') ? line.slice(6).trim() : line.trim();
    if (!trimmed.startsWith('{')) continue;
    const envelope = JSON.parse(trimmed) as {
      error?: unknown;
      result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    };
    if (envelope.error) throw new Error(`Linear MCP ${tool}: ${JSON.stringify(envelope.error).slice(0, 200)}`);
    const content = envelope.result?.content ?? [];
    if (envelope.result?.isError) throw new Error(`Linear MCP ${tool}: ${JSON.stringify(content).slice(0, 200)}`);
    const text = content.find((c) => c.type === 'text')?.text;
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  throw new Error(`Linear MCP ${tool}: no JSON frame in response`);
}

/** Every unstarted/started issue on the team, paged out. */
export async function fetchLinearIssues(team: string, agentGroupId: string): Promise<BoardIssue[]> {
  // Agent-scoped identity, falling back to the host env dispatcher.
  const dispatcher = (await getAgentProxyDispatcher(agentGroupId)) ?? getProxyDispatcher();
  const out: BoardIssue[] = [];
  for (const state of ['backlog', 'unstarted', 'started']) {
    let cursor: string | undefined;
    do {
      const page = (await mcpCall(
        'list_issues',
        {
          team,
          state,
          limit: 250,
          ...(cursor ? { cursor } : {}),
        },
        dispatcher,
      )) as { issues?: unknown[]; hasNextPage?: boolean; cursor?: string };
      for (const raw of page.issues ?? []) {
        const it = raw as Record<string, unknown>;
        out.push({
          identifier: String(it.id ?? ''),
          title: String(it.title ?? ''),
          url: String(it.url ?? ''),
          priority: priorityValue(it.priority),
          status: String(it.status ?? ''),
          statusType: String(it.statusType ?? ''),
          labels: Array.isArray(it.labels) ? it.labels.map((l) => String(l)) : [],
          updatedAt: String(it.updatedAt ?? ''),
        });
      }
      cursor = page.hasNextPage ? page.cursor : undefined;
    } while (cursor);
  }
  // Same issue can't appear under two status types, but paging plus a
  // concurrent status change can race one into both windows.
  return dedupeBy(out, (i) => i.identifier);
}

/** Linear MCP sends `{ value, name }`; older shapes sent a bare number. */
function priorityValue(priority: unknown): number {
  if (typeof priority === 'number') return priority;
  if (priority && typeof priority === 'object') {
    const v = (priority as { value?: unknown }).value;
    if (typeof v === 'number') return v;
  }
  return 0;
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Render ──

/**
 * Source repo, from the `repo:<name>` label. Linear exposes no repository
 * field: the GitHub link lives in an attachment, which `list_issues` cannot
 * return and `get_issue` would cost one call per row. Labels DO sync, so a
 * `repo:` label on the GitHub issue is the only repo signal that survives —
 * verified by syncing a probe issue and reading it back.
 *
 * An unlabelled row is a native Linear ticket (or a GitHub issue filed without
 * the label) and buckets under NO_REPO rather than disappearing.
 */
export function repoOf(issue: BoardIssue): string {
  for (const label of issue.labels) {
    const m = /^repo:(.+)$/i.exec(label);
    if (m) return m[1];
  }
  return NO_REPO;
}

/** `severity:pN` label when present, else the Linear priority folded onto it. */
export function severityOf(issue: BoardIssue): Severity {
  for (const label of issue.labels) {
    const m = /^severity:(p[0-3])$/i.exec(label);
    if (m) return m[1].toLowerCase() as Severity;
  }
  return PRIORITY_TO_SEVERITY[issue.priority] ?? 'unset';
}

/**
 * Grouped repo → severity, most-recently-updated within each severity.
 * Deliberately not age-ranked: age was the old backlog's tiebreak because
 * nothing ever moved, whereas a synced tracker touches rows when work happens.
 *
 * Emits NO markdown heading — the channel canvas pins its own title block.
 * See "The pinned first block" at the top of this file.
 */
export function renderBoard(issues: BoardIssue[]): string {
  const lines: string[] = [];
  if (issues.length === 0) {
    lines.push('_Nothing open._', '', stampLine(0));
    return lines.join('\n');
  }

  const byRepo = new Map<string, BoardIssue[]>();
  for (const issue of issues) {
    const repo = repoOf(issue);
    const bucket = byRepo.get(repo);
    if (bucket) bucket.push(issue);
    else byRepo.set(repo, [issue]);
  }

  // Alphabetical so the board reads the same way twice; the catch-all bucket
  // sits last because it is the least actionable.
  const repos = [...byRepo.keys()].sort((a, b) => {
    if (a === NO_REPO) return 1;
    if (b === NO_REPO) return -1;
    return a.localeCompare(b);
  });

  for (const repo of repos) {
    const inRepo = byRepo.get(repo) ?? [];
    lines.push(`**${repo} — ${inRepo.length}**`, '');
    for (const severity of SEVERITY_ORDER) {
      const atSeverity = inRepo
        .filter((i) => severityOf(i) === severity)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (atSeverity.length === 0) continue;
      lines.push(`${SEVERITY_ICON[severity]} ${SEVERITY_LABEL[severity]} · ${atSeverity.length}`);
      for (const issue of atSeverity) lines.push(row(issue));
      lines.push('');
    }
  }

  lines.push(stampLine(issues.length));
  return lines.join('\n');
}

/**
 * Severity and repo are already the grouping, so they are stripped from the
 * per-row label list — repeating them on every line is noise.
 */
function row(i: BoardIssue): string {
  const link = i.url ? `[${i.identifier}](${i.url})` : i.identifier;
  const rest = i.labels.filter((l) => !/^(repo:|severity:p[0-3]$)/i.test(l));
  const labels = rest.length > 0 ? ` \`${rest.join('` `')}\`` : '';
  const progress = i.statusType === 'started' ? ' · _in progress_' : '';
  return `- ${link} — ${i.title}${labels}${progress}`;
}

function stampLine(count: number): string {
  const when = formatLocalTime(new Date().toISOString(), TIMEZONE);
  return `_${count} item${count === 1 ? '' : 's'} · updated ${when} · edit in Linear, not here._`;
}

// ── Slack canvas ──

/**
 * POST with a JSON body. Only the canvas methods accept that encoding — the
 * older read methods reject it with `invalid_arguments` even though the field
 * is present, so those go through `slackGet`.
 */
async function slack(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dispatcher = getProxyDispatcher();
  const res = await undiciFetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    ...(dispatcher ? { dispatcher } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * GET with query params, for methods that predate JSON bodies.
 * `conversations.info` is one: POSTing `{"channel":"C…"}` as JSON returns
 * `invalid_arguments — missing required field: channel`, which reads as
 * "no canvas attached" and silently mints a duplicate canvas on every tick.
 */
async function slackGet(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const dispatcher = getProxyDispatcher();
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`;
  const res = await undiciFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    ...(dispatcher ? { dispatcher } : {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

interface ChannelTab {
  type?: string;
  label?: string;
  data?: { file_id?: string };
}

/**
 * Canvas ids already attached to this channel under our title, newest last.
 *
 * A channel carries canvases as entries in `properties.tabs`, NOT as the
 * singular `properties.canvas` the API reference implies — that field stays
 * null here. They are also not bookmarks (`bookmarks.list` is empty), so this
 * is the only read path.
 */
async function attachedCanvasIds(token: string, channelId: string): Promise<string[]> {
  const info = await slackGet(token, 'conversations.info', { channel: channelId });
  if (!info.ok) throw new Error(`conversations.info: ${String(info.error)}`);
  const props = (info.channel as { properties?: { tabs?: ChannelTab[] } } | undefined)?.properties;
  return (props?.tabs ?? [])
    .filter((t) => t.type === 'canvas' && t.label === CANVAS_TITLE && t.data?.file_id)
    .map((t) => t.data!.file_id!);
}

/**
 * Replace the board's single section, or create the canvas if there isn't a
 * usable one yet. `canvases.edit` takes ONE operation per call, so a steady-
 * state refresh is a fixed three requests: info, lookup, replace.
 *
 * Finding the existing canvas FIRST is load-bearing. `conversations.canvases
 * .create` does not fail with `channel_canvas_already_exists` on this
 * workspace — it cheerfully adds another canvas tab — so a create-then-detect
 * design mints a new canvas on every tick. Deleting a canvas also leaves its
 * tab behind pointing at a dead file, which is why each candidate is probed
 * with a lookup rather than trusted.
 */
async function writeCanvas(token: string, channelId: string, body: string, title: string): Promise<void> {
  const document_content = { type: 'markdown', markdown: body };

  const candidates = await attachedCanvasIds(token, channelId);
  for (const canvasId of candidates) {
    // No section_id — whole-document replace. See the header note.
    const edited = await slack(token, 'canvases.edit', {
      canvas_id: canvasId,
      changes: [{ operation: 'replace', document_content }],
    });
    if (!edited.ok) continue; // orphaned tab pointing at a deleted file

    if (candidates.length > 1) {
      log.warn('Backlog canvas: more than one canvas tab carries our title — updating the first live one', {
        channelId,
        candidates,
      });
    }
    return;
  }

  // Only the create carries the heading: it becomes the canvas's pinned first
  // block, which every later replace leaves alone.
  const created = await slack(token, 'conversations.canvases.create', {
    channel_id: channelId,
    title: CANVAS_TITLE,
    document_content: { type: 'markdown', markdown: `# ${title}\n\n${body}` },
  });
  if (!created.ok) throw new Error(`conversations.canvases.create: ${String(created.error)}`);
  log.info('Backlog canvas created', { channelId, canvasId: String(created.canvas_id) });
}
