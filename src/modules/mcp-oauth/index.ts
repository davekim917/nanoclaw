/**
 * Sweep duty: remote-MCP OAuth token refresh, `tick:housekeeping` order 27
 * (after the GitHub credential duties, before the prunes). It PATCHes a OneCLI
 * secret the gateway reads per request, so a RUNNING container's next MCP call
 * gets the new token without a restart. Registered via
 * `registerSweepDutySource` so it survives `_resetSweepRegistryForTesting()`.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';

function registerMcpOAuthSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK4,
    phase: 'tick:housekeeping',
    order: 27,
    run: async () => {
      try {
        const { refreshExpiringMcpOAuthIntegrations } = await import('./service.js');
        await refreshExpiringMcpOAuthIntegrations();
      } catch (err) {
        // Token and bundle failures are already row statuses; a pass-level
        // failure (the listing) lands here and must not take housekeeping down.
        log.warn('MCP OAuth refresh sweep step failed', { err });
      }
    },
  });
}

registerSweepDutySource('mcp-oauth', registerMcpOAuthSweepDuties);
