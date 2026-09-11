/**
 * Container copy of the checkout-layout primitive (plan §5.1,
 * docs/specs/repository-branch-clones/plan.md).
 *
 * `worktrees/<repo>` is a thread's primary checkout and `worktrees/<repo>@<slug>`
 * any other branch's; `@` is outside the repository-name charset, so names
 * parse unambiguously. Duplicated on purpose from the host copy,
 * `src/repository-workspaces.ts`, the same way
 * `container/agent-runner/src/managed-git-command-guard.ts` duplicates its
 * host counterpart. Both copies are pinned by the shared vector file beside
 * this one, `checkout-layout.fixtures.json` — read by both test suites.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHECKOUT_SLUG = /^[A-Za-z0-9._-]+$/;
const CHECKOUT_SLUG_MAX_CHARS = 80;

export type CheckoutShape = 'clone' | 'linked' | 'unknown';

export interface TopicCheckout {
  name: string;
  repo: string;
  slug: string | null;
  path: string;
  shape: CheckoutShape;
}

/**
 * `<repo>` for no branch, else `<repo>@<slug>`. A lossy slug carries the
 * branch's hash, so `feat/x` and `feat-x` never collide.
 */
export function checkoutDirName(repo: string, branch: string | null): string {
  if (branch === null) return repo;
  let slug = branch
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, CHECKOUT_SLUG_MAX_CHARS);
  if (slug !== branch) slug += `-${createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 8)}`;
  return `${repo}@${slug}`;
}

/** `{repo, slug}` for a checkout dir name; `null` for anything else, every dot-prefixed name included. */
export function parseCheckoutDirName(name: string): { repo: string; slug: string | null } | null {
  if (name.startsWith('.')) return null;
  const at = name.indexOf('@');
  const repo = at === -1 ? name : name.slice(0, at);
  if (!SAFE_SEGMENT.test(repo)) return null;
  if (at === -1) return { repo, slug: null };
  const slug = name.slice(at + 1);
  return CHECKOUT_SLUG.test(slug) ? { repo, slug } : null;
}

/** The shape a `.git` entry gives its checkout: a directory is a clone, a file a linked worktree, anything else (including missing) `unknown`. */
export function checkoutShapeAt(checkoutPath: string): CheckoutShape {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.join(checkoutPath, '.git'));
  } catch {
    return 'unknown';
  }
  if (stat.isDirectory()) return 'clone';
  return stat.isFile() ? 'linked' : 'unknown';
}

/**
 * The only enumerator of a topic's checkouts: directories whose names parse,
 * each with the shape its `.git` gives it. A missing topic dir has none; any
 * other read failure throws, so no caller can mistake "unreadable" for
 * "empty".
 */
export function listTopicCheckouts(topicWorktreesDir: string): TopicCheckout[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(topicWorktreesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const checkouts: TopicCheckout[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseCheckoutDirName(entry.name);
    if (!parsed) continue;
    const checkoutPath = path.join(topicWorktreesDir, entry.name);
    checkouts.push({ name: entry.name, ...parsed, path: checkoutPath, shape: checkoutShapeAt(checkoutPath) });
  }
  return checkouts.sort((a, b) => a.name.localeCompare(b.name));
}
