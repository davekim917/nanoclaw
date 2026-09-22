/**
 * Provider-fallback module — `provider_unavailable` delivery action.
 *
 * A container is the only thing that talks to its provider, so it is the only
 * thing that can observe "this account is spent until Tuesday". It reports
 * that here; the host records the window (`provider_health`) and respawns the
 * session, which then picks the group's declared fallback at spawn time.
 *
 * The user-visible effect is a slow reply instead of an error, and recovery
 * is automatic: the window ages out and the next spawn returns to the primary.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleProviderUnavailable } from './handler.js';
import { handleProviderRetryPrimary } from './retry-primary.js';

const PROVIDER_UNAVAILABLE_ACTION = unguarded(
  'reports the calling session own provider outage; the handler only writes an availability window for that agent group and respawns that session',
);
registerDeliveryAction('provider_unavailable', handleProviderUnavailable, PROVIDER_UNAVAILABLE_ACTION);

/**
 * The way back. Strictly weaker than the action above — it clears a window it
 * cannot set, for the calling session's own group only — so it carries the
 * same unguarded justification.
 */
const PROVIDER_RETRY_PRIMARY_ACTION = unguarded(
  'asks for the calling session own group primary provider to be tried again; the handler only clears that group availability window and respawns that session',
);
registerDeliveryAction('provider_retry_primary', handleProviderRetryPrimary, PROVIDER_RETRY_PRIMARY_ACTION);
