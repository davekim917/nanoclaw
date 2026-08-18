/**
 * Read path for `GET /dashboard/api/observatory/issue-brief`.
 *
 * The Decisions view names an ask in one line, but a person deciding usually
 * needs what the ISSUE says — the body QA wrote, the labels, and the latest
 * comments (which is where a proposed default and its do-by live). This
 * fetches that live from GitHub when a row is expanded, so the board itself
 * stays light and never goes stale between watcher runs.
 *
 * Security shape matches assign/steer: the client sends ids only. The URL
 * fetched is read out of the workgroup's own release-state.json and must
 * parse as a github.com issue/PR path — the browser can pick which item,
 * never which host gets called.
 */
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { readReleaseState } from './api/observatory.js';
import type { AuthHandler } from './router.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export interface IssueBrief {
  state: string;
  labels: string[];
  /** Issue/PR body, truncated server-side. */
  body: string;
  bodyTruncated: boolean;
  comments: { author: string; at: string; body: string }[];
  commentCount: number;
  fetchedAt: string;
}

const BODY_CAP = 2000;
const COMMENT_CAP = 1000;
const COMMENTS_SHOWN = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const cache = new Map<string, { at: number; brief: IssueBrief }>();

/** Test-only. */
export function _resetIssueBriefCacheForTesting(): void {
  cache.clear();
}

/** Mirror of capabilities.ts resolveScopedEnvVar — deliberate duplication, same as there. */
function githubTokenFor(workgroupId: string): string | null {
  const folders = getDb().prepare('SELECT folder FROM agent_groups WHERE workgroup_id = ?').all(workgroupId) as {
    folder: string;
  }[];
  for (const { folder } of folders) {
    const conv = `GITHUB_TOKEN_${folder.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[conv]) return process.env[conv]!;
  }
  return process.env.GITHUB_TOKEN ?? null;
}

const truncate = (s: string, cap: number): { text: string; truncated: boolean } =>
  s.length > cap ? { text: s.slice(0, cap), truncated: true } : { text: s, truncated: false };

async function gh(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nanoclaw-observatory',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`github ${res.status} on ${path}`);
  return res.json();
}

export const observatoryIssueBriefHandler: AuthHandler = async (req, _params, _ctx) => {
  const url = new URL(req.url);
  const workgroupId = url.searchParams.get('workgroup');
  const itemId = url.searchParams.get('item');
  if (!workgroupId || !itemId) return json(400, { error: 'workgroup and item are required' });

  const state = readReleaseState(workgroupId);
  const item = state?.items.find((i) => i.id === itemId);
  if (!item) return json(404, { error: 'item_not_on_board' });
  if (!item.url) return json(404, { error: 'item_has_no_url' });

  // Only ever call api.github.com, with pieces parsed from the recorded URL.
  const m = item.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?:[/#?].*)?$/);
  if (!m) return json(404, { error: 'item_url_not_github' });
  const [, owner, repo, num] = m;

  const cacheKey = `${workgroupId}:${itemId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return json(200, hit.brief);

  const token = githubTokenFor(workgroupId);
  if (!token) return json(502, { error: 'no_github_token' });

  try {
    // The issues endpoint serves PRs too (body/labels/state are shared).
    const issue = (await gh(`/repos/${owner}/${repo}/issues/${num}`, token)) as {
      state: string;
      body: string | null;
      labels: ({ name?: string } | string)[];
      comments: number;
    };
    const comments = (await gh(`/repos/${owner}/${repo}/issues/${num}/comments?per_page=100`, token)) as {
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }[];

    const body = truncate(issue.body ?? '', BODY_CAP);
    const brief: IssueBrief = {
      state: issue.state,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      body: body.text,
      bodyTruncated: body.truncated,
      comments: comments.slice(-COMMENTS_SHOWN).map((c) => ({
        author: c.user?.login ?? 'unknown',
        at: c.created_at,
        body: truncate(c.body ?? '', COMMENT_CAP).text,
      })),
      commentCount: issue.comments,
      fetchedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { at: Date.now(), brief });
    return json(200, brief);
  } catch (err) {
    log.warn('issue-brief fetch failed', { itemId, error: String(err) });
    return json(502, { error: 'github_fetch_failed' });
  }
};
