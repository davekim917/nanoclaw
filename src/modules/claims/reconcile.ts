/**
 * Clears claims whose referenced work has verifiably landed on GitHub (never
 * inferred from a timestamp or taken on assertion). Clearing means DELETING the
 * file after appending to `claims/ledger.ndjson`, in claim.sh's shape and under
 * its lock. Fail-closed everywhere: a wrongly open claim costs a glance, a
 * wrongly deleted one destroys the only record anyone was on the work.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { SELF_HEAL_ENABLED } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { resolveGitHubAppToken } from '../../github-app-token.js';
import { log } from '../../log.js';
import { claimsBaseDir } from './escalation.js';

/** Deliberately not the 60s host sweep. */
const RECONCILE_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** A hung GitHub call must not hold up the rest of the sweep. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** Names the mechanism, never a person. */
export const RECONCILE_LEDGER_ACTOR = 'host-claims-reconcile';

/** Issues and pull requests share one numbering sequence. */
export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
}

/** `absent` (404: nonexistent or not visible to our token) is no evidence either way. */
export type RefState = 'merged' | 'open' | 'closed' | 'absent';

export interface RefLookup {
  state: RefState;
  mergedAt?: string;
}

export function refKey(ref: GitHubRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Below this many digits an INFERRED number is noise (`team-pr<n>-01-…` must
 * not probe number 1). Explicit `org/repo#n` and pull URLs are exempt.
 */
const MIN_INFERRED_REF_DIGITS = 2;

function pushRef(
  out: Map<string, GitHubRef>,
  owner: string | undefined,
  repo: string | undefined,
  digits: string,
  explicit = false,
): void {
  if (!owner || !repo) return; // bare number with no repository to resolve it against
  if (!explicit && (digits.length < MIN_INFERRED_REF_DIGITS || digits.startsWith('0'))) return;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0) return;
  const ref = { owner, repo, number };
  out.set(refKey(ref), ref);
}

const PULL_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g;
/** `owner/repo#<n>`. The lookbehind stops it matching the tail of a URL or a path. */
const QUALIFIED = /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)/g;

/**
 * Every GitHub number from the slug AND the note (a slug's number may not be
 * the one that finishes the work). An explicitly qualified reference always
 * wins over `defaultRepo`; with no default, bare numbers yield nothing.
 */
