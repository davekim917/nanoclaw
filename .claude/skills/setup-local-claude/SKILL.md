---
name: setup-local-claude
description: Installs a `claude-ws <workstream>` launcher so local Claude Code (host or laptop) gets the same third-party credential + MCP access a NanoClaw container agent has, scoped per workstream through the OneCLI gateway. Use this skill whenever the user wants to run Claude Code locally with their agents' credentials, mirror or replicate container access on their own machine, move Claude work off the container or Agent SDK onto the local CLI, give the local CLI a group's GitHub/Linear/Atlassian/Snowflake access, set a teammate up with local Claude access, or mentions "claude-ws", "local claude access", or "container parity locally". Requires OneCLI.
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

`cd` into your project first, like normal `claude`.

## Two setup paths — pick one before you start

This skill is run interactively. Decide which person you're setting up:

- **Operator** — you run the NanoClaw host; the agent identities already live in
  your own OneCLI vault. You just need the launcher pointed at them. → **Path A**.
- **Teammate** — you do NOT run the host. You want local Claude Code with the
  same *kinds* of access, but under your **own** accounts and your **own** OneCLI
  vault. The wizard creates your identities and walks you through connecting your
  own apps. → **Path B**.

If unsure: do you have a `groups/` directory with `container.json` files AND those
agent identities in `onecli agents list`? Yes → operator. No → teammate.

## What it replicates (and what it deliberately doesn't)

A container agent's "access" is five separable layers. This skill mirrors the
two that matter for local work and intentionally leaves the rest:

| Layer | Container agent | claude-ws |
|-------|-----------------|-----------|
| **Anthropic model auth** | vault/forwarded token, `api.anthropic.com` bypassed | **Your local subscription login** — the shim unsets the injected token and bypasses `api.anthropic.com`, so Claude uses your `/login` account |
| **3rd-party creds** (GitHub, Linear, Atlassian, Snowflake, Datafold, Gmail…) | OneCLI gateway injects at the proxy boundary, per identity | **Identical mechanism** — `onecli run --agent <id>` points the same proxy + CA at the gateway, scoped to that identity's secrets |
| **MCP servers** | per-group + universal set | universal set (exa, linear, deepwiki, pocket, context7) via `--mcp-config`; creds injected per identity |
| Skills / CLAUDE.md / workspace / memory | mounted per group | not replicated — your normal local config + the project repo |
| Host guardrails (approvals, destructive-guard, mnemon, isolation) | yes | **no, by design** — you're the operator at your own keyboard |

Model auth is intentionally different and simpler (native subscription login —
the path Anthropic's SDK-on-subscription deprecation doesn't affect). A
teammate's creds are **their own**, not the operator's — each person's actions
are attributable to them.

## Prerequisites (both paths)

- **OneCLI installed and the gateway running.** Check: `onecli version` and
  `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10254` → `200`.
  If not installed, run `/init-onecli` first.
- **Claude Code installed** and logged into the user's subscription
  (`claude` → `/login`).
- **node** on PATH (the launcher reads the map with it).

Confirm all four before continuing:
```bash
command -v onecli >/dev/null && echo "onecli: ok" || echo "onecli: MISSING — run /init-onecli"
command -v claude >/dev/null && echo "claude: ok"  || echo "claude: MISSING"
command -v node   >/dev/null && echo "node: ok"    || echo "node: MISSING"
curl -s -o /dev/null -w 'gateway_http=%{http_code}\n' http://127.0.0.1:10254
```
If the gateway isn't `200`, stop and get OneCLI running (`/init-onecli`).

## Install the launcher files (both paths)

`${CLAUDE_SKILL_DIR}` is this skill's directory.
```bash
mkdir -p ~/.config/claude-ws ~/.local/bin
cp "${CLAUDE_SKILL_DIR}/scripts/parity-shim.sh" ~/.config/claude-ws/parity-shim.sh
cp "${CLAUDE_SKILL_DIR}/scripts/mcp.json"       ~/.config/claude-ws/mcp.json
cp "${CLAUDE_SKILL_DIR}/scripts/claude-ws"      ~/.local/bin/claude-ws
chmod +x ~/.config/claude-ws/parity-shim.sh ~/.local/bin/claude-ws
```
Ensure `~/.local/bin` is on PATH (zsh users: use `~/.zshrc`):
```bash
case ":$PATH:" in *":$HOME/.local/bin:"*) echo "on PATH";; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc; echo "added — restart shell";; esac
```

---

## Path A — Operator (you run the host)

