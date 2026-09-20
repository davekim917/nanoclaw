# Remote MCP integrations (OAuth)

Connecting a remote MCP server — Dropbox, Amplitude, anything that answers `401` with
`WWW-Authenticate: Bearer resource_metadata="…"` — without creating a developer app or pasting an
API key. The host does what a first-party MCP client does: discovers the authorization server,
registers itself dynamically, runs an authorization-code flow with PKCE, and then keeps the access
token fresh on its own.

```
ncl integrations login --name <n> --url <mcp-url> --group <agent-group-id>
ncl integrations complete --name <n> --redirect-url '<the URL your browser landed on>'
ncl integrations list
ncl integrations refresh
ncl integrations remove --name <n> [--delete-secret]
```

## What it fixes

A remote MCP server authenticates with a short-lived OAuth access token. Before this, the operator
pasted one into a OneCLI header-injection secret by hand. When it expired the gateway kept injecting
the dead value — `status=401 injections_applied=1` in the gateway log — and the container's stdio
bridge died with `CONNECTION_CLOSED` on every spawn, until a human noticed and pasted a new one.

## Where each piece of state lives

| Thing                                          | Where                                                       | Why there                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access token (the bearer)                      | OneCLI secret, injected at the proxy                        | The container never sees a credential; this is the existing model                                                                                                                                                                               |
| Refresh token, client id/secret                | `data/mcp-oauth/<name>.json`, mode 0600 in a 0700 directory | OneCLI's API is **write-only** for secret values (see below), so a refresh token parked there could never be read back. The **access token is not here** — the exception covers what mints the next bearer, never a bearer that works right now |
| Endpoints, scopes, secret name, expiry, status | `mcp_oauth_integrations` (migration 082)                    | Metadata only — no token material, so `ncl integrations list` is safe to read and to share                                                                                                                                                      |

**Why the refresh token is not in OneCLI.** Verified against the live gateway on 2026-09-17,
`onecli@1.4.1`: `POST /api/secrets` → 201, `PATCH /api/secrets/{id}` with `{"value":…}` → 200
(leaving hostPattern / pathPattern / injectionConfig untouched), `DELETE /api/secrets/{id}` → 204.
There is **no read route**: `GET /api/secrets/{id}`, `…/value`, `…/reveal`, `?reveal=true` and
`?include=value` all 404 or return the same value-free listing. A refresher that cannot read its
refresh token cannot refresh. The precedent for holding it host-side is exact — the GitHub App
**private key** already sits on this host's filesystem at `GITHUB_APP_PRIVATE_KEY_PATH` and the host
mints short-lived installation tokens from it (`src/github-app-token.ts:227`). `DATA_DIR` itself is
never bind-mounted into a container; only named subpaths under it are, and `mcp-oauth/` is not one.

## Logging in

The host is headless and you reach it over ssh, so nothing here ever tries to open a browser — no
`xdg-open`, no `$DISPLAY`, no `BROWSER`. There are three ways in; the first needs no setup at all.

### 1. Paste (the default)

```bash
ncl integrations login --name amplitude-analytics \
  --url https://mcp.amplitude.com/mcp \
  --group <agent-group-id> \
  --secret Amplitude-MCP-Analytics
```

It prints an authorization URL. Open that **on your own machine**. Approve. Your browser will fail
to load the redirect (`http://127.0.0.1:8765/callback?code=…`) — that is expected, nothing is
listening there. Copy the whole URL out of the address bar:

```bash
ncl integrations complete --name amplitude-analytics \
  --redirect-url 'http://127.0.0.1:8765/callback?code=abc123&state=xyz'
```

A bare `?code=…&state=…` or a bare code works too. A login is a once-per-integration event, which is
why the simplest thing that always works is the default.

### 2. `--listen` (optional, needs an ssh tunnel)

Add `--listen` and the host also binds `127.0.0.1:8765`. That port is only reachable from your
laptop if you forward it, so open a second terminal and run — verbatim, both sides the same port:

```bash
ssh -L 8765:127.0.0.1:8765 <user>@<host>
```

