/**
 * Host-side daily summary digest, one post per workgroup, delivered through the workgroup's Codex sibling so it
 * posts as that bot. A workgroup opts in (and picks its channel) only via the Codex sibling's container.json
 * `dailySummary.messagingGroupId`. Shipped work splits into agent-recorded entries and commit-scan entries.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { splitForLimit } from './channels/chat-sdk-bridge.js';
import { readContainerConfig } from './container-config.js';
import type { ContainerConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getBacklog, getBacklogResolvedSince, getShipLogSince } from './db/backlog.js';
import type { BacklogItem, ShipLogEntry } from './db/backlog.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { resolveGitHubToken } from './github-token.js';
import { onHostShutdown, onHostStart } from './host-lifecycle.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroup } from './types.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const STATE_PATH = path.join(DATA_DIR, 'daily-summary-state.json');

const DEFAULT_HOUR = 8;
const DEFAULT_TZ = 'America/New_York';

// Discord's per-message cap is the tightest of the wired platforms.
const THREAD_MESSAGE_LIMIT = 1900;

let timer: NodeJS.Timeout | null = null;

export function startDailySummary(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    runTick().catch((err) => log.error('Daily summary tick failed', { err }));
    timer = setTimeout(tick, TICK_INTERVAL_MS);
    timer.unref?.();
  }, STARTUP_DELAY_MS);
  timer.unref?.();
}

export function stopDailySummary(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// A disabled duty still registers and no-ops, so the registration count is stable across configurations.
onHostStart(function dailySummaryHostStart() {
  if (process.env.DAILY_SUMMARY_ENABLED !== '0') {
    // UNGUARDED — a synchronous startup failure must abort boot (§4.2).
    startDailySummary();
    log.info('Daily summary started');
  }
});

onHostShutdown(function dailySummaryHostShutdown() {
  try {
    stopDailySummary();
  } catch (err) {
    log.error('Daily summary failed to stop', { err });
  }
});

export async function _tickForTest(): Promise<void> {
  await runTick();
}

export async function _fireDigestsForTest(): Promise<void> {
  await fireDigests();
}

/**
 * Uses `adapter.createThread`: posting to `<platform_id>:<parentId>` 404s on Discord, where a thread must be
 * created from the parent first. Falls back to a flat post without thread support or a parent id.
 */
export async function deliverBacklogThread(
  adapter: Pick<ChannelDeliveryAdapter, 'deliver' | 'createThread'>,
  channelType: string,
  platformId: string,
  parentId: string | undefined,
  backlogThread: string,
): Promise<void> {
  const chunks = splitForLimit(backlogThread, THREAD_MESSAGE_LIMIT);
  if (parentId && typeof adapter.createThread === 'function') {
    const created = await adapter.createThread(channelType, platformId, parentId, 'Open Backlog', chunks[0]);
    const threadId = created.threadId.includes(':') ? created.threadId : `${platformId}:${created.threadId}`;
    for (const chunk of chunks.slice(1)) {
      await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text: chunk }));
    }
    return;
  }
  const threadId = parentId ? `${platformId}:${parentId}` : null;
  for (const chunk of chunks) {
    await adapter.deliver(channelType, platformId, threadId, 'chat', JSON.stringify({ text: chunk }));
  }
}

async function runTick(): Promise<void> {
  const targetHour = parseHour(process.env.DAILY_SUMMARY_HOUR) ?? DEFAULT_HOUR;
  const tz = process.env.DAILY_SUMMARY_TZ || DEFAULT_TZ;
  const now = new Date();

  const hourNow = hourInZone(now, tz);
  const todayKey = dateKeyInZone(now, tz);

  if (hourNow !== targetHour) return;

  const state = readState();
  if (state.lastFiredDateKey === todayKey) return;

  log.info('Daily summary firing', { todayKey, hourNow, targetHour, tz });
  await fireDigests();
  writeState({ lastFiredDateKey: todayKey });
}

