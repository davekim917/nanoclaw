/**
 * Sweep family: remote-MCP OAuth token refresh (FORK4).
 *
 * Registration goes through `registerSweepDutySource`, not `registerSweepDuty`
 * directly, so the duty survives `_resetSweepRegistryForTesting()` — see the
 * comment above `registerSweepDutySource` in src/host-sweep.ts.
 *
 * `tick:housekeeping`, order 27 — immediately after the two GitHub credential
 * duties (T7 re-mint at 20, FORK1 file push at 25) and before the prunes. Same
 * family of work as T7: a short-lived credential the host owns is re-minted
 * before a consumer can find it dead. The difference is where it lands — T7
 * writes an env value a container only picks up on respawn, this one PATCHes a
 * OneCLI secret the gateway reads per request, so a RUNNING container's next
 * MCP call carries the new token without a restart.
 */
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';

export function registerMcpOAuthSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK4,
    phase: 'tick:housekeeping',
    order: 27,
    run: async () => {
      try {
        const { refreshExpiringMcpOAuthIntegrations } = await import('./service.js');
        await refreshExpiringMcpOAuthIntegrations();
      } catch (err) {
        // The refresher already downgrades per-integration failures to a row
        // status plus a WARN; reaching here means the listing itself failed,
        // which must not take the rest of housekeeping down with it.
        log.warn('MCP OAuth refresh sweep step failed', { err });
      }
    },
  });
}

registerSweepDutySource('mcp-oauth', registerMcpOAuthSweepDuties);
