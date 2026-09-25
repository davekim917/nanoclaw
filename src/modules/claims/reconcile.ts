/**
 * Claim reconciliation — a claim is a LEASE on work, and a lease has to expire
 * against reality, not against its owner remembering to close it.
 *
 * Self-heal (self-heal.ts) answers "this claim stopped moving, push it". This
 * answers the question that comes first and is cheaper to be certain about:
 * *did the work already land?* Without it, claims sit `parked` with a note like
 * "waiting on <a human>: PR <n> mechanically ready" long after that PR merged —
 * rows in the Observatory's `needs_you` lane claiming a human owes a decision
 * on work that already shipped. A false positive in the one lane
 * that has to be trustworthy, and no amount of nudging fixes it: the owner is
 * gone, the work is done, and only the claim file disagrees.
 *
 * The rule is `claim.sh`'s `release --merged-pr`, lifted to the host: *verified
 * against GitHub, never inferred from a stale timestamp and never taken on the
 * caller's assertion*. Clearing means DELETING the file — a status flag would
 * leave the row on the board, and the row disappearing is the entire point. The
 * note is not lost: it goes to `claims/ledger.ndjson` first, in the same shape
 * and under the same lock `claim.sh` uses, because containers append to that
 * file concurrently with this sweep.
 *
 * Fail-closed everywhere. GitHub unreachable, rate-limited, or ambiguous means
 * the claim stays exactly where it is. A claim wrongly left open costs a human
 * one glance; a claim wrongly deleted destroys the only record that anybody was
 * ever on the work.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { SELF_HEAL_ENABLED } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { resolveGitHubAppToken } from '../../github-app-token.js';
import { log } from '../../log.js';
import { claimsBaseDir } from './escalation.js';

/** Scan cadence. Deliberately NOT the 60s host sweep — see `reconcileMergedClaims`. */
const RECONCILE_SCAN_INTERVAL_MS = 10 * 60 * 1000;

/** A hung GitHub call must not hold up the rest of the sweep. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * `by` on the ledger row. Names the mechanism, never a person — a human did not
 * clear this. Follows the `host-migration` precedent already in the ledger.
 */
export const RECONCILE_LEDGER_ACTOR = 'host-claims-reconcile';

/** One `owner/repo#number`. Issues and pull requests share one numbering sequence. */
export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * What GitHub says about a referenced number.
 *
 * `absent` is a 404: the number exists in neither sequence, or the repository is
 * not visible to our token. Either way it carries no signal about whether the
 * claimed work landed, so it is ignored rather than read as evidence in either
 * direction.
 */
export type RefState = 'merged' | 'open' | 'closed' | 'absent';

export interface RefLookup {
  state: RefState;
  mergedAt?: string;
}

