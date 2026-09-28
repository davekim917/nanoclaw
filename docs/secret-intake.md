# Secret intake

Adding or rotating an API key without the key passing through chat, a session DB, a log or argv. The agent
(or the operator's shell) handles every part except the value itself; an owner enters the value in a Slack form.

```
ncl secrets intake --name <n> --host-pattern <api-host> [--header <h>] [--value-format '<fmt with {value}>']
                   [--path-pattern <p>] [--field '<name>[?]|<Label>[|<Header>[|<Format>]]' …]
                   [--compose basic|separate] [--groups <ids>] [--workgroups <ids>]
ncl secrets intake --name <n> --rotate [--field '<name>|<Label>' … --compose …] [--groups …] [--workgroups …]
ncl secrets intake-status --id <si-…>
ncl secrets grant --name <n> [--groups <ids>] [--workgroups <ids>]
```

## Flow

1. `intake` validates the name, the injection rule and the grant targets, checks the vault (a new name must
   not exist; a rotation must), and posts a card. An agent's request goes into the conversation and thread it
   was asked from; a host request, or an agent session with no conversation, goes to the first reachable owner
   or global admin DM (`pickOwnersFirst` → `pickApprovalDelivery`). The card states who asked, the host the key
   will be sent to, who gets it, and who may enter it. The call returns at once with an intake id.
2. The card's button (`ncs:<intakeId>`) opens a Slack modal, private to whoever clicked it: others in the channel
   see the card, never the value. Opening refuses a clicker with no authority when the central DB lease answers
   within a second, and otherwise lets the click through; nothing waits past Slack's 3-second trigger window.
3. Submit validates each field (non-empty, no whitespace), claims the intake and closes the modal. Only then does the host
   check authority (below); a refused submit stores nothing, returns the intake to pending, and says why in
   the card's conversation. The vault write and grants follow: `POST /api/secrets` for a new secret, `PATCH` of the
   value for a rotation — through `src/onecli-secret-writer.ts`, which keeps the value out of argv. Any failure
   before the store completes marks the intake failed, on the card and to the requester.
4. The card is edited to the outcome, and the requesting agent session (if any) gets a host note: stored or
   not, and who it is granted to. The value never appears in either.

## Credentials in parts

With no `--field` the form has one field and the value is the secret. Declare 1–5 fields to ask for more;
each field is required unless its name ends in `?`. `--field` is repeatable (the `ncl` parsers keep every
occurrence of a flag declared `multiple`; any other flag given twice is refused rather than last-one-wins).

- `--compose basic`: exactly two required fields, stored as one secret, base64 of `<first>:<second>`
  (RFC 7617; the first may not contain a colon), `--value-format` default `Basic {value}`. For HTTP Basic and
  OAuth client credentials sent as `client_secret_basic`.
- `--compose separate` (the default for two or more fields): each field is its own secret `<name>-<field>`
  with its own header, `--field 'name|Label|Header[|Format]'` (format default `{value}`); `--header` and
  `--value-format` are refused. Headers must differ. A blank optional field stores nothing. Grants apply to
  every secret stored. If one write fails after another succeeded, the intake fails naming what was
  written; a group admin's partial store still sends the owner notice. On a create, the written secrets are
  ungranted: request each missing one as a single-field intake under its full name (`<name>-<field>`) and
  grant the rest with `ncl secrets grant`. On a rotation the written values are already live, so the pair
  may be mismatched until the missing field is rotated.

A rotation repeats the field names (and `--compose`) without headers, since the vault's values are
write-only and the form cannot tell their shape. Every named secret must exist. A separate rotation marks
every field optional and replaces only those filled in; a basic rotation needs both.

Only secret values go in the form. A part that is not secret (a user id, subdomain, account id) belongs in
chat or config. No step asks the user to encode or join anything themselves.

## Who may enter a secret

- An **owner or global admin**: any intake.
- An **admin of the requesting agent's group** (`user_roles` scoped admin): that agent's new secrets. Enable a
  user by granting them admin on the group. Plain group members cannot.
- **Rotation is owner or global admin only.** A rotation changes the value every holder uses, and who holds a
  secret is decided by OneCLI agent grants, some made outside any `container.json` or workgroup declaration —
  so no declaration scan can prove a secret is the workgroup's alone.

Every store by a group admin sends an owner a DM, right after the vault write and before any other follow-up,
naming who, which secret, the host and the grants — never the value. A failed notice is logged at error. A key
a group admin stores for their workgroup is used by every agent in it.

A card goes into the requesting thread only for an agent's new secret on Slack, the one platform whose adapter
opens the form. A rotation (which only an owner can fill), a host request, and any other origin get it in the
first owner or global admin with a Slack DM.

## What to check on the card

The **host pattern**: one exact host, no wildcards. The gateway injects the key into any request to that host,
so a wrong or hostile host gets the key. It is the one decision the form cannot make for you.

## Grants

Grants are by name: a group's `container.json` `onecliSecrets` (`declareGroupSecret`,
`src/onecli-secret-grants.ts`) or a workgroup's `onecli_secrets` (`addWorkgroupOnecliSecret`). They are
written only after the vault write succeeds, because a declared name missing from the vault aborts every
spawn that inherits it. A new grant takes effect at the group's next container start; a rotation takes
effect on the next request.

An agent may grant only to its own group and its own workgroup. With no target, a new secret goes to its own
group and a rotation grants nothing new.
`grant` from an agent is held for admin approval (it changes who holds a credential without a form to
consent through); from the host it runs directly.

## Limits

- Pending intakes are in memory: a host restart drops them, and an old card's button answers "expired".
  Expiry is 24 hours. A new request for the same secret from the same session (or the host) replaces its own
  pending card; anyone else's pending request for it refuses the new one. Finished intakes stay visible to `intake-status` for an hour.
- Built and tested for Slack. Elsewhere it depends on the adapter's modal support; where there is none, the
  button says so.
- The value crosses Slack's servers as a form submission. It is never a message, so it is not in channel
  history, but Slack does handle it — weaker than a page served from this host, far stronger than chat.
- With `CHAT_SDK_DEBUG` set, a Slack adapter in webhook mode (no app token) logs raw request bodies, form
  submissions included. Socket mode does not. Leave it unset on a webhook-mode install.
- Website logins (a password typed into a web page) are out of scope; the gateway injects headers into API
  requests, not form fields.
