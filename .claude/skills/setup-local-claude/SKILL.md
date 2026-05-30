---
name: setup-local-claude
description: Installs a `claude-ws <workstream>` launcher so local Claude Code (host or laptop) gets the same third-party credential + MCP access a NanoClaw container agent has, scoped per workstream through the OneCLI gateway. Use this skill whenever the user wants to run Claude Code locally with their agents' credentials, mirror or replicate container access on their own machine, move Claude work off the container or Agent SDK onto the local CLI, give the local CLI a group's GitHub/Linear/Atlassian/Snowflake access, or mentions "claude-ws", "local claude access", or "container parity locally". Requires OneCLI.
---

# setup-local-claude

Installs `claude-ws <workstream>` — a launcher that runs **local Claude Code**
with the same third-party credential + MCP access a NanoClaw **container agent**
has, scoped to each workstream's OneCLI vault identity (the same way each
Slack/Discord channel maps to its own agent identity).

```
claude-ws madison-reed
claude-ws illysium -p "summarize the current Linear cycle"
claude-ws --list
```

## What it replicates (and what it deliberately doesn't)

A container agent's "access" is five separable layers. This skill mirrors the
two that matter for local work and intentionally leaves the rest:

| Layer | Container agent | claude-ws |
|---|---|---|
| **Anthropic model auth** | vault/forwarded token, `api.anthropic.com` bypassed | **Your local subscription login** — the shim unsets the injected token and bypasses `api.anthropic.com`, so Claude uses your `/login` account |
| **3rd-party creds** (GitHub, Linear, Atlassian, Snowflake, Datafold, Gmail…) | OneCLI gateway injects at the proxy boundary, per identity | **Identical** — `onecli run --agent <id>` points the same proxy + CA at the same gateway, same identity |
| **MCP servers** | per-group + universal set | universal set (exa, linear, deepwiki, pocket, context7) via `--mcp-config`; creds injected per identity |
| Skills / CLAUDE.md / workspace / memory | mounted per group | not replicated — your normal local config + the project repo |
| Host guardrails (approvals, destructive-guard, mnemon, isolation) | yes | **no, by design** — you're the operator at your own keyboard |