With the tunnel up, approving in the browser completes the login by itself; confirm with
`ncl integrations list`. The paste path stays open alongside it, so a tunnel you forgot to open
costs nothing. `--port <n>` moves both the redirect URI and the listener together (they must match).
`--listen-timeout <seconds>` defaults to 600. If the port will not bind, the command says so and you
paste instead.

Passing `--port` (or `--redirect-uri`) on a **re**-login changes the binding the authorization server
stored at registration, so the next `login` registers a new client rather than replaying one the
server would reject at the exchange. Leave both off and the re-login reuses the existing client.

### 3. `--device` (optional, only where the server publishes it)

RFC 8628 — a user code and a verification URL, no redirect at all. It needs
`device_authorization_endpoint` in the authorization server's metadata. **Neither first target
publishes one**: Amplitude does not list the grant at all, and Dropbox lists `device_code` in
`grant_types_supported` while publishing no endpoint to start it at. `--device` says exactly that
rather than guessing a URL; `--device-endpoint <url>` overrides it if you know the endpoint.

## Provider notes

**Dropbox** (`https://mcp.dropbox.com/mcp`) issues **no refresh token** unless the authorization
request carries `token_access_type=offline`, and nothing in its metadata says so:

```bash
ncl integrations login --name dropbox-files --url https://mcp.dropbox.com/mcp \
  --group <agent-group-id> --secret Dropbox-Files \
  --authorize-param token_access_type=offline
```

Its token endpoint is on `api.dropboxapi.com` while its issuer is `www.dropbox.com` — the two are
discovered and stored separately, never derived from each other.

**Amplitude** (`https://mcp.amplitude.com/mcp`) is its own authorization server. Its protected
resource advertises `mcp:read` and `mcp:write`; the AS also supports `offline_access`, which some
servers require before they will issue a refresh token — add it with
`--scopes 'mcp:read mcp:write offline_access'` if `complete` warns that none was issued.

If `complete` reports **"the server issued no refresh token"**, fix it now rather than later: that
bearer will expire and nothing can renew it.

**Littlebird** (`https://mcp.littlebird.ai/mcp`) is a fleet default — every group inherits it from
`data/fleet-mcp-servers.json` ([docs/fleet-mcp-servers.md](fleet-mcp-servers.md)), so the bearer has
to be granted to every workgroup, not just the one that logged in. Its authorization server publishes
`offline_access` while its protected resource does not, so ask for it explicitly or no refresh token
is issued and the bearer dies at its first expiry:

```bash
ncl integrations login --name littlebird --url https://mcp.littlebird.ai/mcp \
  --group <agent-group-id> --secret Littlebird \
  --scopes 'littlebird:mcp openid email offline_access'
# then, per workgroup — extend-only union, keep the existing names:
pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <existing...>,Littlebird
```

## Which secret it writes

The bearer goes into a OneCLI secret named `<Name>-MCP-<Group>` by default
(so an integration named `amplitude-analytics` on a group foldered `analytics` writes
`AmplitudeAnalytics-MCP-Analytics`). `--secret <name>` points it at a different one — use this to
**adopt** a secret you already created by hand, which is the usual case when a server was previously
wired up with a pasted token. Adopting updates the value in place and leaves the existing
host/path/header matching rule alone.

`complete` also appends the secret name to the group's `groups/<folder>/container.json`
`onecliSecrets`, because that declaration is what actually grants it: `applyOnecliSecrets` reconciles
the group's OneCLI agent to exactly the declared set on every spawn (`src/onecli-secrets.ts`). A
secret that exists in the vault but is missing from `container.json` is a secret the agent is not
granted, however fresh its value is.

**Restart the group afterwards** so the spawn path picks up the new declaration:

```bash
ncl groups restart --id <agent-group-id>
```

An already-running container does not need a restart for a later _refresh_ — the gateway injects the
new value on the next request.

## What it refuses

