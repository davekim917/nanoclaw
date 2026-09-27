/**
 * `NANOCLAW_CHECKOUT_MODE=worktree|clone`: how `create_worktree` makes a NEW checkout; resolving an existing one is
 * shape-aware in both modes, so switching back strands no clone. Read at first use (the first spawn), never at
 * import: main() loads `.env` into process.env after every module is imported. Fixed for the process thereafter.
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
 * Unset is `worktree` silently; anything else but the two exact names is `worktree` with a warning: a typo must
 * never enable clones. `clone` also needs containers running as the host uid, since the host creates every clone.
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