"Exactly the same" applies to **creds + MCP**. Model auth is intentionally
different and simpler (native subscription login — the path Anthropic's
SDK-on-subscription deprecation doesn't affect).

## Prerequisites

- **OneCLI installed and the gateway running.** Check: `onecli version` and
  `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10254` → `200`.
  If not installed, run `/init-onecli` first.
- **Claude Code installed** and logged into the user's subscription
  (`claude` → `/login`).
- **node** on PATH (used by the launcher to read the map).
- Run this skill from the **NanoClaw repo root** (needs `groups/*/container.json`).

## Installation

Do these steps. `${CLAUDE_SKILL_DIR}` is this skill's directory.

### 1. Confirm prerequisites

```bash
command -v onecli >/dev/null && echo "onecli: ok" || echo "onecli: MISSING — run /init-onecli"
command -v claude >/dev/null && echo "claude: ok" || echo "claude: MISSING"
command -v node   >/dev/null && echo "node: ok"   || echo "node: MISSING"
curl -s -o /dev/null -w 'gateway_http=%{http_code}\n' http://127.0.0.1:10254
```
If the gateway isn't `200`, stop and get OneCLI running (`/init-onecli`).

### 2. Create install dirs and copy the kit

```bash
mkdir -p ~/.config/claude-ws ~/.local/bin
cp "${CLAUDE_SKILL_DIR}/scripts/parity-shim.sh" ~/.config/claude-ws/parity-shim.sh
cp "${CLAUDE_SKILL_DIR}/scripts/mcp.json"       ~/.config/claude-ws/mcp.json
cp "${CLAUDE_SKILL_DIR}/scripts/claude-ws"      ~/.local/bin/claude-ws
chmod +x ~/.config/claude-ws/parity-shim.sh ~/.local/bin/claude-ws
```

### 3. Generate the workstream → identity map

Reads every `groups/*/container.json` and maps folder name → `agentGroupId`.
Excludes `*-codex` / `*-opencode` siblings by default (those are other-provider
agents; for local *Claude* you want the Claude/parent groups):

```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-workstreams.mjs" > ~/.config/claude-ws/workstreams.json
cat ~/.config/claude-ws/workstreams.json
```

Show the user the generated map and confirm it's the set of workstreams they
want. Edit `~/.config/claude-ws/workstreams.json` to rename keys (the key is what
they'll type after `claude-ws`) or drop entries. Each value must be the OneCLI
agent **identifier** that exists in the vault — verify with `onecli agents list
--max 80`. (Pass `--include-siblings` to the generator to also map codex/opencode
groups, but those identities run in `all` secret mode for some groups.)

### 4. Ensure `~/.local/bin` is on PATH

```bash
case ":$PATH:" in *":$HOME/.local/bin:"*) echo "on PATH";; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; echo "added to ~/.bashrc — restart shell or source it";; esac
```
On zsh, append to `~/.zshrc` instead.

### 5. Verify end-to-end

Plumbing (launcher → onecli run → shim → claude):
```bash
claude-ws "$(node -e 'console.log(Object.keys(require(process.env.HOME+"/.config/claude-ws/workstreams.json"))[0])')" --version
```

Credential injection is **scoped per identity** and the gateway matches on
**host pattern**, so smoke-test against the actual product host a workstream's
secret targets (NOT a generic api host). Pick a workstream that has a known
secret (e.g. the group whose `container.json` lists `Atlassian`) and:
```bash
ID=$(node -e 'const m=require(process.env.HOME+"/.config/claude-ws/workstreams.json");process.stdout.write(m["<that-workstream>"])')
onecli run --agent "$ID" -- curl -sS -o /dev/null -w 'http=%{http_code}\n' https://<product-host>/<auth-checking-path>
```
`200`/`405` with injection vs `401` without (try the default agent for contrast)
confirms the credential is being injected. A real model call also proves the
subscription-login path:
```bash
claude-ws <workstream> -p "Reply with exactly: works"
```

## Usage

```
claude-ws <workstream> [claude args...]   # cd into your project first
claude-ws --list                          # show configured workstreams
```
`CLAUDE_WS_DIR` overrides the config dir (default `~/.config/claude-ws`).

## How it works

1. `claude-ws <ws>` looks up the identity in `workstreams.json`.
2. `onecli run --agent <id>` exports `HTTPS_PROXY`/`HTTP_PROXY` → the gateway,
   the OneCLI CA into the standard CA vars, `AOC_AGENT`/`AOC_ACCESS_TOKEN`, and a
   `CLAUDE_CODE_OAUTH_TOKEN`, then execs `parity-shim.sh`.
3. `parity-shim.sh` (mirrors `src/container-runner.ts` ~L2444-2521):
   - **unsets** `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`/… and adds
     `api.anthropic.com` to `NO_PROXY` → model traffic uses your subscription login;
   - adds `PIP_CERT`/`AWS_CA_BUNDLE` + container-runner's other `NO_PROXY`
     bypasses (github, snowflake, aws, pypi, chatgpt);
   - execs `claude --mcp-config mcp.json "$@"` (merges with existing MCP config).

## Second machine (MacBook etc.)

See `${CLAUDE_SKILL_DIR}/references/mac-setup.md` — install a local gateway, or
SSH-tunnel to the host gateway. The kit files are `$HOME`-relative and portable.

## Troubleshooting

- **`onecli not found` / gateway not 200** → install/start OneCLI (`/init-onecli`).
- **401 on a service** the workstream should have → the identity needs that secret
  assigned (`onecli agents list` shows `selective` mode; assign via the UI at
  http://127.0.0.1:10254 or `onecli agents set-secrets`). Remember the gateway
  matches on **host pattern** (e.g. `<tenant>.atlassian.net`, not
  `api.atlassian.com`) — test the right host.
- **Model calls fail / wrong account** → confirm `claude` is logged in (`/login`);
  the shim handles the token-unset + `api.anthropic.com` bypass.
- **`unknown workstream`** → check `claude-ws --list`; edit `workstreams.json`.
- Smoke-test injection without launching Claude:
  `onecli run --agent <id> -- curl -sS -o /dev/null -w '%{http_code}\n' <api-url>`
