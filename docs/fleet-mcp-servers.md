# Fleet MCP defaults

Adding an MCP server to every agent group is one command. It is not a code change, and it has never
needed a host restart:

```bash
ncl groups config add-mcp-server --fleet \
  --name littlebird --url https://mcp.littlebird.ai/mcp \
  --display-name Littlebird \
  --description 'Littlebird workspace: meetings, transcripts, routines, conversations, search. Auth injected by the OneCLI gateway (vault secret Littlebird).'
```

That writes `data/fleet-mcp-servers.json` (`{ "version": 1, "mcpServers": { … } }`), which every
container inherits at its next spawn. `ncl groups config get --fleet` prints the file;
`ncl groups config remove-mcp-server --fleet --name <n>` takes one out. A stdio server works the same
way with `--command` / `--args` / `--env` instead of `--url`.

## What the agent is told

The capability snapshot describes **every MCP server the container actually gets** — fleet defaults
plus the group's own `container.json` entries — so a server the agent has is a server the agent knows
about. There is no second list to update:

- `--description` becomes the entry's `useFor` text verbatim.
- Without one, the agent gets a generic line naming the transport and saying the tools are
  self-describing under `mcp__<name>__*`. Nothing invents a purpose for the server.
- `--display-name` is the label (`DeepWiki`); absent, it is the server name capitalized.

Both fields are host-only metadata: `serializeMcpServersEnv` strips them before the map reaches a
container, so no provider ever sees them.

A handful of servers still carry hand-written capability text in `src/capabilities.ts` — Linear,
Datafold, Atlassian, dbt-mcp, Looker. Those are gated on `tools` **and** on scoped host credentials
the spawn resolves, so their entry says something the stored config cannot; an entry whose
`mcpNamespace` is `mcp__<name>__*` owns that server's text and the derived path skips it.

## Precedence

1. The group's own `container.json` `mcpServers` entry wins for that name — always, including over a
   fleet entry of the same name.
2. Otherwise the fleet entry applies.
3. `excludeMcpServers` in a group's `container.json` withholds an **inherited** entry. It never
   removes one the group declares itself.

That is the same `canInject` rule the per-name blocks in `buildContainerArgs` used, now in one
function (`effectiveMcpServers`, `src/fleet-mcp-servers.ts`) that both the spawn path and the
capability snapshot call.

## Credentials

Never in this file. A remote entry carries the `onecli-managed` placeholder header, or no auth at
all, and the OneCLI gateway substitutes the real secret at the proxy boundary — the same model as
every other credential here. For a server behind OAuth, mint the bearer with
[`ncl integrations login`](mcp-oauth-integrations.md) and grant the secret per workgroup:

```bash
ncl integrations login --name littlebird --url https://mcp.littlebird.ai/mcp \
  --group <agent-group-id> --secret Littlebird \
  --scopes 'littlebird:mcp openid email offline_access'
pnpm exec tsx scripts/set-workgroup-secrets.ts <workgroup-id> --secrets <existing...>,Littlebird
```

`data/fleet-mcp-servers.json` lives under `DATA_DIR`, which is never bind-mounted into a container.

## Fresh installs and the shipped defaults

Until someone runs a `--fleet` command, there is no file: the defaults in
`DEFAULT_FLEET_MCP_SERVERS` (`src/fleet-mcp-servers.ts`) apply — granola, deepwiki, context7, exa,
pocket, littlebird — which is exactly the set `buildContainerArgs` used to hardcode. The first
`--fleet` write materializes the file from those defaults plus the change. Editing that constant is
not how a tool is added; it is only the seed.

A malformed file throws rather than falling back, on the spawn path and in the snapshot alike:
silently dropping every group's tools is worse than a loud failure the sweep retries.

## `--fleet` and agents

`--fleet` is refused for a `cli_scope: group` agent (`src/cli/guard.ts`), read and write alike: a
group-scoped agent cannot change — or enumerate — what every other group runs. A `global`-scope
agent's request still goes through the usual admin approval that `config add-mcp-server` carries.

## Migrating a per-group entry to the fleet

A group entry that duplicates a fleet entry is harmless — precedence rule 1 means the group's copy is
used, and if the two are identical nothing changes. To tidy up afterwards:

```bash
for id in $(ncl groups list --json | jq -r '.[].id'); do
  ncl groups config remove-mcp-server --id "$id" --name littlebird 2>/dev/null
done
```

`remove-mcp-server` fails on a group that never had the entry, which is why the loop ignores that
error. The groups keep the server — they now inherit it.