Generate the map from your checkout's `groups/*/container.json` (folder →
`agentGroupId`, which already exists in your vault). Run from the repo root:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-workstreams.mjs" > ~/.config/claude-ws/workstreams.json
cat ~/.config/claude-ws/workstreams.json
```
Show the user the map, confirm it's the workstreams they want, and drop any keys
they don't need (the key is what they'll type after `claude-ws`). Each value must
be an identifier present in `onecli agents list --max 80`. (`--include-siblings`
also maps `*-codex`/`*-opencode`; those run in `all` secret mode for some groups.)

Then jump to **Verify** below.

---

## Path B — Teammate (own accounts, own vault)

The teammate's vault starts empty of these identities. The wizard's job: pick
workstreams, create each identity in *their* vault, connect *their* apps, write
their map. Walk through it conversationally — the teammate may not be technical,
so explain each step plainly and run the commands for them.

### B1. Discover the canonical workstreams + what each needs

Run against any NanoClaw checkout the teammate can read (or one you provide). The
`--teammate` flag makes the identifier the folder NAME (self-documenting in their
own vault); `--describe` lists the apps each workstream connects:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-workstreams.mjs" --teammate --describe > /tmp/ws-describe.json
cat /tmp/ws-describe.json
```
Each entry looks like `{ "identifier": "madison-reed", "secrets": [...], "tools": [...] }`.
The `secrets`/`tools` are the apps that workstream uses (GitHub, Linear,
Atlassian, Snowflake, Gmail, …) — your checklist for the OAuth walkthrough.

### B2. Let the teammate pick their workstreams

Ask which ones they actually work in — don't create identities they won't use.
Use `AskUserQuestion` with the discovered names. Keep only the chosen subset.

### B3. Create each chosen identity in their vault

For each chosen workstream `<ws>`, create an agent if it doesn't already exist:
```bash
onecli agents list --max 80 | grep -q '"identifier": "<ws>"' \
  || onecli agents create --name "<ws> (local Claude)" --identifier "<ws>"
```
Leave secret mode at the default `selective` — they'll connect only what they
need in the next step.

### B4. Connect each workstream's apps (the actual credential step)

For each chosen workstream, look at its `secrets`/`tools` from B1 and have the
teammate connect those apps in **their** OneCLI vault. The gateway is per-host,
so this is their own GitHub/Gmail/etc., not the operator's:

- Open the OneCLI dashboard: `http://127.0.0.1:10254` → Connections.
- For each app the workstream needs (e.g. GitHub, Gmail, Linear, Atlassian),
  click connect and complete that provider's OAuth as themselves.
- For API-key services (Snowflake, Datafold, Exa, …), paste their own key into
  the matching secret. If they don't have one, that workstream's tools for that
  service simply won't work until they do — that's expected, not an error.

Don't block on connecting everything — connect what they have, note the rest.

### B5. Write their map

Build `workstreams.json` from the chosen subset (identifier = folder name):
```bash
node "${CLAUDE_SKILL_DIR}/scripts/generate-workstreams.mjs" --teammate > /tmp/ws-all.json
# then keep only the chosen keys — e.g. with node/jq, or hand-write the subset:
cat > ~/.config/claude-ws/workstreams.json <<'JSON'
{
  "madison-reed": "madison-reed",
  "illysium": "illysium"
}
JSON
cat ~/.config/claude-ws/workstreams.json
```

Then continue to **Verify**.

---

## Verify (both paths)

Plumbing (launcher → onecli run → shim → claude):
```bash
claude-ws "$(node -e 'console.log(Object.keys(require(process.env.HOME+"/.config/claude-ws/workstreams.json"))[0])')" --version
```

Credential injection is **scoped per identity** and the gateway matches on
**host pattern**, so smoke-test against the real product host a workstream's
secret targets (NOT a generic api host). Pick a workstream with a connected app:
```bash
ID=$(node -e 'const m=require(process.env.HOME+"/.config/claude-ws/workstreams.json");process.stdout.write(m["<workstream>"])')
onecli run --agent "$ID" -- curl -sS -o /dev/null -w 'http=%{http_code}\n' https://<product-host>/<auth-path>
```
`200`/`405` with injection vs `401` without confirms it. A real model call proves
the subscription-login path:
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
- **401 on a service** → the identity lacks that secret. Operator: assign via the
  UI or `onecli agents set-secrets`. Teammate: connect the app at
  `http://127.0.0.1:10254` under that identity. Gateway matches on **host
  pattern** (e.g. `<tenant>.atlassian.net`, not `api.atlassian.com`) — test the
  right host.
- **Model calls fail / wrong account** → confirm `claude` is logged in (`/login`);
  the shim handles the token-unset + `api.anthropic.com` bypass.
- **`unknown workstream`** → check `claude-ws --list`; edit `workstreams.json`.
- Smoke-test injection without launching Claude:
  `onecli run --agent <id> -- curl -sS -o /dev/null -w '%{http_code}\n' <api-url>`
```
