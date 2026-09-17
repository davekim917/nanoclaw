import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 082 — `mcp_oauth_integrations`
 *
 * WHY. A remote MCP server (Dropbox, Amplitude, …) authenticates with a
 * SHORT-LIVED OAuth access token, not an API key. Today the operator pastes
 * one into a OneCLI header-injection secret by hand; when it expires the
 * gateway keeps injecting the dead value (`status=401 injections_applied=1`)
 * and the container's stdio bridge dies with CONNECTION_CLOSED at every spawn
 * until a human notices. This table is the registry that lets the host do what
 * an MCP client does: discover the server's authorization server, hold a
 * refresh token, and keep the injected bearer fresh on its own.
 *
 * NO TOKEN MATERIAL. Every column here is metadata an unauthenticated probe of
 * the MCP URL would have told you anyway — endpoints, scopes, the NAME of the
 * OneCLI secret, an expiry instant, a status. The refresh token and client
 * secret live in the host-side bundle store (`src/modules/mcp-oauth/store.ts`,
 * 0600 under `DATA_DIR/mcp-oauth/`), the access token lives in OneCLI. Neither
 * is readable from this table, so `ncl integrations list` — and the central DB
 * copy a container can read — carry nothing a leak could use.
 *
 * KEYED BY NAME, not by (group, name). The operator picks the name and it is
 * the handle every verb takes (`ncl integrations login --name dropbox-files …`); a
 * per-group namespace would make that handle ambiguous at the CLI without
 * buying anything, since the bearer secret name is already group-qualified.
 * The UNIQUE on (agent_group_id, mcp_url) is the real collision guard: two
 * integrations for one group pointed at one endpoint would race each other's
 * writes to the same OneCLI secret.
 *
 * NO FOREIGN KEY on `agent_group_id`, matching 048/081: the only readers are
 * the sweep refresher and the CLI, and both treat a row whose group has gone
 * away as an ordinary "nothing to do" — the refresher would still be renewing
 * a secret nobody is granted, which `ncl integrations remove` clears, and a
 * cascade here would silently delete the operator's OAuth registration on an
 * unrelated group delete.
 */
export const migration082: Migration = {
  version: 82,
  name: 'mcp-oauth-integrations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_integrations (
        name                     TEXT PRIMARY KEY,
        agent_group_id           TEXT NOT NULL,
        mcp_url                  TEXT NOT NULL,
        resource                 TEXT,
        authorization_endpoint   TEXT NOT NULL,
        token_endpoint           TEXT NOT NULL,
        registration_endpoint    TEXT,
        issuer                   TEXT,
        scopes                   TEXT,
        redirect_uri             TEXT NOT NULL,
        bearer_secret_name       TEXT NOT NULL,
        bearer_secret_id         TEXT,
        host_pattern             TEXT NOT NULL,
        path_pattern             TEXT,
        status                   TEXT NOT NULL,
        status_detail            TEXT,
        expires_at               TEXT,
        last_refresh_at          TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_oauth_integrations_group_url
        ON mcp_oauth_integrations (agent_group_id, mcp_url);
      CREATE INDEX IF NOT EXISTS idx_mcp_oauth_integrations_status
        ON mcp_oauth_integrations (status);
    `);
  },
};
