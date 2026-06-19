/**
 * Malformed guard-core fixture: the required exports are present but NOT the
 * right types. loadGuardCore's validateGuardCore must reject this and the codex
 * runner must DENY (fail-closed), never allow. Pointed at via
 * NANOCLAW_DESTRUCTIVE_GUARD_CORE.
 */
export const evaluateBashCommand = 'not-a-function';
export const consumeGateApproval = 123;
export const runNanoclawGate = null;
export const IS_NANOCLAW = 'nope'; // wrong type (string, not boolean)
