import { getRawDb } from '../../db/connection.js';

export interface DashboardTokenRecord {
  id: number;
  user_id: string;
  token_hmac: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
}

export function issueDashboardToken(userId: string, tokenHmac: string, ttlHours: number): DashboardTokenRecord {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();
  return getRawDb()
    .prepare(
      `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
       VALUES (@user_id, @token_hmac, @issued_at, @expires_at)
       RETURNING *`,
    )
    .get({
      user_id: userId,
      token_hmac: tokenHmac,
      issued_at: issuedAt,
      expires_at: expiresAt,
    }) as DashboardTokenRecord;
}

export function consumeDashboardToken(tokenHmac: string): DashboardTokenRecord | null {
  // One bound ISO value for both the comparison and the write. NOT
  // `datetime('now')`, and NOT `datetime(expires_at) > datetime('now')` either:
  //
  // `expires_at` is written as ISO (`...T...Z`) while `datetime('now')` yields
  // the naive `YYYY-MM-DD HH:MM:SS` shape, and SQLite compares them as TEXT. At
  // index 10, 'T' (0x54) beats ' ' (0x20), so an ISO timestamp always sorts
  // above a naive one from the same date — meaning a token that expired at 01:00
  // still satisfied `expires_at > datetime('now')` at 08:10 the same day. That
  // was a live auth bypass: expired tokens stayed valid for the remainder of the
  // UTC day they died on, bounded only by the date rolling over and by
  // `used_at IS NULL` keeping them single-use.
  //
  // Wrapping both sides in `datetime()` would fix the comparison but leave
  // `used_at` still writing the naive shape, so the same class of bug simply
  // moves to the next reader of that column. Binding one ISO value fixes both.
  const nowIso = new Date().toISOString();
  return (
    (getRawDb()
      .prepare(
        `UPDATE dashboard_tokens
         SET used_at = @now
         WHERE token_hmac = @token_hmac
           AND used_at IS NULL
           AND expires_at > @now
         RETURNING *`,
      )
      .get({ token_hmac: tokenHmac, now: nowIso }) as DashboardTokenRecord | undefined) ?? null
  );
}

/**
 * Prune dashboard_tokens rows. Called from the host sweep tick (post-build QA
 * fix SF-6 — without this the table grew unbounded as every /dashboard-token
 * invocation added a row that was never reaped).
 *
 * Retention: 1 day past the token's `expires_at`. The grace period preserves
 * "expired" rows briefly so an operator chasing an issue can confirm a token was
 * issued; production cookies are tied to fresh tokens that get consumed quickly.
 */
export function pruneDashboardTokens(): void {
  getRawDb().prepare(`DELETE FROM dashboard_tokens WHERE expires_at < datetime('now', '-1 day')`).run();
}
