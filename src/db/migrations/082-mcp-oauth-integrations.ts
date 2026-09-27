import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Registry that lets the host act as an MCP OAuth client for remote servers: discover the authorization server, hold
 * a refresh token, and keep the injected bearer fresh (a hand-pasted token keeps being injected after it expires).
 * NO TOKEN MATERIAL: refresh token and client secret live in the host-side bundle store, the access token in OneCLI.
 * Keyed by operator-chosen NAME, the handle every verb takes; the UNIQUE on (agent_group_id, mcp_url) is the real
 * guard, since two integrations on one endpoint would race writes to one OneCLI secret. No FK on `agent_group_id`: a
 * cascade would silently delete an OAuth registration on an unrelated group delete.
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
