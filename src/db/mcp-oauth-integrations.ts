/**
 * Registry rows for remote-MCP OAuth integrations (migration 082). Metadata only: the refresh token and client secret
 * live in the host-side bundle store and the access token in OneCLI, which is what lets `ncl integrations list`
 * render a row verbatim.
 */
import { getDb } from './connection.js';

/**
 * `pending`: login started, no bearer ever written. `active`: bearer in OneCLI, the refresher owns expiry.
 * `needs_login`: refresh token gone or rejected; the refresher stops and only a fresh `login` clears it. `error`:
 * transient refresh failure, retried.
 */
export type McpOAuthStatus = 'pending' | 'active' | 'needs_login' | 'error';

export interface McpOAuthIntegration {
  name: string;
  agent_group_id: string;
  mcp_url: string;
  /** RFC 8707 resource indicator. */
  resource: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  issuer: string | null;
  /** Space-delimited, as on the wire. */
  scopes: string | null;
  redirect_uri: string;
  bearer_secret_name: string;
  bearer_secret_id: string | null;
  host_pattern: string;
  path_pattern: string | null;
  status: McpOAuthStatus;
  status_detail: string | null;
  /** Access-token expiry, ISO-8601 UTC; null until the first exchange. */
  expires_at: string | null;
  last_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `name, agent_group_id, mcp_url, resource, authorization_endpoint, token_endpoint,
  registration_endpoint, issuer, scopes, redirect_uri, bearer_secret_name, bearer_secret_id,
  host_pattern, path_pattern, status, status_detail, expires_at, last_refresh_at, created_at, updated_at`;

export function listMcpOAuthIntegrations(agentGroupId?: string): Promise<McpOAuthIntegration[]> {
  if (agentGroupId) {
    return getDb().all<McpOAuthIntegration>(
      `SELECT ${COLUMNS} FROM mcp_oauth_integrations WHERE agent_group_id = ? ORDER BY name ASC`,
      agentGroupId,
    );
  }
  return getDb().all<McpOAuthIntegration>(`SELECT ${COLUMNS} FROM mcp_oauth_integrations ORDER BY name ASC`);
}

export function getMcpOAuthIntegration(name: string): Promise<McpOAuthIntegration | undefined> {
  return getDb().get<McpOAuthIntegration>(`SELECT ${COLUMNS} FROM mcp_oauth_integrations WHERE name = ?`, name);
}

/**
 * Lets `login` detect a taken (group, URL) pair BEFORE registering a client: a dynamic registration that then hits
 * the unique index leaves a provider-side credential nothing here can see or revoke.
 */
export function getMcpOAuthIntegrationByTarget(
  agentGroupId: string,
  mcpUrl: string,
): Promise<McpOAuthIntegration | undefined> {
  return getDb().get<McpOAuthIntegration>(
    `SELECT ${COLUMNS} FROM mcp_oauth_integrations WHERE agent_group_id = ? AND mcp_url = ?`,
    agentGroupId,
    mcpUrl,
  );
}

/** Upsert by name: a re-login must not orphan the row or its OneCLI secret, and must keep `created_at`. */
export async function upsertMcpOAuthIntegration(
  row: Omit<McpOAuthIntegration, 'created_at' | 'updated_at'>,
): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO mcp_oauth_integrations (${COLUMNS})
       VALUES (@name, @agent_group_id, @mcp_url, @resource, @authorization_endpoint, @token_endpoint,
               @registration_endpoint, @issuer, @scopes, @redirect_uri, @bearer_secret_name, @bearer_secret_id,
               @host_pattern, @path_pattern, @status, @status_detail, @expires_at, @last_refresh_at, @now, @now)
     ON CONFLICT(name) DO UPDATE SET
       agent_group_id = excluded.agent_group_id,
       mcp_url = excluded.mcp_url,
       resource = excluded.resource,
       authorization_endpoint = excluded.authorization_endpoint,
       token_endpoint = excluded.token_endpoint,
       registration_endpoint = excluded.registration_endpoint,
       issuer = excluded.issuer,
       scopes = excluded.scopes,
       redirect_uri = excluded.redirect_uri,
       bearer_secret_name = excluded.bearer_secret_name,
       bearer_secret_id = excluded.bearer_secret_id,
       host_pattern = excluded.host_pattern,
       path_pattern = excluded.path_pattern,
       status = excluded.status,
       status_detail = excluded.status_detail,
       expires_at = excluded.expires_at,
       last_refresh_at = excluded.last_refresh_at,
       updated_at = excluded.updated_at`,
    { ...row, now },
  );
}

export async function markMcpOAuthIntegration(
  name: string,
  patch: {
    status: McpOAuthStatus;
    status_detail?: string | null;
    expires_at?: string | null;
    bearer_secret_id?: string | null;
    last_refresh_at?: string | null;
    /**
     * The scope set actually GRANTED, possibly narrower than requested; re-sending the requested set on refresh reads
     * as widening the grant.
     */
    scopes?: string | null;
  },
): Promise<void> {
  const sets = ['status = @status', 'updated_at = @now'];
  const params: Record<string, unknown> = { name, status: patch.status, now: new Date().toISOString() };
  for (const key of ['status_detail', 'expires_at', 'bearer_secret_id', 'last_refresh_at', 'scopes'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  await getDb().run(`UPDATE mcp_oauth_integrations SET ${sets.join(', ')} WHERE name = @name`, params);
}

export async function deleteMcpOAuthIntegration(name: string): Promise<boolean> {
  const result = await getDb().run('DELETE FROM mcp_oauth_integrations WHERE name = ?', name);
  return result.changes > 0;
}
