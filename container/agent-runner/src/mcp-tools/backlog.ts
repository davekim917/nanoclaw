/**
 * Backlog + ship-log MCP tools.
 *
 * Write operations (add_ship_log, add/update/delete_backlog_item) are sent
 * as system-kind outbound messages — the host applies them to the central DB
 * via delivery actions.
 *
 * Read operations (list_backlog, get_activity_summary) read directly from
 * /workspace/central.db (mounted read-only).
 *
 * scan_commits runs git log locally and sends the result as a ship_log entry.
 */
import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getCentralDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';


function log(msg: string): void {
  console.error(`[backlog] ${msg}`);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function routing() {
  return getSessionRouting();
}

function getAgentGroupId(): string | null {
  return process.env.NANOCLAW_AGENT_GROUP_ID ?? null;
}

function sendAction(action: string, data: Record<string, unknown>): void {
  const r = routing();
  const id = generateId('sys');
  writeMessageOut({
    id,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, ...data }),
  });
}

// ---- Types matching host-side db/backlog.ts ----

interface ShipLogEntry {
  id: string;
  agent_group_id: string;
  title: string;
  description: string | null;
  pr_url: string | null;
  branch: string | null;
  tags: string | null;
  shipped_at: string;
}

interface BacklogItem {
  id: string;
  agent_group_id: string;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'wont_fix';
  priority: 'low' | 'medium' | 'high';
  tags: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

// ---- Tool definitions ----

export const addShipLog: McpToolDefinition = {
  tool: {
    name: 'add_ship_log',
    description: 'Record a shipped feature, fix, or change in the ship log.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Brief title for what was shipped' },
        description: { type: 'string', description: 'Detailed description (optional)' },
        pr_url: { type: 'string', description: 'Pull request URL (optional)' },
        branch: { type: 'string', description: 'Branch name that was shipped (optional)' },
        tags: { type: 'string', description: 'Comma-separated tags (optional)' },
      },
      required: ['title'],
    },
  },
  handler: async (args) => {
    const agentGroupId = getAgentGroupId();
    if (!agentGroupId) return err('No agent group ID — container not properly initialized');
    if (!args.title) return err('title is required');

    sendAction('add_ship_log', {
      id: generateId('ship'),
      title: args.title,
      description: args.description ?? null,
      pr_url: args.pr_url ?? null,
      branch: args.branch ?? null,
      tags: typeof args.tags === 'string' ? args.tags : null,
      shipped_at: new Date().toISOString(),
    });

    log(`add_ship_log: ${args.title}`);
    return ok(`Ship log entry recorded: "${args.title}"`);
  },
};

export const addBacklogItem: McpToolDefinition = {
  tool: {
    name: 'add_backlog_item',
    description: 'Add an item to the backlog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Brief title for the backlog item' },
        description: { type: 'string', description: 'Detailed description (optional)' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'resolved', 'wont_fix'],
          description: 'Initial status. Default: open',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Priority. Default: medium',
        },
        tags: { type: 'string', description: 'Comma-separated tags (optional)' },
        notes: { type: 'string', description: 'Internal notes (optional)' },
      },
      required: ['title'],
    },
  },
  handler: async (args) => {
    if (!args.title) return err('title is required');

    sendAction('add_backlog_item', {
      id: generateId('backlog'),
      title: args.title,
      description: args.description ?? null,
      status: args.status ?? 'open',
      priority: args.priority ?? 'medium',
      tags: typeof args.tags === 'string' ? args.tags : null,
      notes: args.notes ?? null,
    });

    log(`add_backlog_item: ${args.title}`);
    return ok(`Backlog item added: "${args.title}" [${args.status ?? 'open'}, ${args.priority ?? 'medium'}]`);
  },
};

export const updateBacklogItem: McpToolDefinition = {
  tool: {
    name: 'update_backlog_item',
    description: 'Update a backlog item. Pass the itemId from list_backlog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        itemId: { type: 'string', description: 'Backlog item ID to update' },
        title: { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'resolved', 'wont_fix'],
          description: 'New status (optional)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'New priority (optional)',
        },
        tags: { type: 'string', description: 'New comma-separated tags (optional)' },
        notes: { type: 'string', description: 'New notes (optional)' },
      },
      required: ['itemId'],
    },
  },
  handler: async (args) => {
    if (!args.itemId) return err('itemId is required');

    const updates: Record<string, unknown> = { itemId: args.itemId };
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.status !== undefined) updates.status = args.status;
    if (args.priority !== undefined) updates.priority = args.priority;
    if (args.tags !== undefined) updates.tags = args.tags;
    if (args.notes !== undefined) updates.notes = args.notes;

    sendAction('update_backlog_item', updates);

    log(`update_backlog_item: ${args.itemId}`);
    return ok(`Backlog item ${args.itemId} update requested.`);
  },
};