- **Anything cleartext.** Every URL this flow fetches — `--url` itself, the `resource_metadata` URL
  the server's 401 challenge advertises, the issuer it reads metadata from, the authorization, token,
  registration and device endpoints, and the verification URI a device login prints for you to open —
  must be `https` (RFC 8414 §2), whether it was discovered or supplied by `--issuer` /
  `--device-endpoint`. The issuer is the load-bearing one: metadata fetched over cleartext can be
  substituted wholesale, and every `https` endpoint inside a forged document would pass a per-endpoint
  check. There is no exemption, loopback included; the redirect is not fetched by this host at all —
  your browser resolves it. A cleartext `--url` is refused before anything is probed, and a cleartext
  `resource_metadata` URL from a challenge is skipped as a candidate, so the https well-known paths
  still get their turn.
- **An authorization server that does not own its own metadata.** RFC 8414 §3.3: the `issuer` in the
  metadata document must be identical — trailing slash aside — to the issuer URL the document was
  fetched for, and the field must be present. Without it, whoever controls `authorization_servers[0]`
  can hand back a document speaking for someone else, and that value is what the client-reuse check
  keys on.
- **A protected-resource document describing something else.** RFC 9728 §3.3: its `resource` must
  cover `--url`, matched by origin plus path prefix. Checked per candidate, like the two above, so a
  generic document on a shared origin is skipped rather than ending the probe. Prefix rather than equality because the live
  servers differ — Dropbox and Littlebird name `…/mcp` exactly, Amplitude names its origin while
  serving MCP under `/mcp`.
- **A second integration for the same group and URL.** Refused _before_ dynamic client registration:
  the row would hit `UNIQUE(agent_group_id, mcp_url)` anyway, and discovering that after registering
  leaves a client minted at the provider that nothing here can see or revoke.
- **A `plain` PKCE downgrade.** S256 or nothing, even where a server still advertises `plain`.
- **A path-traversing integration name.** Names are `[a-z0-9-]`, because a name is a file name.

## Staying fresh

`mcp-oauth-refresh` (FORK4) runs in the 60-second host sweep, `tick:housekeeping` order 27, right
after the two GitHub credential duties. Any `active` integration within 10 minutes of expiry gets a
new access token, PATCHed over the same OneCLI secret.

- **Refresh-token rotation** is persisted before the row is updated, so a server that reissues one on
  every refresh cannot lock the integration out.
- **`invalid_grant` / `invalid_client` / `unauthorized_client`** move the row to `needs_login`, log
  one WARN, and stop retrying. Only a fresh `login` clears it. The last two also condemn the
  _registration_, which is recorded on the bundle so the next `login` registers a new client instead
  of replaying the one the server just refused.
- **A rotated refresh token reaches disk before the OneCLI write**, which is the fallible step. A
  server that reissued one has already killed the old one, so the other order would turn a live grant
  into a forced human login on any gateway hiccup. The reverse failure — fresh credentials on disk, a
  stale bearer in OneCLI — parks the row in `error` and the next tick fixes it.
- **A OneCLI outage costs one grant, not one per minute.** When the token was minted and only the
  vault write failed, the access token is held in memory and the sweep retries _the write_ — never
  the grant — on a doubling backoff from 60 s to a 15-minute cap. Re-running the grant instead would
  rotate the refresh token once a tick for the length of the outage. If the outage outlives the
  parked token (it gets within the 10-minute refresh margin of its own expiry) the parked copy is
  dropped and a fresh grant is taken, because writing a dead bearer to the vault buys nothing. A host
  restart forgets the parked write and the next tick does a full refresh, which is correct — the
  refresh token on disk is current.
- **Two overlapping sweeps cannot both refresh one integration.** The decision to refresh is taken
  again inside the per-integration lock, against the re-read row; the pass that was queued behind
  finds the row no longer due and does nothing. Acting on the pre-lock snapshot would send a second
  grant carrying a refresh token the first one had already rotated away.
- **Anything else** leaves the row in `error` with the old bearer untouched. An `error` row is due
  on the **next tick regardless of its expiry** — the status is a statement about the last attempt,
  not about the token's clock — so a failure is retried in 60 seconds rather than when the token it
  could not deliver is nearly dead.
