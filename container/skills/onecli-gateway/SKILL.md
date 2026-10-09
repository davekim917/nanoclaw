---
name: onecli-gateway
description: >-
  OneCLI Gateway: transparent HTTPS proxy that injects stored credentials
  into outbound calls. You MUST use this skill when the user asks you to
  read emails, check calendar, access GitHub repos, create issues, check
  Stripe payments, or interact with ANY external service or API. Do NOT
  use browser extensions or OAuth CLI tools. Make HTTP requests directly;
  the gateway injects credentials automatically. On a 401, 403, or gateway
  error, the error code decides: a missing API key (credential_not_found,
  carries a secret_url) ALWAYS goes to `ncl secrets intake`, which posts the
  secure entry form; never show the user a secret_url or a link for a key.
  Only an OAuth app's app_not_connected gets its connect_url, shown as a bare
  URL on its own line so they can click to connect.
compatibility: Requires HTTPS_PROXY set in environment (automatic when launched via `onecli run`)
metadata:
  author: onecli
  version: "0.5.0"
---

# OneCLI Gateway

Your outbound HTTPS traffic is transparently proxied through the OneCLI
gateway, which injects stored credentials at the proxy boundary. You never
see or handle credential values directly.

## How to Access External Services

You have direct HTTP access to external APIs. OAuth apps (Gmail, GitHub,
Google Calendar, Google Drive, etc.) and API key services are all available
through the gateway. Just make the request directly; the gateway injects
credentials if the app is connected. If not, it returns an error whose code
says what is missing (see When a Request Fails). Use any method that makes an HTTP
request — curl, Python, a CLI tool, whatever fits; if a tool insists on a
locally-configured credential, pass any placeholder value, since the proxy
replaces it with the real credential at request time.

**A missing `<SERVICE>_API_KEY` env var is normal, not a missing
credential.** Gateway-injected keys never enter the container, so their
absence is not evidence the service is unavailable. Do not fall back to a
stub or local stand-in; call the service first. TypeSafe (Jev,
`api.typesafe.ai`) is one: call it directly, and if its SDK requires an
`api_key`, pass a placeholder.

**Exception — services with a mounted credential file use their own CLI,
not the proxy.** Check `get_capabilities` first. Google Workspace
(Gmail/Calendar/Drive) is the main one: use `gws` with the account file and
env var shown there. A OneCLI `app_not_connected` for such a service does
not mean you lack access — it means you're calling the wrong surface.

## Making Requests

Call the real API URL. The gateway intercepts the request and injects
credentials automatically.

```bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
curl -s "https://api.github.com/user/repos?per_page=10"
curl -s "https://api.stripe.com/v1/charges?limit=5"
```

Standard HTTP clients (curl, fetch, requests, axios, Go net/http, git) all
honor the `HTTPS_PROXY` environment variable automatically. You do not need
to set any auth headers.

## Credential Stubs for MCP Servers

Some MCP servers need local credential files to start. Stubs for connected
apps are pre-written automatically. Files containing `"onecli-managed"`
values are managed by OneCLI — do NOT modify or delete them.

If an MCP server won't start due to missing credentials, create stubs
**before** starting it. Use `"onecli-managed"` as the placeholder for all
secret values, with file permissions `0600`. See the guide at:
https://www.onecli.sh/docs/guides/credential-stubs/general-app

## When a Request Fails

If you get a 401, 403, or a gateway error, the error code says which case
you are in:

- **`credential_not_found`** (body has a `secret_url`): the vault has no key
  for this host. Run `ncl secrets intake` (next section). Never show the
  `secret_url`: it opens the OneCLI dashboard on the host, which the user
  usually cannot reach from chat, and it is not the secure form.
- **`access_restricted`** (body has a `manage_url`): the key exists but this
  agent is not granted it. Run `ncl secrets grant --name <vault name>`,
  which waits for an admin's approval; the grant reaches you at your next
  container start. Never show the `manage_url`.
- **`app_not_connected`** (body has a `connect_url`): an OAuth app (Gmail,
  GitHub, Google Calendar, ...) is not connected. Show the `connect_url` as
  a bare URL on its own line — no angle brackets, no markdown link syntax —
  so it's clickable as-is:

  > To connect [service], open this link:
  > https://example.com/connect/...

  If the URL's host is `localhost` or `127.0.0.1`, it opens only on the
  machine running OneCLI: say so, so the user connects the app from there
  instead of clicking a link that fails on their phone or laptop.

  Tell the user you will retry once they have connected. When they confirm,
  retry the original request. If the retry still fails, ask if they need
  help with the setup.

## Adding or Rotating an API Key

When a service needs a key the vault lacks, or the user wants to add or
rotate one, run `ncl secrets intake` (`ncl secrets help intake` for flags).
It posts a form into this conversation (Slack or Discord; anywhere else, an
owner's Slack DM) for an owner or an admin of your group to fill in. A
rotation goes to an owner's DM unless this is the owner's own conversation
with you. The value typed there goes straight to
the vault, and you are told when it is stored. Name the API host exactly
with `--host-pattern`: the gateway sends the key only there. For a
credential in parts, declare each secret part with `--field 'name|Label'`:
`--compose basic` for HTTP Basic or an OAuth client ID + secret at a token
endpoint; `--compose separate` when the API takes key and secret as separate
headers (`--field 'name|Label|Header'`, `?` after the name if optional); one
field otherwise. A non-secret part (user id, subdomain, account id) never
goes in the form: take it in chat or config. Never ask the user to run a
command to combine or encode a value. If the user pastes a key into chat anyway, do not
use or repeat it; tell them to rotate it, since chat history keeps it.

## Rules

- **Never** say "I don't have access to X" without first making the HTTP
  request through the proxy.
- **Never** use browser extensions, gcloud, or manual auth flows. The
  gateway handles credentials for you.
- **Never** ask the user for API keys or tokens in chat. A missing key
  always goes through `ncl secrets intake`; only an OAuth app uses its
  `connect_url`.
- **Never** build your own card, button, or link for entering a key.
  `ncl secrets intake` posts the only secure form.
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access. Use it.
- If the gateway returns a policy error (403 with a JSON body), respect
  the block. Do not retry or circumvent it.