async function fireDigests(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('Daily summary: no delivery adapter — skipping');
    return;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const workgroups = groupByWorkgroup(await getAllAgentGroups());
  let sentCount = 0;

  for (const [workgroupId, members] of workgroups) {
    try {
      // By effective provider, not the deprecated agent_groups.agent_provider column.
      const poster = members.find((m) => readContainerConfig(m.folder).provider === 'codex');
      if (!poster) continue; // no Codex sibling → workgroup not eligible

      const target = await resolveTarget(poster);
      if (!target) continue; // no dailySummary override → workgroup opted out

      const posterConfig = readContainerConfig(poster.folder);
      const summary = await buildSummary(members, since, poster, posterConfig);
      if (isEmpty(summary)) continue;

      const dailySummaryConfig = posterConfig.dailySummary;
      const includeShipLog = dailySummaryConfig?.shipLog !== false;
      const includeResolved = dailySummaryConfig?.resolved !== false;
      const includeBacklog = dailySummaryConfig?.backlog !== false;
      const { parent, backlogThread } = formatDigestParts(workgroupId, summary, {
        includeShipLog,
        includeResolved,
        includeBacklog,
      });
      // The include* flags can strip every section from non-empty data; a bare header is worse than nothing.
      if (!backlogThread && parent.trim().split('\n').length <= 1) {
        log.info('Daily summary: every section disabled for this workgroup — skipping', { workgroupId });
        continue;
      }
      const parentId = await adapter.deliver(
        target.channel_type,
        target.platform_id,
        null,
        'chat',
        JSON.stringify({ text: parent }),
      );
      if (backlogThread) {
        const sendThread = () =>
          deliverBacklogThread(adapter, target.channel_type, target.platform_id, parentId, backlogThread);
        try {
          await sendThread();
        } catch (firstErr) {
          // The parent already posted; re-running the tick would double-post it, so one retry then a loud error.
          log.warn('Daily summary backlog thread failed — retrying once', { workgroupId, err: firstErr });
          try {
            await sendThread();
          } catch (err) {
            log.error('Daily summary backlog thread LOST for today (parent posted, thread failed twice)', {
              workgroupId,
              err,
            });
          }
        }
      }
      sentCount += 1;
      log.info('Daily summary delivered', {
        workgroupId,
        posterAgentGroupId: poster.id,
        messagingGroupId: target.id,
        members: members.length,
        agentShipped: summary.agentShipped.length,
        otherCommits: summary.otherCommits.length,
        resolved: summary.resolved.length,
        openBacklog: summary.openBacklog.length,
      });
    } catch (err) {
      log.warn('Daily summary delivery failed', { workgroupId, err });
    }
  }

  log.info('Daily summary cycle complete', { workgroups: workgroups.size, sent: sentCount });
}

function groupByWorkgroup(groups: AgentGroup[]): Map<string, AgentGroup[]> {
  const byWg = new Map<string, AgentGroup[]>();
  for (const g of groups) {
    const key = g.workgroup_id || g.folder;
    const list = byWg.get(key);
    if (list) list.push(g);
    else byWg.set(key, [g]);
  }
  return byWg;
}

interface Summary {
  agentShipped: ShipLogEntry[];
  otherCommits: ShipLogEntry[];
  resolved: BacklogItem[];
  openBacklog: BacklogItem[];
}

/** A declared GitHub Issues repo is the sole backlog source; legacy SQLite rows may be stale after migration. */
async function buildSummary(
  members: AgentGroup[],
  since: string,
  poster: AgentGroup,
  posterConfig: ContainerConfig,
): Promise<Summary> {
  const shipped: ShipLogEntry[] = [];
  for (const m of members) {
    shipped.push(...(await getShipLogSince(m.id, since)));
  }

  const dedupedShipped = dedupeBy(shipped, (e) => e.pr_url || `${e.title} ${e.shipped_at}`);
  const githubIssuesRepo = posterConfig.dailySummary?.githubIssuesRepo;
  const backlog =
    githubIssuesRepo !== undefined
      ? await buildGitHubIssueBacklog(poster, posterConfig, githubIssuesRepo, since)
      : await buildLegacyBacklog(members, since);

  return {
    agentShipped: dedupedShipped.filter((e) => !isCommitScanEntry(e)),
    otherCommits: dedupedShipped.filter((e) => isCommitScanEntry(e)),
    resolved: backlog.resolved,
    openBacklog: backlog.openBacklog,
  };
}