export const deleteBacklogItem: McpToolDefinition = {
  tool: {
    name: 'delete_backlog_item',
    description: 'Delete a backlog item.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        itemId: { type: 'string', description: 'Backlog item ID to delete' },
      },
      required: ['itemId'],
    },
  },
  handler: async (args) => {
    if (!args.itemId) return err('itemId is required');

    sendAction('delete_backlog_item', { itemId: args.itemId });

    log(`delete_backlog_item: ${args.itemId}`);
    return ok(`Backlog item ${args.itemId} deletion requested.`);
  },
};

export const listBacklog: McpToolDefinition = {
  tool: {
    name: 'list_backlog',
    description: 'List backlog items for the current agent group. Optionally filter by status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'resolved', 'wont_fix'],
          description: 'Filter by status. Default: all statuses',
        },
        limit: {
          type: 'number',
          description: 'Max items to return. Default: 50. Max: 200',
        },
      },
    },
  },
  handler: async (args) => {
    const agentGroupId = getAgentGroupId();
    if (!agentGroupId) return err('No agent group ID');

    const db = getCentralDb();
    if (!db) return err('Central DB not available');

    const limit = Math.min(args.limit as number ?? 50, 200);
    const status = args.status as string | undefined;

    let rows: BacklogItem[];
    if (status) {
      rows = db
        .prepare(
          `SELECT * FROM backlog_items
             WHERE agent_group_id = ? AND status = ?
             ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT ?`,
        )
        .all(agentGroupId, status, limit) as BacklogItem[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM backlog_items
             WHERE agent_group_id = ?
             ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT ?`,
        )
        .all(agentGroupId, limit) as BacklogItem[];
    }

    if (rows.length === 0) return ok('No backlog items.');

    const lines = rows.map((item) => {
      const tags = item.tags ? ` [${item.tags}]` : '';
      const notes = item.notes ? `\n  ↳ ${item.notes}` : '';
      return `${item.id} | ${item.priority} | ${item.status} | ${item.title}${tags}${notes}`;
    });
    return ok(`Backlog (${rows.length} items):\n${lines.join('\n')}`);
  },
};

export const getActivitySummary: McpToolDefinition = {
  tool: {
    name: 'get_activity_summary',
    description:
      'Get activity summary: recent ship log entries, backlog counts by status, recently completed items.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'Days of ship log history to include. Default: 7',
        },
      },
    },
  },
  handler: async (args) => {
    const agentGroupId = getAgentGroupId();
    if (!agentGroupId) return err('No agent group ID');

    const db = getCentralDb();
    if (!db) return err('Central DB not available');

    const days = (args.days as number) ?? 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Backlog counts
    const counts = db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM backlog_items WHERE agent_group_id = ? GROUP BY status`,
      )
      .all(agentGroupId) as Array<{ status: string; c: number }>;
    const countByStatus = Object.fromEntries(counts.map((r) => [r.status, r.c]));
    const totalBacklog = counts.reduce((s, r) => s + r.c, 0);

    // Recent ship log
    const shipLog = db
      .prepare(
        `SELECT * FROM ship_log WHERE agent_group_id = ? AND shipped_at >= ? ORDER BY shipped_at DESC LIMIT 20`,
      )
      .all(agentGroupId, since) as ShipLogEntry[];

    // Recently resolved
    const resolved = db
      .prepare(
        `SELECT * FROM backlog_items WHERE agent_group_id = ? AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 10`,
      )
      .all(agentGroupId, since) as BacklogItem[];

    const countLines = ['open', 'in_progress', 'resolved', 'wont_fix']
      .map((s) => `  ${s}: ${countByStatus[s] ?? 0}`)
      .join('\n');

    const shipLines =
      shipLog.length > 0
        ? shipLog
            .map((e) => {
              const d = new Date(e.shipped_at).toLocaleDateString();
              return `  ${d} | ${e.title}`;
            })
            .join('\n')
        : '  (none)';

    const resolvedLines =
      resolved.length > 0
        ? resolved
            .map((e) => {
              const d = new Date(e.resolved_at!).toLocaleDateString();
              return `  ${d} | ${e.title} [${e.status}]`;
            })
            .join('\n')
        : '  (none)';

    return ok(
      `Activity summary (last ${days}d)\n\n` +
        `Backlog (${totalBacklog} total):\n${countLines}\n\n` +
        `Shipped (last ${days}d):\n${shipLines}\n\n` +
        `Completed (last ${days}d):\n${resolvedLines}`,
    );
  },
};

