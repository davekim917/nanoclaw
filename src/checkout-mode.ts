/**
 * `NANOCLAW_CHECKOUT_MODE=worktree|clone` (docs/specs/repository-branch-clones/plan.md
 * §5.3, M1): how `create_worktree` makes a NEW checkout. Resolution of an
 * existing checkout is shape-aware in both modes, so switching back to
 * `worktree` strands no clone (§7 rollback).
 *
 * Read from `process.env` at first use, never at import: main.ts loads `.env`
 * into process.env inside main() (`loadEnvIntoProcess` in src/main.ts), after
 * every module has been imported, so an import-time read would
 * miss a value set only in `.env`. It is resolved at first use (the first
 * spawn), which WARNs once for a refused value, and is then fixed for the
 * process: changing it takes a restart.
 */
import { containerRunsAsHostUser } from './github-token-file.js';
import { log } from './log.js';

export type CheckoutMode = 'worktree' | 'clone';

export const CHECKOUT_MODE_ENV = 'NANOCLAW_CHECKOUT_MODE';

export interface CheckoutModeDecision {
  mode: CheckoutMode;
  warning: string | null;
}

/**
 * Unset -> `worktree`. Anything but the two exact names -> `worktree` with a
 * warning: a typo must never enable clones. `clone` also needs containers that
 * run as the host uid (`containerRunsAsHostUser`, src/github-token-file.ts):
 * the host creates every clone, and a container running as any other uid could
 * not write the files the host made (plan §5.2 preconditions).
 */
export function decideCheckoutMode(raw: string | undefined, containersRunAsHostUser: boolean): CheckoutModeDecision {
  if (raw === undefined || raw === 'worktree') return { mode: 'worktree', warning: null };
  if (raw !== 'clone') {
    return {
      mode: 'worktree',
      warning: `${CHECKOUT_MODE_ENV}=${JSON.stringify(raw)} is neither worktree nor clone; using worktree`,
    };
  }
  if (!containersRunAsHostUser) {
    return {
      mode: 'worktree',
      warning:
        `${CHECKOUT_MODE_ENV}=clone refused: containers do not run as the host uid, so they could not ` +
        'write host-created clones; using worktree',
    };
  }
  return { mode: 'clone', warning: null };
}

let resolved: CheckoutMode | null = null;

/** The mode for this host process, resolved and logged once. */
export function effectiveCheckoutMode(): CheckoutMode {
  if (resolved) return resolved;
  const raw = process.env[CHECKOUT_MODE_ENV];
  const decision = decideCheckoutMode(raw, containerRunsAsHostUser());
  if (decision.warning) {
    log.warn(`Checkout mode: ${decision.warning}`, { requested: raw ?? null, mode: decision.mode });
  } else {
    log.info('Checkout mode', { mode: decision.mode });
  }
  resolved = decision.mode;
  return resolved;
}

export function _resetCheckoutModeForTesting(): void {
  resolved = null;
}
