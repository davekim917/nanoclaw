/**
 * `ncl integrations` — connect a remote MCP server the way a first-party MCP
 * client does, instead of pasting an API key.
 *
 *   ncl integrations login --name <n> --url <mcp-url> --group <agent-group-id>
 *   ncl integrations complete --name <n> --redirect-url '<pasted url>'
 *   ncl integrations list [--group <agent-group-id>]
 *   ncl integrations remove --name <n> [--delete-secret]
 *   ncl integrations refresh            # what the sweep does, on demand
 *
 * The default is the two-step paste: `login` prints a URL, the operator opens
 * it on their own machine, and `complete` takes whatever the browser landed on.
 * Nothing on this host tries to open a browser. `--listen` and `--device` are
 * opt-in conveniences documented in docs/mcp-oauth-integrations.md.
 *
 * ACCESS. Every mutating verb is `hostOnly`: an OAuth login mints a credential
 * for the operator's own account at a third party, so it is operator work in
 * the same sense mount management is — no `cli_scope`, not even `global`, and
 * no approval, makes it appropriate for an agent to initiate. `list` is left
 * open because it carries no token material and answers the exact question an
 * agent hitting a 401 through its MCP bridge has ("is my integration expired,
 * or is this something else?"); `integrations` is not in
 * `GROUP_SCOPE_RESOURCES`, so a group-scoped agent is refused it anyway
 * (`src/cli/guard.ts:76`).
 *
 * No `create`/`update`/`delete` generic verbs: a row here is only ever
 * meaningful alongside its OAuth bundle and its OneCLI secret, and a hand-written
 * row would be a registry entry with no credential behind it.
 */
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  completeLogin,
  refreshExpiringMcpOAuthIntegrations,
  removeIntegration,
  startLogin,
} from '../../modules/mcp-oauth/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

/** A boolean flag arrives as `true` from argv parsing and as a real boolean
 *  over the JSON transport. */
function flag(raw: unknown): boolean {
  return raw === true || raw === 'true';
}

