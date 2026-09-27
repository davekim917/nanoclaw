/**
 * Live backlog board in a Slack channel canvas, edited in place. Source of truth is Linear (GitHub issues sync into
 * it), reached through its hosted MCP endpoint with the credential injected by the OneCLI gateway. A workgroup
 * opts in when some group's container.json declares `backlogCanvas.messagingGroupId`; declare it on the group
 * whose bot holds `canvases:write`.
 *
 * Refresh is `canvases.edit` `replace` with NO `section_id`, which replaces the whole document despite the API
 * reference calling `section_id` required. Do not look sections up instead: every block is a section and lookup
 * cannot enumerate them, and replacing just the heading stacks copies of the board. One operation per call.
 *
 * A CHANNEL canvas keeps its first block forever (a standalone canvas does not), so the title lives there and
 * `renderBoard` emits NO heading.
 */
import { OneCLI } from '@onecli-sh/sdk';
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from './config.js';
import { readClaims, renderClaims } from './claims-board.js';
import { readContainerConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { extractSlackChannelId, loadSlackWorkspaces } from './channels/slack.js';
import { slackPermalink } from './channels/slack-mentions.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import { formatLocalTime } from './timezone.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 90_000;
const LINEAR_MCP = 'https://mcp.linear.app/mcp';
const CANVAS_TITLE = 'Backlog board';
/**
 * GitHub-synced rows carry a `severity:pN` label and no priority; native Linear tickets the reverse. Linear
 * priority 0 means "not set", sorted last.
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
/** Index is the Linear priority value. */
const PRIORITY_TO_SEVERITY: Severity[] = ['unset', 'p0', 'p1', 'p2', 'p3'];
const NO_REPO = 'Unattributed — add a `repo:` label to file these';

let timer: NodeJS.Timeout | null = null;
let rpcId = 0;

/** Node's global `fetch` ignores HTTPS_PROXY and would skip the gateway that injects the Linear credential. */
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

/** A URL without userinfo resolves to the Default Agent at the gateway, which is the 401 this path avoids. */
export function carriesAgentIdentity(proxyUrl: string): boolean {
  return /^\w+:\/\/[^@/]+@/.test(proxyUrl);
}

/**
 * Keep the agent identity, swap in the host's own proxy address: `getContainerConfig` returns the container's
 * (`host.docker.internal`), which does not resolve from the host.
 */
export function hostReachableProxy(containerProxyUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const userinfo = /^\w+:\/\/([^@/]+)@/.exec(containerProxyUrl)?.[1];
  if (!userinfo) return containerProxyUrl;
  const hostProxy = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'] || '';
  const hostPart = /^(\w+):\/\/(?:[^@/]+@)?([^/]+)/.exec(hostProxy);
  // Better to try the container URL than silently drop to the Default Agent.
  if (!hostPart) return containerProxyUrl;
  return `${hostPart[1]}://${userinfo}@${hostPart[2]}`;
}

const agentDispatchers = new Map<string, Dispatcher | null>();
/**
 * Dispatcher carrying this agent group's OneCLI identity (proxy userinfo): the host's own proxy is the Default
 * Agent, which does not hold workgroup-scoped credentials like Linear (401). Per group so it borrows only that
 * workgroup's credentials; falls back to the env dispatcher when the gateway is unreachable.
 */
async function getAgentProxyDispatcher(agentGroupId: string): Promise<Dispatcher | null> {
  const cached = agentDispatchers.get(agentGroupId);
  if (cached !== undefined) return cached;
  let dispatcher: Dispatcher | null = null;
  try {
    const cfg = await new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 }).getContainerConfig({
      agent: agentGroupId,
    });
    const url = cfg.env['HTTPS_PROXY'] || cfg.env['https_proxy'] || '';
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

// Opt-in per workgroup via container.json's backlogCanvas; BACKLOG_CANVAS_ENABLED=0 disables. A disabled duty still
// registers and no-ops, keeping the registration count stable.
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

async function runTick(): Promise<void> {
  for (const group of await getAllAgentGroups()) {
    const config = readContainerConfig(group.folder).backlogCanvas;
    if (!config?.messagingGroupId) continue;
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
  const mg = await getMessagingGroup(messagingGroupId);
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

  // Claims first: the only time-sensitive content. Best-effort; none when there is no shared FS.
  const claims = workgroupId ? readClaims(workgroupId, Date.now()) : [];
  const body = [
    renderClaims(claims, (threadId) => slackPermalink(mg.channel_type, mg.platform_id, threadId)),
    '',
    renderBoard(issues),
  ].join('\n');

  await writeCanvas(token, channelId, body, `${team} backlog board`);
  log.info('Backlog canvas refreshed', { channelId, team, issues: issues.length, claims: claims.length });
}

/** From the same env load the adapter uses, never a second regex (which missed Socket Mode workspaces). */
function slackTokenFor(channelType: string): string | null {
  return loadSlackWorkspaces().find((w) => w.channelType === channelType)?.botToken ?? null;
}

/**
 * Linear's MCP payload, NOT the GraphQL shape: the identifier arrives as `id`, `priority` is an object, and the
 * cursor is `cursor`.
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

/** Streamable-HTTP: an SSE `data:` line carries the JSON-RPC envelope, and the payload is JSON inside a text block. */
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

export async function fetchLinearIssues(team: string, agentGroupId: string): Promise<BoardIssue[]> {
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
  // Paging plus a concurrent status change can race one issue into both windows.
  return dedupeBy(out, (i) => i.identifier);
}

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

/**
 * From the `repo:` label: Linear exposes no repository field, and labels are the only repo signal that syncs.
 * Unlabelled rows bucket under NO_REPO.
 */
export function repoOf(issue: BoardIssue): string {
  for (const label of issue.labels) {
    const m = /^repo:(.+)$/i.exec(label);
    if (m) return m[1];
  }
  return NO_REPO;
}

export function severityOf(issue: BoardIssue): Severity {
  for (const label of issue.labels) {
    const m = /^severity:(p[0-3])$/i.exec(label);
    if (m) return m[1].toLowerCase() as Severity;
  }
  return PRIORITY_TO_SEVERITY[issue.priority] ?? 'unset';
}

/** Repo → severity → most recently updated. No markdown heading: the channel canvas pins its own title. */
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

/** JSON-body POST; only the canvas methods accept it (older methods need `slackGet`). */
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
 * `conversations.info` rejects a JSON body with `invalid_arguments`, which reads as "no canvas" and mints a
 * duplicate on every tick.
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

/** A channel's canvases live in `properties.tabs`, not `properties.canvas` or bookmarks. */
async function attachedCanvasIds(token: string, channelId: string): Promise<string[]> {
  const info = await slackGet(token, 'conversations.info', { channel: channelId });
  if (!info.ok) throw new Error(`conversations.info: ${String(info.error)}`);
  const props = (info.channel as { properties?: { tabs?: ChannelTab[] } } | undefined)?.properties;
  return (props?.tabs ?? [])
    .filter((t) => t.type === 'canvas' && t.label === CANVAS_TITLE && t.data?.file_id)
    .map((t) => t.data!.file_id!);
}

/**
 * Find an existing canvas FIRST: `conversations.canvases.create` happily adds another tab rather than failing.
 * Deleted canvases leave dead tabs, so each candidate is probed by the replace itself.
 */
async function writeCanvas(token: string, channelId: string, body: string, title: string): Promise<void> {
  const document_content = { type: 'markdown', markdown: body };

  const candidates = await attachedCanvasIds(token, channelId);
  for (const canvasId of candidates) {
    const edited = await slack(token, 'canvases.edit', {
      canvas_id: canvasId,
      changes: [{ operation: 'replace', document_content }],
    });
    if (!edited.ok) continue;

    if (candidates.length > 1) {
      log.warn('Backlog canvas: more than one canvas tab carries our title — updating the first live one', {
        channelId,
        candidates,
      });
    }
    return;
  }

  // Only the create carries the heading: it becomes the pinned first block.
  const created = await slack(token, 'conversations.canvases.create', {
    channel_id: channelId,
    title: CANVAS_TITLE,
    document_content: { type: 'markdown', markdown: `# ${title}\n\n${body}` },
  });
  if (!created.ok) throw new Error(`conversations.canvases.create: ${String(created.error)}`);
  log.info('Backlog canvas created', { channelId, canvasId: String(created.canvas_id) });
}
