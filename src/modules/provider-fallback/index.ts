/**
 * Only the container can observe "this account is spent until Tuesday"; the
 * host records the window and respawns the session onto the declared fallback.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleCodexAccountExhausted } from './codex-account.js';
import { handleProviderUnavailable } from './handler.js';
import { handleProviderRetryPrimary } from './retry-primary.js';
import { handleProviderTurnCompleted } from './turn-completed.js';

const PROVIDER_UNAVAILABLE_ACTION = unguarded(
  'reports the calling session own provider outage; the handler only writes an availability window for that agent group and respawns that session',
);
registerDeliveryAction('provider_unavailable', handleProviderUnavailable, PROVIDER_UNAVAILABLE_ACTION);

/** Strictly weaker than the action above (clears a window, own group only), hence also unguarded. */
const PROVIDER_RETRY_PRIMARY_ACTION = unguarded(
  'asks for the calling session own group primary provider to be tried again; the handler only clears that group availability window and respawns that session',
);
registerDeliveryAction('provider_retry_primary', handleProviderRetryPrimary, PROVIDER_RETRY_PRIMARY_ACTION);

const CODEX_ACCOUNT_EXHAUSTED_ACTION = unguarded(
  'reports that one of the calling session own mounted Codex accounts hit its quota; the handler only marks that account for an hour so new containers start on the next one, and the runner still rotates on its own if the mark is wrong',
);
registerDeliveryAction('codex_account_exhausted', handleCodexAccountExhausted, CODEX_ACCOUNT_EXHAUSTED_ACTION);

/** Strictly weaker than `provider_unavailable`: it can only clear a window older than the reported turn. */
const PROVIDER_TURN_COMPLETED_ACTION = unguarded(
  'reports that the calling session own provider answered a turn; the handler only clears that agent group window and failure streak for that provider when they predate the turn',
);
registerDeliveryAction('provider_turn_completed', handleProviderTurnCompleted, PROVIDER_TURN_COMPLETED_ACTION);