export function parseGitHubRefs(slug: string, note: string, defaultRepo?: string): GitHubRef[] {
  const refs = new Map<string, GitHubRef>();
  const [defOwner, defRepo] = (defaultRepo ?? '').split('/');

  for (const m of note.matchAll(PULL_URL)) pushRef(refs, m[1], m[2], m[3], true);
  for (const m of note.matchAll(QUALIFIED)) pushRef(refs, m[1], m[2], m[3], true);

  // Bare `#n` over a note with qualified forms blanked, so `otherorg/repo#<n>`
  // cannot also register against the default repo.
  const bare = note.replace(PULL_URL, ' ').replace(QUALIFIED, ' ');
  for (const m of bare.matchAll(/#(\d+)/g)) pushRef(refs, defOwner, defRepo, m[1]);

  // Slug numbers, deliberately NARROW (glued to gh/pr, leading, or after a
  // gh/pr token): a deeper number is part of the name, and once the repo
  // reaches that number it would silently clear a live claim.
  const tokens = slug.split('-');
  tokens.forEach((token, i) => {
    const glued = /^(?:gh|pr)(\d+)$/i.exec(token);
    if (glued) return pushRef(refs, defOwner, defRepo, glued[1]);
    if (!/^\d+$/.test(token)) return;
    if (i <= 1 || /^(?:gh|pr)$/i.test(tokens[i - 1] ?? '')) pushRef(refs, defOwner, defRepo, token);
  });
  return [...refs.values()];
}

/**
 * Any OPEN reference keeps the claim; no merge keeps it (a closed-unmerged PR
 * is not shipped work, and age is never evidence); a merge with nothing open
 * clears. The OPEN rule is load-bearing: notes cite merged PRs as context for
 * why work is stuck, and a human reopening the issue is what says "not done".
 * Not "every reference merged": claims can cite a never-to-merge PR.
 */
export function decideReconcile(states: RefState[]): 'clear' | 'keep' {
  if (states.includes('open')) return 'keep';
  return states.includes('merged') ? 'clear' : 'keep';
}

/**
 * Byte-compatible with `claim.sh`'s `ledger_append` (key order, elisions,
 * `pr` as a NUMBER): two writers, one reader.
 */
export function ledgerLine(entry: {
  event: string;
  slug: string;
  owner: string;
  by: string;
  at: string;
  claimedAt?: string;
  threadId?: string;
  pr?: number;
  note: string;
}): string {
  const row: Record<string, unknown> = {
    event: entry.event,
    slug: entry.slug,
    owner: entry.owner,
    by: entry.by,
    at: entry.at,
  };
  if (entry.claimedAt) row.claimed_at = entry.claimedAt;
  if (entry.threadId) row.thread_id = entry.threadId;
  if (entry.pr !== undefined) row.pr = entry.pr;
  row.note = entry.note;
  return JSON.stringify(row);
}

/**
 * Same `flock` on the same `.ledger.lock` as `claim.sh` (one host inode via the
 * bind mount). Throws without util-linux `flock`, which is correct: the caller
 * appends BEFORE deleting.
 */
function appendLedger(claimsDir: string, line: string): void {
  execFileSync(
    'flock',
    ['-x', path.join(claimsDir, '.ledger.lock'), 'tee', '-a', path.join(claimsDir, 'ledger.ndjson')],
    { input: `${line}\n`, stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

/**
 * Terminal answers only. `absent` is cached because a number that starts
 * existing later would be unrelated work, exactly the collision to avoid.
 * `open`/`closed` can still change and are never cached.
 */
const terminalLookups = new Map<string, RefLookup>();

/** The cache and throttle are process-global. */
export function _resetReconcileStateForTesting(): void {
  terminalLookups.clear();
  lastRanAtMs = 0;
}

const APP_ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN'];

/**
 * App first, then a PAT; `.env` merged UNDER `process.env`. `undefined` means
 * no host GitHub identity, and reconciliation is a no-op.
 */
async function resolveToken(): Promise<string | undefined> {
  const env = { ...readEnvFile(APP_ENV_KEYS), ...process.env };
  // Checked first: resolveGitHubAppToken WARNs on incomplete config every scan.
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const minted = await resolveGitHubAppToken(env);
    if (minted) return minted;
  }
  const pat = env.GITHUB_TOKEN;
  return pat && pat !== 'app:github' ? pat : undefined;
}

/**
 * `/issues/{n}` answers for PRs too and is the only endpoint that shows a
 * REOPENED issue. Throws on any non-definitive answer.
 */
async function githubLookup(ref: GitHubRef, token: string): Promise<RefLookup> {
  const res = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (res.status === 404) return { state: 'absent' };
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${refKey(ref)}`);
  const body = (await res.json()) as { state?: unknown; pull_request?: { merged_at?: unknown } };
  const mergedAt = body.pull_request?.merged_at;
  if (typeof mergedAt === 'string' && mergedAt) return { state: 'merged', mergedAt };
  return { state: body.state === 'open' ? 'open' : 'closed' };
}

/**
 * `CLAIMS_PR_REPO_<WORKGROUP>` then `CLAIMS_PR_REPO`. Deliberately no inference:
 * numbers collide densely across a workgroup's repos, so guessing would clear a
 * claim on an unrelated repo's same-numbered PR.
 */
function defaultRepoFor(workgroupId: string): string | undefined {
  const scoped = `CLAIMS_PR_REPO_${workgroupId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const env = { ...readEnvFile([scoped, 'CLAIMS_PR_REPO']), ...process.env };
  const value = env[scoped] ?? env.CLAIMS_PR_REPO;
  return value && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined;
}

export interface ReconcileDeps {
  /** Supplying it also disables the scan throttle. */
  root?: string;
  /** Resolve one reference. MUST throw on any non-answer so the claim is left alone. */
  lookup?: (ref: GitHubRef) => Promise<RefLookup>;
  defaultRepo?: (workgroupId: string) => string | undefined;
  enabled?: boolean;
}

export interface ReconcileOutcome {
  workgroupId: string;
  slug: string;
  action: 'cleared' | 'kept';
  reason: string;
  applied: boolean;
  pr?: number;
}

function listWorkgroupDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

let lastRanAtMs = 0;

function shouldSkipReconcileScan(lastRan: number, now: number): boolean {
  return now - lastRan < RECONCILE_SCAN_INTERVAL_MS;
}

/**
 * Runs BEFORE the self-heal ladder: done work is closed, never escalated.
 * Throttled to 10 min, and terminal answers are cached for the process.
 */
export async function reconcileMergedClaims(
  now: number = Date.now(),
  deps: ReconcileDeps = {},
): Promise<ReconcileOutcome[]> {
  if (deps.root === undefined && shouldSkipReconcileScan(lastRanAtMs, now)) return [];
  if (deps.root === undefined) lastRanAtMs = now;

  const root = deps.root ?? claimsBaseDir();
  const enabled = deps.enabled ?? SELF_HEAL_ENABLED;
  const defaultRepo = deps.defaultRepo ?? defaultRepoFor;

  let lookup = deps.lookup;
  if (!lookup) {
    const token = await resolveToken();
    if (!token) return [];
    lookup = (ref) => githubLookup(ref, token);
  }

  const outcomes: ReconcileOutcome[] = [];
  for (const workgroupId of listWorkgroupDirs(root)) {
    const claimsDir = path.join(root, workgroupId, 'claims');
    let entries: string[];
    try {
      entries = fs.readdirSync(claimsDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    } catch {
      continue; // no claims directory — shared FS off, or nothing ever claimed
    }
    const repo = defaultRepo(workgroupId);

    for (const entry of entries) {
      const file = path.join(claimsDir, entry);
      const slug = entry.replace(/\.json$/, '');
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        log.warn('claims reconcile: unparseable claim, skipping', { file, err });
        continue;
      }

      const note = typeof raw.note === 'string' ? raw.note : '';
      const refs = parseGitHubRefs(slug, note, repo);
      if (refs.length === 0) continue;

      const states: RefState[] = [];
      let merged: { number: number; mergedAt?: string } | undefined;
      try {
        for (const ref of refs) {
          const cached = terminalLookups.get(refKey(ref));
          const result = cached ?? (await lookup(ref));
          if (!cached && (result.state === 'merged' || result.state === 'absent')) {
            terminalLookups.set(refKey(ref), result);
          }
          states.push(result.state);
          // The PR that closed the claim: the most recently merged.
          if (result.state === 'merged' && (!merged || (result.mergedAt ?? '') > (merged.mergedAt ?? ''))) {
            merged = { number: ref.number, mergedAt: result.mergedAt };
          }
        }
      } catch (err) {
        // Never delete on a failed lookup: an outage must not empty the board.
        log.warn('claims reconcile: lookup failed, leaving claim in place', { workgroupId, slug, err });
        continue;
      }

      if (decideReconcile(states) === 'keep' || !merged) continue;

      const base = { workgroupId, slug, action: 'cleared' as const, reason: 'pr-merged', pr: merged.number };
      if (!enabled) {
        log.info('claims reconcile: would clear claim whose PR merged', { class: 'stale-claim', ...base });
        outcomes.push({ ...base, applied: false });
        continue;
      }

      // Ledger BEFORE the delete: a failed append must leave the claim.
      try {
        appendLedger(
          claimsDir,
          ledgerLine({
            event: 'cleared_merged',
            slug,
            owner: typeof raw.owner === 'string' && raw.owner ? raw.owner : 'unknown',
            by: RECONCILE_LEDGER_ACTOR,
            at: new Date(now).toISOString(),
            claimedAt: typeof raw.claimed_at === 'string' ? raw.claimed_at : undefined,
            threadId: typeof raw.thread_id === 'string' ? raw.thread_id : undefined,
            pr: merged.number,
            note,
          }),
        );
      } catch (err) {
        log.warn('claims reconcile: ledger append failed, claim left in place', { workgroupId, slug, err });
        outcomes.push({ ...base, action: 'kept', reason: 'ledger-failed', applied: false });
        continue;
      }

      // A status flag would leave the row on the board.
      fs.rmSync(file, { force: true });
      log.warn('claims reconcile: cleared claim — its PR merged', { class: 'stale-claim', ...base });
      outcomes.push({ ...base, applied: true });
    }
  }
  return outcomes;
}
