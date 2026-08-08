/**
 * Host-side daily summary digest — one consolidated post per WORKGROUP.
 *
 * Mirrors v1's daily-notifications, but aggregated at the workgroup layer
 * rather than per agent group. Once a day, for each workgroup that opts in,
 * build a digest of recent ship_log + backlog activity across ALL its sibling
 * agent groups (Claude + Codex + OpenCode), dedupe, and post a single message
 * through the workgroup's Codex sibling — so siblings no longer each emit their
 * own duplicate digest.
 *
 * Opt-in + routing: a workgroup gets a digest IFF its Codex sibling's
 * container.json declares `dailySummary.messagingGroupId`. That field both
 * enables the workgroup AND chooses the destination channel (e.g. Discord for
 * example-retail, Slack #agents-example for example-labs). No override → no digest, so
 * dormant workgroups stay silent without a per-group disable flag. Delivering
 * through the Codex sibling's own channel means the message posts AS the Codex
 * bot ("Example Assistant Codex", etc.), which is the intended author.
 *
 * Shipped work is split into two sections so agent-driven and human/direct
 * work are distinguishable:
 *   - 🤖 Agent Shipped — ship_log entries from the `add_ship_log` MCP tool
 *     (an agent opened a PR / recorded work inline).
 *   - 🛠 Other commits — ship_log entries from host-side `commit-scan`
 *     (default-branch commits in cloned repos, tagged `commit-digest,<repo>`),
 *     which is how non-agent / human commits surface.
 *
 * Trigger model: ticks every 5 min, fires when local hour in DAILY_SUMMARY_TZ
 * matches DAILY_SUMMARY_HOUR and we haven't already fired today (per a small
 * JSON state file). Hour-only granularity is enough for "daily at 8am ET" —
 * no cron-parser dep.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readContainerConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getBacklog, getBacklogResolvedSince, getShipLogSince } from './db/backlog.js';
import type { BacklogItem, ShipLogEntry } from './db/backlog.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroup } from './types.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;
const STATE_PATH = path.join(DATA_DIR, 'daily-summary-state.json');

const DEFAULT_HOUR = 8;
const DEFAULT_TZ = 'America/New_York';

let timer: NodeJS.Timeout | null = null;

export function startDailySummary(): void {
  if (timer) return;
  timer = setTimeout(function tick() {
    runTick().catch((err) => log.error('Daily summary tick failed', { err }));
    timer = setTimeout(tick, TICK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopDailySummary(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Exposed for tests — runs one tick synchronously and returns. */