/** `--authorize-param k=v` repeated, or a single `k=v,k=v` string. */
function parseExtraParams(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const items = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => String(s).trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--authorize-param expects key=value, got "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

registerResource({
  name: 'integration',
  plural: 'integrations',
  table: 'mcp_oauth_integrations',
  description:
    'Remote MCP servers connected over standard MCP authorization (OAuth 2.0 authorization-code + PKCE + dynamic client registration). The host holds the refresh token and keeps the OneCLI bearer secret the container reads fresh; no API key is ever pasted. Rows carry endpoints, scopes, secret NAMES and status — never token material.',
  idColumn: 'name',
  columns: [
    { name: 'name', type: 'string', description: 'Operator-chosen handle; unique across the install.' },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Agent group whose container.json declares the bearer secret.',
    },
    { name: 'mcp_url', type: 'string', description: 'The MCP endpoint, e.g. https://mcp.dropbox.com/mcp.' },
    {
      name: 'resource',
      type: 'string',
      description: 'RFC 8707 resource indicator from the protected-resource metadata.',
    },
    { name: 'authorization_endpoint', type: 'string', description: 'Discovered.' },
    { name: 'token_endpoint', type: 'string', description: 'Discovered. May be on a different host from the issuer.' },
    { name: 'registration_endpoint', type: 'string', description: 'Discovered; used for dynamic client registration.' },
    { name: 'issuer', type: 'string', description: 'Authorization server issuer.' },
    { name: 'scopes', type: 'string', description: 'Space-delimited scopes the grant was requested with.' },
    { name: 'redirect_uri', type: 'string', description: 'Loopback redirect the authorization code comes back to.' },
    { name: 'bearer_secret_name', type: 'string', description: 'OneCLI secret whose value the gateway injects.' },
    { name: 'bearer_secret_id', type: 'string', description: "That secret's vault UUID." },
    { name: 'host_pattern', type: 'string', description: 'Gateway host match for the injection.' },
    { name: 'path_pattern', type: 'string', description: 'Gateway path match for the injection.' },
    {
      name: 'status',
      type: 'string',
      description: 'pending (login started) | active | needs_login (grant dead) | error (transient refresh failure).',
      enum: ['pending', 'active', 'needs_login', 'error'],
    },
    { name: 'status_detail', type: 'string', description: 'Why, when status is not active.' },
    { name: 'expires_at', type: 'string', description: 'Access-token expiry (ISO-8601 UTC).' },
    { name: 'last_refresh_at', type: 'string', description: 'Last successful token mint.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  listOrder: 'name ASC',
  customOperations: {
    login: {
      access: 'open',
      hostOnly: true,
      description:
        'Start an OAuth login for a remote MCP server. Discovers the authorization server from the MCP URL, registers a client dynamically, and prints a URL to open in a browser. Nothing is granted until `ncl integrations complete`.\n\n' +
        'The host is headless, so open the printed URL on your own machine. The redirect lands on a loopback address nothing is listening on — your browser will show a connection error, and the address bar holds the code. Copy that whole URL into `ncl integrations complete --redirect-url`.',
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Handle for this integration (lowercase, hyphens).',
          required: true,
        },
        { name: 'url', type: 'string', description: 'The MCP endpoint URL.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id that should get the credential.',
          required: true,
        },
        {
          name: 'scopes',
          type: 'string',
          description: "Space-delimited scope override. Defaults to the resource metadata's scopes_supported.",
        },
        {
          name: 'issuer',
          type: 'string',
          description: 'Authorization server override, when the resource lists more than one.',
        },
        {
          name: 'secret',
          type: 'string',
          description:
            'OneCLI secret name to write the bearer into. Defaults to <Name>-MCP-<Group>; point it at an existing secret to adopt it.',
        },
        {
          name: 'redirect-uri',
          type: 'string',
          description:
            'Loopback redirect override (default http://127.0.0.1:8765/callback). Must be a URI the authorization server will accept.',
        },
        {
          name: 'client-name',
          type: 'string',
          description: 'Client name sent to dynamic registration (default NanoClaw).',
        },
        {
          name: 'authorize-param',
          type: 'string',
          description:
            'Extra authorize-endpoint parameter, key=value. Repeatable. Dropbox needs token_access_type=offline to issue a refresh token.',
        },
        {
          name: 'no-resource',
          type: 'boolean',
          description: 'Omit the RFC 8707 resource parameter, for a server that rejects it.',
        },
        {
          name: 'listen',
          type: 'boolean',
          description:
            'Opt-in: also bind a loopback listener here, so a forwarded port (ssh -L 8765:127.0.0.1:8765) completes the login with no paste. The paste path stays open either way.',
        },
        {
          name: 'port',
          type: 'number',
          description:
            'Loopback port for the redirect URI and --listen (default 8765). A re-login keeps the port its client was registered with.',
        },
        {
          name: 'listen-timeout',
          type: 'number',
          description: 'Seconds the --listen listener stays up (default 600).',
        },
        {
          name: 'device',
          type: 'boolean',
          description:
            'Opt-in: use the RFC 8628 device grant instead of a redirect. Only works where the server publishes device_authorization_endpoint.',
        },
        {
          name: 'device-endpoint',
          type: 'string',
          description:
            'Device-authorization endpoint for a server that advertises the device_code grant without publishing the endpoint.',
        },
      ],
      examples: [
        'ncl integrations login --name dropbox-files --url https://mcp.dropbox.com/mcp --group ag-123 --authorize-param token_access_type=offline',
        'ncl integrations login --name amplitude-analytics --url https://mcp.amplitude.com/mcp --group ag-123 --secret Amplitude-MCP-Analytics',
      ],
      handler: async (args) => {
        const group = await getAgentGroup(String(args.group));
        if (!group) throw new Error(`Agent group not found: ${String(args.group)}`);
        const result = await startLogin({
          name: String(args.name),
          mcpUrl: String(args.url),
          agentGroupId: group.id,
          scopes: args.scopes === undefined ? undefined : String(args.scopes),
          issuer: args.issuer === undefined ? undefined : String(args.issuer),
          secretName: args.secret === undefined ? undefined : String(args.secret),
          redirectUri: args['redirect-uri'] === undefined ? undefined : String(args['redirect-uri']),
          clientName: args['client-name'] === undefined ? undefined : String(args['client-name']),
          extraAuthorizeParams: parseExtraParams(args['authorize-param']),
          noResourceIndicator: flag(args['no-resource']),
          listen: flag(args.listen),
          port: args.port === undefined ? undefined : Number(args.port),
          listenTimeoutSeconds: args['listen-timeout'] === undefined ? undefined : Number(args['listen-timeout']),
          device: flag(args.device),
          deviceEndpoint: args['device-endpoint'] === undefined ? undefined : String(args['device-endpoint']),
        });
        return {
          ...result,
          next: `ncl integrations complete --name ${result.name} --redirect-url '<paste the URL your browser landed on>'`,
        };
      },
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof startLogin>> & { next: string };
        const head = [
          `Integration "${d.name}" — client ${d.registered === 'dynamic' ? 'registered dynamically' : 'reused from a previous login'}.`,
          `Bearer secret: ${d.bearerSecretName}`,
          `Scopes:        ${d.scopes || '(none requested)'}`,
          '',
        ];

        if (d.mode === 'device' && d.device) {
          return [
            ...head,
            '1. Open this on YOUR machine:',
            '',
            `   ${d.device.verificationUriComplete ?? d.device.verificationUri}`,
            '',
            `2. Enter the code: ${d.device.userCode}`,
            `   It expires in ${Math.round(d.device.expiresInSeconds / 60)} minutes.`,
            '',
            '3. This finishes on its own once you approve. Confirm with:',
            '',
            '   ncl integrations list',
          ].join('\n');
        }

        const lines = [
          ...head,
          '1. Open this on YOUR machine (this host has no browser):',
          '',
          `   ${d.authorizationUrl}`,
          '',
          '2. Approve. Your browser will fail to load the redirect — that is expected.',
          '3. Copy the whole URL from the address bar and run:',
          '',
          `   ${d.next}`,
        ];

        if (d.loopback) {
          lines.push(
            '',
            `Optional — a listener is up on 127.0.0.1:${d.loopback.port} for ${Math.round(d.loopback.timeoutSeconds / 60)} minutes.`,
            'Forward it from another terminal and step 3 happens by itself:',
            '',
            `   ${d.loopback.sshTunnelCommand}`,
          );
        } else if (d.loopbackError) {
          lines.push('', `(--listen could not bind: ${d.loopbackError} — use the paste above.)`);
        }

        return lines.join('\n');
      },
    },

    complete: {
      access: 'open',
      hostOnly: true,
      description:
        "Finish a login by exchanging the authorization code. Takes the whole redirect URL your browser landed on (or a bare code). Writes the access token into the OneCLI secret, stores the refresh token host-side, and declares the secret in the group's container.json.",
      args: [
        { name: 'name', type: 'string', description: 'Integration handle from `login`.', required: true },
        {
          name: 'redirect-url',
          type: 'string',
          description: 'The URL the browser landed on. A bare ?code=…&state=… or a bare code also works.',
          required: true,
        },
      ],
      examples: [
        "ncl integrations complete --name dropbox-files --redirect-url 'http://127.0.0.1:8765/callback?code=abc&state=xyz'",
      ],
      handler: async (args) =>
        completeLogin({ name: String(args.name), redirectResponse: String(args['redirect-url']) }),
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof completeLogin>>;
        const lines = [
          `Connected "${d.name}".`,
          `Secret:   ${d.secretName} (${d.secretId})`,
          `Expires:  ${d.expiresAt ? formatLocalTime(d.expiresAt, TIMEZONE) : 'not stated by the server'}`,
          `Scopes:   ${d.scopes ?? '(not stated)'}`,
          d.grantedToGroup
            ? "Declared the secret in the group's container.json — it is granted on the next spawn."
            : "The secret was already declared in the group's container.json.",
        ];
        if (!d.hasRefreshToken) {
          lines.push(
            '',
            'WARNING: the server issued no refresh token, so this bearer cannot be renewed automatically.',
            "Re-run `login` with the provider's offline flag (Dropbox: --authorize-param token_access_type=offline;",
            'many servers: --scopes "<scopes> offline_access").',
          );
        }
        lines.push('', 'Restart the group to pick it up: ncl groups restart --id <agent-group-id>');
        return lines.join('\n');
      },
    },

    remove: {
      access: 'open',
      hostOnly: true,
      description:
        "Forget an integration: deletes the registry row and the host-side OAuth bundle. The OneCLI secret and the group's container.json declaration are left alone unless --delete-secret is given, because the secret may predate this integration and other requests may match on it.",
      args: [
        { name: 'name', type: 'string', description: 'Integration handle.', required: true },
        {
          name: 'delete-secret',
          type: 'boolean',
          description:
            "Also delete the OneCLI bearer secret. Remove it from the group's container.json first, or the next spawn fails closed.",
        },
      ],
      handler: async (args) =>
        removeIntegration(String(args.name), {
          deleteSecret: args['delete-secret'] === true || args['delete-secret'] === 'true',
        }),
    },

    refresh: {
      access: 'open',
      hostOnly: true,
      description:
        'Run the refresh pass the host sweep runs every 60 seconds, now. Refreshes every active integration inside its expiry margin; reports which were refreshed, which failed, and which need a fresh login.',
      args: [],
      handler: async () => refreshExpiringMcpOAuthIntegrations(),
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof refreshExpiringMcpOAuthIntegrations>>;
        return [
          `due: ${d.checked}`,
          `refreshed: ${d.refreshed.join(', ') || '(none)'}`,
          `failed: ${d.failed.join(', ') || '(none)'}`,
          `needs login: ${d.needsLogin.join(', ') || '(none)'}`,
        ].join('\n');
      },
    },
  },
});
