/**
 * Pull a one-time dashboard token off the URL so a link from chat logs the
 * user in with one click instead of a copy-paste of 64 hex characters.
 *
 * The issued link puts the token in the FRAGMENT (`#token=…`), which browsers
 * never send to the server — so a live token cannot land in an access log or a
 * proxy log on its way in. `?token=` is still accepted for a hand-built URL and
 * scrubbed the same way.
 *
 * Scrubbing is synchronous and happens before the exchange, so the token is
 * gone from the address bar and from history even if the exchange then fails.
 * `#token=…` is not a route, and the router already falls back to the inbox for
 * any hash it does not recognise, so a reload mid-flight renders normally.
 */
export function takeUrlToken(): string | null {
  const fromHash = /^#token=([A-Za-z0-9._-]+)$/.exec(location.hash);
  const token = fromHash ? fromHash[1] : new URLSearchParams(location.search).get('token');
  if (token) history.replaceState(null, '', location.pathname);
  return token;
}