export function refKey(ref: GitHubRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Below this many digits a number found by INFERENCE is noise, not a reference.
 * With the leading-zero rejection it is what keeps `team-pr<n>-01-…` from
 * probing number 1 — a real, long-since-merged pull request in any active repository.
 *
 * It does not apply to a reference that named its own repository: `org/repo#<n>`
 * and a pull URL are never accidental, so there is nothing to filter.
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
 * Every GitHub number a claim carries, from its slug AND its note.
 *
 * Both matter and neither is sufficient: `gh-<a>.json` encodes <a> in its slug
 * but its note may be about #<b>, and the claim is only finished when #<b> lands.
 *
 * `defaultRepo` (`owner/repo`) resolves bare numbers. A reference that names its
 * own repository — a URL, or `owner/repo#n` — always wins over it, so a note
 * that mentions a second repository can never be resolved against the wrong one.
 * With no default and no qualified reference, bare numbers yield nothing and the
 * claim is simply left alone.
 *
 * Digit runs are matched whole (`\d+` is greedy), so a four-digit reference
 * never also yields its three-digit prefix.
 */
export function parseGitHubRefs(slug: string, note: string, defaultRepo?: string): GitHubRef[] {
  const refs = new Map<string, GitHubRef>();
  const [defOwner, defRepo] = (defaultRepo ?? '').split('/');

  for (const m of note.matchAll(PULL_URL)) pushRef(refs, m[1], m[2], m[3], true);
  for (const m of note.matchAll(QUALIFIED)) pushRef(refs, m[1], m[2], m[3], true);

  // Bare `#n` — scanned over a note with the qualified forms blanked out, so
  // `otherorg/repo#<n>` cannot also register as `<default-repo>#<n>`.
  const bare = note.replace(PULL_URL, ' ').replace(QUALIFIED, ' ');
  for (const m of bare.matchAll(/#(\d+)/g)) pushRef(refs, defOwner, defRepo, m[1]);

  // Slug numbers, deliberately NARROW: a number glued to a `gh`/`pr` prefix
  // anywhere (`gh-963`, `pr941`), or a bare number that leads the slug or
  // follows a `gh`/`pr` token (`proj-956-scope-guards`, `proj-gh-522-618-*`).
  //
  // A number deeper in the slug is not a reference, it is part of the name — in
  // a slug like `team-outreach-deck-brand-1800-x` the 1800 is a product name.
  // Probing those is not merely wasteful: today they 404, but once the
  // repository reaches that number the same slug silently starts resolving to real,
  // unrelated work and clearing a live claim.
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
 * Whether the referenced work has landed.
 *
 *   - any OPEN reference → keep, whatever else merged.
 *   - no merge anywhere → keep. Never inferred from a closed-unmerged pull
 *     request (an abandoned branch is not a shipped one) and never from age.
 *   - at least one merge, nothing open → clear.
 *
 * The OPEN rule is the whole safety margin, and it is load-bearing rather than
 * defensive. Notes cite merged pull requests as CONTEXT for why work is stuck at
 * least as often as evidence that it finished. Real notes that "a merged PR is
 * mentioned, therefore done" would have wrongly deleted:
 *
 *   "PR <n> … found insufficient … wait for the ruling"   — <n> MERGED
 *   "PR <n> fixed only the approval-linked door"           — <n> MERGED
 *   "nothing for a fixer to do until QA re-verifies"       — a cited PR MERGED
 *
 * In each the merge is real and the work is not done — and GitHub already
 * knows, because a human reopened the issue the slug names. Asking about every
 * reference rather than only the pull requests is what lets that reopen speak.
 *
 * The mirror case is why this is not "every reference must be merged":
 * a claim can cite a deliberately-never-merged `[smoke freeze] do not merge`
 * PR alongside the PR that actually shipped. A closed-unmerged reference is a dead end, not pending work.
 */
export function decideReconcile(states: RefState[]): 'clear' | 'keep' {
  if (states.includes('open')) return 'keep';
  return states.includes('merged') ? 'clear' : 'keep';
}

/**
 * One `claims/ledger.ndjson` row, byte-compatible with `claim.sh`'s
 * `ledger_append`: same key order, same optional-key elisions, `pr` as a
 * NUMBER. The two writers share one file and one reader, so the shapes cannot
 * be allowed to drift.
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
 * Append under the SAME `flock` on the SAME `.ledger.lock` that `claim.sh` uses
 * — containers append to this file concurrently with this sweep, and the claims
 * directory is a bind mount of one host inode, so the two locks are genuinely
 * the same lock.
 *
 * Node has no `flock(2)` binding, so this shells out to util-linux `flock`. A
 * host without it throws, which is the correct outcome: the caller appends
 * BEFORE deleting, so a failed append leaves the claim file untouched.
 */
function appendLedger(claimsDir: string, line: string): void {
  execFileSync(
    'flock',
    ['-x', path.join(claimsDir, '.ledger.lock'), 'tee', '-a', path.join(claimsDir, 'ledger.ndjson')],
    { input: `${line}\n`, stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

/**
 * Terminal answers only, for the life of the process.
 *
 * `merged` never un-merges. `absent` is cached for a subtler reason: a number
 * that does not exist in a repository's sequence today can only start existing
 * through unrelated later work, which is exactly the collision this must never
 * act on — so remembering the miss makes the hazard monotonically safer, not
 * staler. `open` and `closed` are deliberately absent from the cache: both can
 * still change, and a closed issue can be reopened.
 */
// ponytail: unbounded map, one small entry per distinct reference ever seen.
// Bound it if a claims directory ever churns enough for that to be real memory.
const terminalLookups = new Map<string, RefLookup>();

/** Test hook — the cache and throttle are process-global and would leak across cases. */
export function _resetReconcileStateForTesting(): void {
  terminalLookups.clear();
  lastRanAtMs = 0;
}

const APP_ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_TOKEN'];

/**
 * The host's own GitHub identity, App first, then a PAT. `.env` is merged UNDER
 * `process.env` — the same precedence `config.ts` uses — because the App
 * settings live in `.env` on an install whose service does not export them.
 *
 * `undefined` means this install has no host GitHub identity, and reconciliation
 * is then a no-op rather than a failure.
 */
async function resolveToken(): Promise<string | undefined> {
  const env = { ...readEnvFile(APP_ENV_KEYS), ...process.env };
  // Checked before calling: resolveGitHubAppToken WARNs on incomplete config,
  // which on a PAT-only install would be a spurious warning every scan.
  if (env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    const minted = await resolveGitHubAppToken(env);
    if (minted) return minted;
  }
  const pat = env.GITHUB_TOKEN;
  return pat && pat !== 'app:github' ? pat : undefined;
}

/**
 * One reference, via `/issues/{n}` — which answers for pull requests too, and is
 * the only endpoint that can tell us a human REOPENED the issue a merge was
 * supposed to close. Throws on anything that is not a definitive answer, so the
 * caller fails closed.
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
 * The repository bare numbers resolve against, per workgroup:
 * `CLAIMS_PR_REPO_<WORKGROUP>` then `CLAIMS_PR_REPO`, as `owner/repo`. Same
 * scoped-env convention as `GITHUB_TOKEN_<FOLDER>`.
 *
 * There is deliberately no inference here. A workgroup routinely has a dozen
 * canonical repositories, numbers are per-repo and collide densely across them,
 * so "try them all" would clear a claim on the strength of an unrelated
 * repository's same-numbered PR. Unset means bare numbers resolve to nothing and only
 * fully-qualified references reconcile — the honest answer, not a degraded one.
 */
function defaultRepoFor(workgroupId: string): string | undefined {
  const scoped = `CLAIMS_PR_REPO_${workgroupId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const env = { ...readEnvFile([scoped, 'CLAIMS_PR_REPO']), ...process.env };
  const value = env[scoped] ?? env.CLAIMS_PR_REPO;
  return value && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined;
}

export interface ReconcileDeps {
  /** Claims root — `data/workgroups` in production. Supplying it also disables the scan throttle. */
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
  /** false in shadow mode, or when the ledger append failed — the claim stayed on disk. */
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

/** Pure — throttle gate, mirroring the self-heal scan's. */
function shouldSkipReconcileScan(lastRan: number, now: number): boolean {
  return now - lastRan < RECONCILE_SCAN_INTERVAL_MS;
}

/**
 * Clear every claim whose referenced work has verifiably landed.
 *
 * Runs BEFORE the self-heal ladder in the same sweep step: a claim whose work
 * is done should be closed, never escalated at somebody.
 *
 * Cost control is three layers and not one of them is a new timer: the scan is
 * throttled to `RECONCILE_SCAN_INTERVAL_MS` (10 min, not the sweep's 60s); only
 * claims that actually reference something are candidates; and terminal answers
 * are cached for the life of the process, so the long tail of issue numbers
 * settles to zero requests instead of being re-probed every scan.
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
    // No host GitHub identity: nothing can be verified, so nothing is cleared.
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
          // The pull request that closed the claim: the most recently merged one.
          if (result.state === 'merged' && (!merged || (result.mergedAt ?? '') > (merged.mergedAt ?? ''))) {
            merged = { number: ref.number, mergedAt: result.mergedAt };
          }
        }
      } catch (err) {
        // Unreachable, rate-limited, ambiguous: do nothing. Never delete on a
        // failed lookup — an outage must not empty the board.
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

      // Ledger BEFORE the delete, exactly as claim.sh does it: a failed append
      // must leave the claim, never destroy the only record of it.
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

      // Clearing IS deleting. A status flag would leave the row on the board,
      // and the row disappearing is the whole point.
      fs.rmSync(file, { force: true });
      log.warn('claims reconcile: cleared claim — its PR merged', { class: 'stale-claim', ...base });
      outcomes.push({ ...base, applied: true });
    }
  }
  return outcomes;
}
