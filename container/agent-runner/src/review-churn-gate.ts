/**
 * The PR review-loop churn gate, at the container's push primitive.
 *
 * `pr-review-loop` refuses a site patch once one finding class has drawn
 * findings in three rounds: the fix belongs in the primitive every flagged
 * site calls, not at one more call site. On a host session that gate sits in
 * `codex-review.sh push`, which is the only push path the skill sanctions.
 *
 * A container agent does not push through a shell. It calls the `git_push`
 * MCP tool, so for it the skill's push path is instruction-only — and
 * instruction-only is exactly what failed before: the advisory detector
 * reported CHURN for eight rounds of PR #291 while every round patched
 * another site. So the gate is hoisted to the primitive the container
 * actually routes through.
 *
 * The decision itself is NOT reimplemented here. This runs the one
 * implementation, `codex-review.sh gate`, out of the read-only skill mount —
 * a second copy of the classifier is the same defect this gate exists to
 * catch.
 *
 * It fails OPEN, always. A push must never be blocked because GitHub was
 * slow, the branch has no PR yet, `gh` is unauthenticated, or the skill is not
 * mounted for this group. Only an explicit exit 3 from the gate refuses.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

/** Where the skill is mounted, in the order the providers see it. */
export const CHURN_GATE_SCRIPT_PATHS = [
  '/home/node/.claude/skills/pr-review-loop/scripts/codex-review.sh',
  '/app/skills/pr-review-loop/scripts/codex-review.sh',
];

/**
 * Operator and test override for the script path. An agent cannot set it —
 * the runner's environment comes from the host at spawn — so it is not a way
 * around the gate from inside a session.
 */
export const CHURN_GATE_SCRIPT_ENV = 'NANOCLAW_REVIEW_CHURN_GATE_SCRIPT';

/** Exit status the skill's gate uses for REFRAME REQUIRED. */
export const REFRAME_REQUIRED_EXIT = 3;

/**
 * The gate is asked about the identity the caller has pinned, never about the
 * checkout as it stands when the script happens to run — same-topic siblings
 * share the worktree, and the verdict has to describe what the push sends.
 *
 * `--committed-only`: a bare `gate` counts uncommitted work at the primitive as
 * evidence of the reframe, which is right for a pre-commit check and wrong in
 * front of a push, because a push sends committed history.
 * `--head <sha>`: read that commit's history, not the current HEAD's.
 * `BRANCH` in the environment: resolve the PR from that branch, not from
 * whatever `gh pr view` finds checked out.
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
  /** The worktree being pushed — the gate reads its imports from here. */
  worktree: string;
  /** The branch being pushed. Resolves the PR without consulting the checkout. */
  branch: string;
  /** The commit being pushed. Its history is the lift evidence. */
  head: string;
  /** Override for tests; defaults to CHURN_GATE_SCRIPT_PATHS. */
  scriptPaths?: string[];
  /** Override for tests; defaults to spawning bash. */
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

/**
 * The refusal an agent sees. It carries the gate's own text — class, sites,
 * seam, candidate primitives — plus the two ways out, one of which is not
 * "push anyway".
 */
export function refusalMessage(gateText: string, script: string): string {
  return [
    gateText.trim(),
    '',
    'This push was refused by the pr-review-loop churn gate. The next commit must',
    'move the invariant into the primitive named above, not patch another call site.',
    '',
    'If the reframe honestly belongs to a different PR, take the override through the',
    'skill so it is recorded on the PR body rather than made silently:',
    '',
    // The script that was actually selected: the Claude mount, the /app
    // fallback, or an override. Printing a path the agent cannot run turns the
    // documented, PR-recorded override into a command that just fails.
    `    REVIEW_LOOP_ALLOW_SITE_PATCH=1 ${script} push`,
  ].join('\n');
}

/**
 * Decide whether this worktree may push. Everything that is not an explicit
 * refusal is a pass — see the fail-open note above.
 */
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
    // The skill prints the human-readable decision on stderr and the JSON on
    // stdout; only `gate` (no --json) is run here, so stderr is the decision.
    return { status: 'refused', message: refusalMessage(result.stderr || result.stdout, script) };
  }
  if (result.status === 0) return { status: 'pass' };
  // Every other status is the gate declining to answer — no PR for this
  // branch yet, `gh` unauthenticated, no JS runtime, a timeout. Not a refusal.
  return {
    status: 'skipped',
    reason: `the gate returned ${result.status ?? 'no status'} (${(result.stderr || result.stdout).trim().split('\n')[0] ?? 'no output'})`,
  };
}