export async function _tickForTest(): Promise<void> {
  await runTick();
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
  const workgroups = groupByWorkgroup(getAllAgentGroups());
  let sentCount = 0;

  for (const [workgroupId, members] of workgroups) {
    try {
      // Poster = the workgroup's Codex sibling. The digest posts AS this bot,
      // and its container.json carries the opt-in + destination override.
      // Identify by the effective provider (container_configs/container.json),
      // not the deprecated agent_groups.agent_provider column.
      const poster = members.find((m) => readContainerConfig(m.folder).provider === 'codex');
      if (!poster) continue; // no Codex sibling → workgroup not eligible

      const target = resolveTarget(poster);
      if (!target) continue; // no dailySummary override → workgroup opted out

      const summary = buildSummary(members, since);
      if (isEmpty(summary)) continue;

      const dailySummaryConfig = readContainerConfig(poster.folder).dailySummary;
      const includeShipLog = dailySummaryConfig?.shipLog !== false;
      const includeResolved = dailySummaryConfig?.resolved !== false;
      const includeBacklog = dailySummaryConfig?.backlog !== false;
      const { parent, backlogThread } = formatDigestParts(workgroupId, summary, {
        includeShipLog,
        includeResolved,
        includeBacklog,
      });
      // isEmpty() above tests the DATA; the include* flags can still strip every
      // section from a non-empty summary (illysium runs all three off now that
      // its board lives in Linear + the canvas). Posting the bare "📋 Daily
      // Summary" header every morning is worse than posting nothing.
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
        // Long backlog lists live in the parent's thread so the channel
        // shows one compact line. Thread id shape matches the router's
        // (`<platform_id>:<message ts>` — see slack.ts targets). No message
        // id (platform can't thread) → second channel message instead.
        const threadId = parentId ? `${target.platform_id}:${parentId}` : null;
        const sendThread = () =>
          adapter.deliver(
            target.channel_type,
            target.platform_id,
            threadId,
            'chat',
            JSON.stringify({ text: backlogThread }),
          );
        try {
          await sendThread();
        } catch (firstErr) {
          // The parent already posted, so the day is marked complete either
          // way — one retry, then a loud error, is the whole recovery
          // budget: re-running the tick would double-post every parent.
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

/** Bucket agent groups by workgroup. Standalone groups (no workgroup_id) key
 *  on their folder so they form a single-member workgroup of their own. */
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

/**
 * Aggregate one workgroup's activity across all sibling agent groups, dedupe,
 * and split shipped work by source. ship_log + backlog are per-agent-group, and
 * commit-scan can write the same default-branch commit into more than one
 * sibling's ship_log (siblings share repos via the workgroup symlink overlay),
 * so dedupe is load-bearing, not cosmetic.
 */
function buildSummary(members: AgentGroup[], since: string): Summary {
  const shipped: ShipLogEntry[] = [];
  const resolved: BacklogItem[] = [];
  const openBacklog: BacklogItem[] = [];
  for (const m of members) {
    shipped.push(...getShipLogSince(m.id, since));
    resolved.push(...getBacklogResolvedSince(m.id, since));
    openBacklog.push(...getBacklog(m.id, 'in_progress'), ...getBacklog(m.id, 'open'));
  }

  const dedupedShipped = dedupeBy(shipped, (e) => e.pr_url || `${e.title} ${e.shipped_at}`);
  const dedupedResolved = dedupeBy(resolved, (i) => i.id);
  const dedupedOpen = dedupeBy(openBacklog, (i) => i.id);

  return {
    agentShipped: dedupedShipped.filter((e) => !isCommitScanEntry(e)),
    otherCommits: dedupedShipped.filter((e) => isCommitScanEntry(e)),
    resolved: dedupedResolved,
    openBacklog: dedupedOpen,
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

/**
 * A ship_log entry is non-agent ("Other commits") iff it came from commit-scan,
 * which tags entries `commit-digest,<repo>` (comma-separated string) — older
 * rows may use a JSON array. Anything else is agent-recorded via add_ship_log.
 */
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

/**
 * Resolve the destination channel for a workgroup's digest from its Codex
 * poster's container.json `dailySummary.messagingGroupId`. Presence of this
 * override is the opt-in signal — absence returns null and the workgroup is
 * skipped. A set-but-unresolvable id also returns null (with a warning) rather
 * than silently falling back to a different channel, since the override is the
 * deliberate routing choice (Discord vs Slack).
 */
function resolveTarget(poster: AgentGroup): MessagingGroup | null {
  const config = readContainerConfig(poster.folder);
  const overrideId = config.dailySummary?.messagingGroupId;
  if (!overrideId) return null;
  const mg = getMessagingGroup(overrideId);
  if (mg) return mg;
  log.warn('Daily summary: dailySummary.messagingGroupId not found — skipping workgroup', {
    posterAgentGroupId: poster.id,
    overrideId,
  });
  return null;
}

// ── Formatting ──

/**
 * Build the digest as a compact parent message plus an optional threaded
 * backlog list. The open-backlog list grows with ship rate — tens of lines in
 * the parent channel reads as spam, so the parent carries one headline and
 * the ranked list lives in the thread.
 */
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
      lines.push(`${emoji} ${item.title}`);
    }
  }

  let backlogThread: string | null = null;
  if (opts.includeBacklog !== false && s.openBacklog.length > 0) {
    lines.push('', `📌 **Open Backlog** (${s.openBacklog.length}) — ranked list in 🧵`);
    backlogThread = formatBacklogThread(s.openBacklog);
  }

  return { parent: lines.join('\n'), backlogThread };
}

/** Back-compat single-message render (parent + list inline). */
export function formatDigest(label: string, s: Summary): string {
  const { parent, backlogThread } = formatDigestParts(label, s);
  return backlogThread ? `${parent}\n${backlogThread}` : parent;
}

/**
 * Ranked open-backlog render. Order = what to address first:
 * in-progress before untouched, then priority high→low, then oldest first
 * (age is the tiebreak signal that something keeps not getting done).
 * Each item shows its age and, when the item carries a description, the
 * why/purpose on an indented line — items without one show nothing extra
 * (the steward task backfills descriptions over time).
 */
export function formatBacklogThread(items: BacklogItem[]): string {
  const ranked = rankBacklog(items);
  const top = ranked.slice(0, 3);
  const lines: string[] = ['📌 **Open Backlog — ranked**', ''];
  if (top.length > 0) {
    lines.push(`👉 **Address first:** ${top.map((i) => truncate(i.title, 60)).join(' · ')}`, '');
  }
  for (const item of ranked) {
    const pri = item.priority === 'high' ? '🔴' : item.priority === 'medium' ? '🟡' : '⚪';
    const suffix = item.status === 'in_progress' ? ' · in progress' : '';
    lines.push(`${pri} ${item.title} · ${ageDays(item.created_at)}d${suffix}`);
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

/**
 * Append a shipped-work section grouped by repo. No-op when empty so the
 * caller doesn't emit a bare header. Per-repo sub-headers appear only when the
 * section spans more than one repo (matches the prior single-section format).
 */
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

/**
 * Repo extraction priority — direct port of v1's logic:
 *   1. Parse owner/repo from a github.com/.../pull|issues URL in pr_url.
 *   2. If tags include 'commit-digest', use the other tag (commit-scan
 *      writes `commit-digest,<repoName>` per scanRepo).
 *   3. Title prefix before ':' if it appears in the first 40 chars.
 *   4. 'Other'.
 */
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

// ── TZ helpers ──

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

// ── State file ──

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
