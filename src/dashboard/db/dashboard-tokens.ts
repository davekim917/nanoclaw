import { getDb } from '../../db/connection.js';

export interface DashboardTokenRecord {
  id: number;
  user_id: string;
  token_hmac: string;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
}

export async function issueDashboardToken(
  userId: string,
  tokenHmac: string,
  ttlHours: number,
): Promise<DashboardTokenRecord> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
  const issuedAt = now.toISOString();
  const row = await getDb().get<DashboardTokenRecord>(
    `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
     VALUES (@user_id, @token_hmac, @issued_at, @expires_at)
     RETURNING *`,
    {
      user_id: userId,
      token_hmac: tokenHmac,
      issued_at: issuedAt,
      expires_at: expiresAt,
    },
  );
  return row!;
}

export async function consumeDashboardToken(tokenHmac: string): Promise<DashboardTokenRecord | null> {
  // One bound ISO value for the comparison and the write, never `datetime('now')`: `expires_at` is ISO and a TEXT
  // comparison against the naive shape sorts ISO above naive on the same date, which kept expired tokens valid for
  // the rest of their UTC day. Wrapping both sides in `datetime()` would still leave `used_at` naive.
  const nowIso = new Date().toISOString();
  const row = await getDb().get<DashboardTokenRecord>(
    `UPDATE dashboard_tokens
       SET used_at = @now
     WHERE token_hmac = @token_hmac
       AND used_at IS NULL
       AND expires_at > @now
     RETURNING *`,
    { token_hmac: tokenHmac, now: nowIso },
  );
  return row ?? null;
}

/**
 * Called from the host sweep so the table does not grow unbounded. Keeps rows 1 day past `expires_at` for debugging.
 */
export async function pruneDashboardTokens(): Promise<void> {
  await getDb().run(`DELETE FROM dashboard_tokens WHERE expires_at < datetime('now', '-1 day')`);
}
