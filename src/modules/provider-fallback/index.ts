/**
 * Only the container can observe "this account is spent until Tuesday"; the
 * host records the window and respawns the session onto the declared fallback.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleProviderUnavailable } from './handler.js';
import { handleProviderRetryPrimary } from './retry-primary.js';

const PROVIDER_UNAVAILABLE_ACTION = unguarded(
  'reports the calling session own provider outage; the handler only writes an availability window for that agent group and respawns that session',
);
registerDeliveryAction('provider_unavailable', handleProviderUnavailable, PROVIDER_UNAVAILABLE_ACTION);

/** Strictly weaker than the action above (clears a window, own group only), hence also unguarded. */
const PROVIDER_RETRY_PRIMARY_ACTION = unguarded(
  'asks for the calling session own group primary provider to be tried again; the handler only clears that group availability window and respawns that session',
);
registerDeliveryAction('provider_retry_primary', handleProviderRetryPrimary, PROVIDER_RETRY_PRIMARY_ACTION);
