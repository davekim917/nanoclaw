/**
 * Runs the pr-review-loop churn gate (`codex-review.sh gate`) before a container
 * `git_push`, since agents push through the MCP tool, not the skill's push path.
 * Never reimplement the classifier here: it runs the skill's one copy.
 * Fails OPEN: only an explicit exit 3 refuses a push.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

export const CHURN_GATE_SCRIPT_PATHS = [
  '/home/node/.claude/skills/pr-review-loop/scripts/codex-review.sh',
  '/app/skills/pr-review-loop/scripts/codex-review.sh',
];

/** Set only by the host at spawn, so an agent cannot use it to bypass the gate. */
export const CHURN_GATE_SCRIPT_ENV = 'NANOCLAW_REVIEW_CHURN_GATE_SCRIPT';

const REFRAME_REQUIRED_EXIT = 3;

/**
 * Pin the gate to the pushed commit (and `BRANCH` env), never the checkout:
 * siblings share the worktree. `--committed-only` because a push sends only
 * committed history; uncommitted work must not count as the reframe.
 */
export function churnGateArgs(head: string): string[] {
  return ['gate', '--committed-only', '--head', head];
}

const DEFAULT_TIMEOUT_MS = 45_000;

export type ChurnGateResult =
  | { status: 'pass' }
  | { status: 'skipped'; reason: string }
  | { status: 'refused'; message: string };

export interface ChurnGateRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface ChurnGateOptions {
  worktree: string;
  branch: string;
  head: string;
  force?: boolean;
  lease?: string;
  scriptPaths?: string[];
  run?: (script: string, args: string[], worktree: string, timeoutMs: number, env: NodeJS.ProcessEnv) => ChurnGateRun;
  timeoutMs?: number;
  exists?: (p: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

function defaultRun(
  script: string,
  args: string[],
  worktree: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): ChurnGateRun {
  const res = spawnSync('bash', [script, ...args], {
    cwd: worktree,
    encoding: 'utf8',
    timeout: timeoutMs,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ?? undefined,
  };
}

/** Git allows `&` and backticks in branch names, and the override command is meant to be executed. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function refusalMessage(
  gateText: string,
  script: string,
  identity: { branch: string; head: string; force?: boolean; lease?: string },
): string {
  // A refused force push is usually a rewrite, so the override must force too,
  // with the captured lease: bare `--force` drops it, bare `--force-with-lease`
  // re-reads the tracking ref at override time.
  const forceFlag =
    identity.force === true
      ? [`        ${shellQuote(`--force-with-lease=refs/heads/${identity.branch}:${identity.lease ?? ''}`)} \\`]
      : [];
  return [
    gateText.trim(),
    '',
    'This push was refused by the pr-review-loop churn gate. The next commit must',
    'move the invariant into the primitive named above, not patch another call site.',
    '',
    'If the reframe honestly belongs to a different PR, take the override through the',
    'skill so it is recorded on the PR body rather than made silently:',
    '',
    // Bound to the refused identity: an unbound override follows the checkout
    // and could push a sibling's branch. `origin` is required, or git reads the
    // refspec as the repository name.
    `    REVIEW_LOOP_ALLOW_SITE_PATCH=1 BRANCH=${shellQuote(identity.branch)} ${shellQuote(script)} push \\`,
    ...forceFlag,
    `        origin ${shellQuote(`${identity.head}:refs/heads/${identity.branch}`)}`,
  ].join('\n');
}

export function evaluateReviewChurnGate(options: ChurnGateOptions): ChurnGateResult {
  const exists = options.exists ?? fs.existsSync;
  const override = (options.env ?? process.env)[CHURN_GATE_SCRIPT_ENV];
  const paths = options.scriptPaths ?? (override ? [override] : CHURN_GATE_SCRIPT_PATHS);
  const script = paths.find((p) => {
    try {
      return exists(p);
    } catch {
      return false;
    }
  });
  if (!script) return { status: 'skipped', reason: 'the pr-review-loop skill is not mounted in this container' };

  const run = options.run ?? defaultRun;
  const childEnv = { ...(options.env ?? process.env), BRANCH: options.branch };
  let result: ChurnGateRun;
  try {
    result = run(
      script,
      churnGateArgs(options.head),
      options.worktree,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      childEnv,
    );
  } catch (error) {
    return {
      status: 'skipped',
      reason: `the gate could not run (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  if (result.error) return { status: 'skipped', reason: `the gate could not run (${result.error.message})` };
  if (result.status === REFRAME_REQUIRED_EXIT) {
    // Without --json the gate prints its decision on stderr.
    return {
      status: 'refused',
      message: refusalMessage(result.stderr || result.stdout, script, {
        branch: options.branch,
        head: options.head,
        force: options.force,
        lease: options.lease,
      }),
    };
  }
  if (result.status === 0) return { status: 'pass' };
  return {
    status: 'skipped',
    reason: `the gate returned ${result.status ?? 'no status'} (${(result.stderr || result.stdout).trim().split('\n')[0] ?? 'no output'})`,
  };
}