export const scanCommits: McpToolDefinition = {
  tool: {
    name: 'scan_commits',
    description:
      'Scan git repos in the current workspace for new commits and create ship log entries. ' +
      'Discovers repos by checking /workspace/agent and its immediate subdirectories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repoPath: {
          type: 'string',
          description: 'Specific repo path to scan. Default: auto-discover all repos under /workspace/agent',
        },
      },
    },
  },
  handler: async (args) => {
    const agentGroupId = getAgentGroupId();
    if (!agentGroupId) return err('No agent group ID');

    const root = '/workspace/agent';
    let repos: string[];

    if (args.repoPath) {
      if (!isGitRepo(args.repoPath as string)) return err(`Not a git repo: ${args.repoPath}`);
      repos = [args.repoPath as string];
    } else {
      repos = discoverRepos(root);
    }

    if (repos.length === 0) return ok('No git repos found.');

    const results: string[] = [];
    let totalCommits = 0;

    for (const repoDir of repos) {
      const repoName = path.basename(repoDir);
      const scanned = await scanRepo(repoDir, agentGroupId);
      results.push(`  ${repoName}: ${scanned} new commits`);
      totalCommits += scanned;
    }

    log(`scan_commits: ${totalCommits} commits across ${repos.length} repos`);
    return ok(`Commit scan complete (${repos.length} repos, ${totalCommits} new commits):\n${results.join('\n')}`);
  },
};

function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function discoverRepos(root: string): string[] {
  const repos: string[] = [];
  try {
    if (isGitRepo(root)) repos.push(root);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = path.join(root, entry.name);
        if (isGitRepo(subDir)) repos.push(subDir);
      }
    }
  } catch {
    // Root doesn't exist or is unreadable
  }
  return repos;
}

async function scanRepo(repoDir: string, agentGroupId: string): Promise<number> {
  const defaultBranch = getDefaultBranch(repoDir);
  if (!defaultBranch) return 0;

  const latestSha = getLatestCommitSha(repoDir, defaultBranch);
  if (!latestSha) return 0;

  const db = getCentralDb();
  if (!db) return 0;

  // Get last scanned SHA for this repo
  let lastSha: string | null = null;
  try {
    const state = db
      .prepare('SELECT last_commit_sha FROM commit_digest_state WHERE repo_path = ?')
      .get(repoDir) as { last_commit_sha: string } | undefined;
    lastSha = state?.last_commit_sha ?? null;
  } catch {
    lastSha = null;
  }

  if (lastSha === latestSha) return 0;

  let commits: CommitInfo[];
  if (lastSha) {
    commits = getDirectCommitsSince(repoDir, defaultBranch, lastSha);
  } else {
    // First scan: last 24h of commits (capped at 100)
    commits = getRecentCommits(repoDir, defaultBranch, 100);
  }

  // Update digest state
  upsertDigestState(db, repoDir, agentGroupId, latestSha);
  if (commits.length === 0) return 0;

  const repoName = path.basename(repoDir);
  const commitCount = commits.length;
  const title =
    commitCount === 1
      ? `${repoName}: ${commits[0].subject}`
      : `${repoName}: ${commitCount} direct commits to ${defaultBranch}`;

  const description = commits
    .map((c) => `• \`${c.shortSha}\` ${c.subject} (${c.authorName})`)
    .join('\n');

  sendAction('add_ship_log', {
    id: generateId('ship'),
    title,
    description,
    pr_url: null,
    branch: defaultBranch,
    tags: `commit-digest,${repoName}`,
    shipped_at: new Date().toISOString(),
  });

  log(`scan_repo ${repoName}: ${commitCount} commits`);
  return commitCount;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  date: string;
}

function parseCommitLine(line: string): CommitInfo {
  const [sha, shortSha, subject, authorName, date] = line.split('\0');
  return { sha, shortSha, subject, authorName, date };
}

function getDefaultBranch(repoDir: string): string | null {
  try {
    const stdout = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).toString();
    const ref = stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // Fallback: check common branch names
    for (const branch of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
          cwd: repoDir,
          encoding: 'utf-8',
          timeout: 5000,
        });
        return branch;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function getLatestCommitSha(repoDir: string, branch: string): string | null {
  try {
    const stdout = execFileSync('git', ['rev-parse', branch], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).toString();
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function getDirectCommitsSince(repoDir: string, branch: string, sinceSha: string): CommitInfo[] {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '--no-merges', '--first-parent', '--format=%H%x00%h%x00%s%x00%an%x00%aI', `${sinceSha}..${branch}`],
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000 },
    ).toString();
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').map(parseCommitLine).reverse();
  } catch {
    return [];
  }
}

function getRecentCommits(repoDir: string, branch: string, limit: number): CommitInfo[] {
  try {
    const stdout = execFileSync(
      'git',
      [
        'log',
        '--no-merges',
        '--first-parent',
        '-n',
        String(limit),
        '--format=%H%x00%h%x00%s%x00%an%x00%aI',
        '--since=24 hours ago',
        branch,
      ],
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000 },
    ).toString();
    if (!stdout.trim()) return [];
    return stdout.trim().split('\n').map(parseCommitLine).reverse();
  } catch {
    return [];
  }
}

function upsertDigestState(db: Database, repoPath: string, agentGroupId: string, lastSha: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO commit_digest_state (repo_path, agent_group_id, last_commit_sha, last_scan)
     VALUES (?, ?, ?, ?)`,
  ).run(repoPath, agentGroupId, lastSha, new Date().toISOString());
}

registerTools([addShipLog, addBacklogItem, updateBacklogItem, deleteBacklogItem, listBacklog, getActivitySummary, scanCommits]);