async function buildLegacyBacklog(
  members: AgentGroup[],
  since: string,
): Promise<Pick<Summary, 'resolved' | 'openBacklog'>> {
  const resolved: BacklogItem[] = [];
  const openBacklog: BacklogItem[] = [];
  for (const m of members) {
    resolved.push(...(await getBacklogResolvedSince(m.id, since)));
    openBacklog.push(...(await getBacklog(m.id, 'in_progress')), ...(await getBacklog(m.id, 'open')));
  }
  return {
    resolved: dedupeBy(resolved, (i) => i.id),
    openBacklog: dedupeBy(openBacklog, (i) => i.id),
  };
}

async function buildGitHubIssueBacklog(
  poster: AgentGroup,
  config: ContainerConfig,
  repo: string,
  since: string,
): Promise<Pick<Summary, 'resolved' | 'openBacklog'>> {
  const credentialFolder = config.credentialFolder ?? poster.folder;
  try {
    const token = await resolveGitHubToken(credentialFolder, config);
    if (!token) throw new Error('No GitHub token resolved for configured daily summary');
    const [owner, name] = parseGitHubIssuesRepo(repo);
    const open = (await fetchGitHubIssuePages(owner, name, token, 'open')).filter((issue) => !issue.pull_request);
    let closed: GitHubIssue[] = [];
    try {
      closed = (await fetchGitHubIssuePages(owner, name, token, 'closed', since)).filter(
        (issue) => !issue.pull_request,
      );
    } catch (err) {
      log.warn('Daily summary GitHub Issues resolved fetch failed; using empty GitHub resolved list', {
        posterAgentGroupId: poster.id,
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      openBacklog: open.map((issue) => mapGitHubIssue(issue, repo, poster.id)),
      resolved: closed
        .filter((issue) => issue.closed_at !== null && Date.parse(issue.closed_at) >= Date.parse(since))
        .map((issue) => mapGitHubIssue(issue, repo, poster.id)),
    };
  } catch (err) {
    // Fail closed: SQLite would re-post rows intentionally migrated away.
    log.warn('Daily summary GitHub Issues backlog fetch failed; using empty GitHub backlog', {
      posterAgentGroupId: poster.id,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return { resolved: [], openBacklog: [] };
  }
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: Array<{ name?: string } | string>;
  pull_request?: unknown;
}

function parseGitHubIssuesRepo(repo: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) throw new Error(`Invalid dailySummary.githubIssuesRepo: ${repo}`);
  return [match[1], match[2]];
}

async function fetchGitHubIssuePages(
  owner: string,
  repo: string,
  token: string,
  state: 'open' | 'closed',
  since?: string,
): Promise<GitHubIssue[]> {
  const expectedPath = `/repos/${owner}/${repo}/issues`;
  const first = new URL(`https://api.github.com${expectedPath}`);
  first.searchParams.set('state', state);
  first.searchParams.set('per_page', '100');
  first.searchParams.set('page', '1');
  if (since) first.searchParams.set('since', since);

  const issues: GitHubIssue[] = [];
  let next: URL | null = first;
  while (next) {
    const response = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'nanoclaw-daily-summary',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${state} issues`);
    const page = (await response.json()) as unknown;
    if (!Array.isArray(page)) throw new Error(`GitHub returned a non-array ${state} issues response`);
    issues.push(...(page as GitHubIssue[]));
    next = nextGitHubIssuePage(response.headers.get('link'), expectedPath);
  }
  return issues;
}

function nextGitHubIssuePage(linkHeader: string | null, expectedPath: string): URL | null {
  if (!linkHeader) return null;
  const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!nextMatch) return null;
  const next = new URL(nextMatch[1]);
  if (next.origin !== 'https://api.github.com' || next.pathname !== expectedPath) {
    throw new Error('GitHub returned an unexpected issues pagination URL');
  }
  return next;
}

function mapGitHubIssue(issue: GitHubIssue, repo: string, agentGroupId: string): BacklogItem {
  const labels = issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))).filter(Boolean);
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const priority =
    normalizedLabels.includes('severity:p0') || normalizedLabels.includes('severity:p1')
      ? 'high'
      : normalizedLabels.includes('severity:p2')
        ? 'medium'
        : normalizedLabels.includes('severity:p3')
          ? 'low'
          : 'medium';
  const inProgress = normalizedLabels.includes('in progress') || normalizedLabels.includes('status:in_progress');
  return {
    id: `github:${repo}#${issue.number}`,
    agent_group_id: agentGroupId,
    title: `#${issue.number} ${issue.title}`,
    description: issue.body,
    status: issue.state === 'closed' ? 'resolved' : inProgress ? 'in_progress' : 'open',
    priority,
    tags: JSON.stringify(labels),
    notes: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    resolved_at: issue.closed_at,
    url: issue.html_url,
  };
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** commit-scan tags `commit-digest,<repo>` as a comma string; older rows may use a JSON array. */
export function isCommitScanEntry(entry: ShipLogEntry): boolean {
  if (!entry.tags) return false;
  try {
    const parsed = JSON.parse(entry.tags);
    if (Array.isArray(parsed)) return parsed.includes('commit-digest');
  } catch {
    return entry.tags.split(',').some((t) => t.trim() === 'commit-digest');
  }
  return false;
}

function isEmpty(s: Summary): boolean {
  return (
    s.agentShipped.length === 0 && s.otherCommits.length === 0 && s.resolved.length === 0 && s.openBacklog.length === 0
  );
}

/** An unresolvable id returns null rather than falling back to a channel nobody chose. */
async function resolveTarget(poster: AgentGroup): Promise<MessagingGroup | null> {
  const config = readContainerConfig(poster.folder);
  const overrideId = config.dailySummary?.messagingGroupId;
  if (!overrideId) return null;
  const mg = await getMessagingGroup(overrideId);
  if (mg) return mg;
  log.warn('Daily summary: dailySummary.messagingGroupId not found — skipping workgroup', {
    posterAgentGroupId: poster.id,
    overrideId,
  });
  return null;
}

export function formatDigestParts(
  label: string,
  s: Summary,
  opts: { includeShipLog?: boolean; includeResolved?: boolean; includeBacklog?: boolean } = {},
): { parent: string; backlogThread: string | null } {
  const lines: string[] = [`📋 **Daily Summary** — ${label}`];

  if (opts.includeShipLog !== false) {
    appendShipSection(lines, '🤖 **Agent Shipped**', s.agentShipped);
    appendShipSection(lines, '🛠 **Other commits**', s.otherCommits);
  }

  if (opts.includeResolved !== false && s.resolved.length > 0) {
    lines.push('', `✅ **Resolved** (${s.resolved.length}):`);
    for (const item of s.resolved) {
      const emoji = item.status === 'resolved' ? '✅' : '🚫';
      lines.push(`${emoji} ${formatBacklogItemTitle(item)}`);
    }
  }

  let backlogThread: string | null = null;
  if (opts.includeBacklog !== false && s.openBacklog.length > 0) {
    lines.push('', `📌 **Open Backlog** (${s.openBacklog.length}) — ranked list in 🧵`);
    backlogThread = formatBacklogThread(s.openBacklog);
  }

  return { parent: lines.join('\n'), backlogThread };
}

export function formatDigest(label: string, s: Summary): string {
  const { parent, backlogThread } = formatDigestParts(label, s);
  return backlogThread ? `${parent}\n${backlogThread}` : parent;
}

export function formatBacklogThread(items: BacklogItem[]): string {
  const ranked = rankBacklog(items);
  const top = ranked.slice(0, 3);
  const lines: string[] = ['📌 **Open Backlog — ranked**', ''];
  if (top.length > 0) {
    lines.push(`👉 **Address first:** ${top.map((i) => formatBacklogItemTitle(i, 60)).join(' · ')}`, '');
  }
  for (const item of ranked) {
    const pri = item.priority === 'high' ? '🔴' : item.priority === 'medium' ? '🟡' : '⚪';
    const suffix = item.status === 'in_progress' ? ' · in progress' : '';
    lines.push(`${pri} ${formatBacklogItemTitle(item)} · ${ageDays(item.created_at)}d${suffix}`);
    if (item.description) lines.push(`    ↳ ${truncate(item.description, 140)}`);
  }
  return lines.join('\n');
}

export function rankBacklog(items: BacklogItem[]): BacklogItem[] {
  const priRank = { high: 0, medium: 1, low: 2 } as const;
  return [...items].sort((a, b) => {
    const prog = Number(b.status === 'in_progress') - Number(a.status === 'in_progress');
    if (prog !== 0) return prog;
    const pri = (priRank[a.priority] ?? 3) - (priRank[b.priority] ?? 3);
    if (pri !== 0) return pri;
    return a.created_at.localeCompare(b.created_at); // oldest first
  });
}

function ageDays(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatBacklogItemTitle(item: BacklogItem, max = 140): string {
  const title = truncate(item.title, max);
  if (!item.url) return title;
  return `[${title.replace(/[\\[\]]/g, '\\$&')}](${item.url})`;
}

function appendShipSection(lines: string[], header: string, entries: ShipLogEntry[]): void {
  if (entries.length === 0) return;
  lines.push('', `${header} (${entries.length}):`);
  const byRepo = groupBy(entries, extractRepo);
  const repoNames = Object.keys(byRepo);
  const showRepoHeader = repoNames.length > 1;
  for (const repo of repoNames) {
    if (showRepoHeader) lines.push(`**${repo}**`);
    for (const entry of byRepo[repo]) {
      lines.push(`• ${entry.title}${entry.pr_url ? ` — ${entry.pr_url}` : ''}`);
    }
  }
}

export function extractRepo(entry: ShipLogEntry): string {
  if (entry.pr_url) {
    const m = entry.pr_url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)/);
    if (m) return m[1];
  }
  if (entry.tags) {
    try {
      const parsed = JSON.parse(entry.tags);
      if (Array.isArray(parsed) && parsed.includes('commit-digest')) {
        const other = parsed.find((t: unknown) => typeof t === 'string' && t !== 'commit-digest');
        if (typeof other === 'string') return other;
      }
    } catch {
      // commit-scan writes tags as a comma-separated string, not JSON.
      const parts = entry.tags.split(',').map((t) => t.trim());
      if (parts.includes('commit-digest')) {
        const other = parts.find((t) => t !== 'commit-digest');
        if (other) return other;
      }
    }
  }
  if (entry.title) {
    const idx = entry.title.indexOf(':');
    if (idx > 0 && idx < 40) return entry.title.slice(0, idx);
  }
  return 'Other';
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

function hourInZone(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  return hour ? parseInt(hour, 10) : -1;
}

function dateKeyInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

function parseHour(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  return n;
}

interface State {
  lastFiredDateKey: string | null;
}

function readState(): State {
  try {
    if (!fs.existsSync(STATE_PATH)) return { lastFiredDateKey: null };
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    return { lastFiredDateKey: raw.lastFiredDateKey ?? null };
  } catch (err) {
    log.warn('Daily summary: failed to read state, treating as fresh', { err });
    return { lastFiredDateKey: null };
  }
}

function writeState(state: State): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    log.error('Daily summary: failed to write state', { err });
  }
}