- **A narrowed grant is tracked.** If the server grants fewer scopes than were asked for, the row
  records the granted set and the next refresh asks for exactly that; re-sending the wider set reads
  as an attempt to widen the grant, which a strict server answers with `invalid_scope`.
- **No `expires_in`** from the server falls back to refreshing every 12 hours.

`ncl integrations refresh` runs the same pass on demand.

## One group per integration

An integration's `--group` is fixed at its first `login`. A re-login naming a different group is
refused, because moving it silently would point `complete` at the new group's `container.json` while
leaving the old group's declaration in place — and a declared secret is granted on every spawn, so
the old group would keep a live bearer, and on a shared `--secret` would keep receiving refreshed
ones. To move one: `remove` it, drop its secret from the old group's `container.json`
`onecliSecrets`, then log in under the new group — the same order `startLogin`'s own refusal prints.
Do **not** reach for `--delete-secret` here: a `--secret` may name a secret that predates the
integration and that other groups are granted (`Littlebird` on this install is exactly that), and
deleting it to move one integration takes it away from all of them.

## Removing one

```bash
ncl integrations remove --name dropbox-files
```

Deletes the registry row and the host-side bundle. The OneCLI secret and the `container.json`
declaration are left alone — the secret may predate the integration and other requests may match on
it.

```bash
ncl integrations remove --name dropbox-files --delete-secret
```

`--delete-secret` is **subtractive or nothing**. It refuses, deleting nothing, unless the owning
group's own `container.json` is the only thing that still depends on the bearer; when it is, it
drops the declaration there and *then* deletes the vault secret, both inside the per-integration
lock.

The refusal is the important half, because a declaration lives in two kinds of place and the spawn
takes their **union** — `workgroups.onecli_secrets` merged with the group's own
`onecliSecrets`, where neither list can subtract from the other. Deleting a secret that any
workgroup still declares aborts **every spawn of every group in that workgroup**, not just this
one; deleting one another group's `container.json` still names breaks that group. Two integrations
in one group can also share a `--secret`, and deleting it takes the credential the survivor needs.
So the command lists everything it found and what to do about it, and stops:

```
Refusing to delete "Littlebird": 7 other place(s) this command cannot edit still depend on it, and
deleting it would break them. Nothing was deleted.
  - workgroup main (workgroups.onecli_secrets) declares "Littlebird" — pnpm exec tsx scripts/set-workgroup-secrets.ts main --secrets <the list without "Littlebird">
  …
Clear those first, then run this again. To end the integration without touching the secret, use
`ncl integrations remove --name littlebird` on its own.
```

Both spellings a declaration can take are matched — the secret's name and its vault UUID, either of
which `onecliSecrets` accepts — because once the secret is gone, a leftover declaration in either
one fails the spawn the same way.

Why the owning group's own undeclare happens here rather than by hand first: every successful
refresh re-declares the bearer, so a refresh landing between a hand edit and this command
re-declares the name it is about to delete. The two run under one lock, so doing it here closes
that window. If the `container.json` write fails, nothing is deleted and the integration is left
exactly as it was; run the same command again once the file is writable.

**After a plain `remove`, drop the declaration yourself** unless you meant to keep the secret: a
name left in `onecliSecrets` — at either level — is re-granted on every spawn, so a bearer whose
integration is gone stays usable until someone edits it out.

Removal is serialized against the refresher. Every mutation of one integration — row, bundle file,
vault secret and, on `--delete-secret`, the owning group's `container.json` declaration — runs under
one per-name lock, so a removal that lands while a refresh is awaiting the token endpoint cannot be
undone by that refresh's continuation recreating the bundle, the secret or the declaration.

## Access

`login`, `complete`, `remove` and `refresh` are **operator-only** (`hostOnly`): an OAuth login mints
a credential for your account at a third party, and no `cli_scope` — not even `global` — makes that
appropriate for an agent to initiate. `list` and `get` are open; they carry no token material and
answer the question an agent hitting a 401 through its MCP bridge actually has. `integrations` is not
in `GROUP_SCOPE_RESOURCES`, so a group-scoped agent is refused it regardless.
