---
name: new-setup
description: End-to-end NanoClaw setup for any user regardless of technical background — from zero to a named agent reachable on a real messaging channel, with sensible defaults and every post-verification step skippable.
allowed-tools: Bash(bash setup.sh) Bash(bash setup/probe.sh) Bash(bash setup/install-node.sh) Bash(bash setup/install-docker.sh) Bash(bash setup/install-telegram.sh) Bash(bash setup/install-telegram.sh:*) Bash(pnpm exec tsx setup/index.ts:*) Bash(pnpm exec tsx scripts/init-first-agent.ts:*) Bash(pnpm run chat) Bash(pnpm run chat:*) Bash(open -a Docker) Bash(sudo systemctl start docker) Bash(node --version) Bash(tail:*) Bash(head:*) Bash(grep:*)
---

# NanoClaw setup

Purpose of this skill is to take any user — technical or not — from zero to a named agent wired to a real messaging channel in the fewest steps possible.

The flow has two halves:

- **Steps 1–6 — required.** Prerequisites, credential, service start, end-to-end ping. These run straight through.
- **Steps 7–12 — skippable.** Naming, channel wiring, QoL. Every step here is skippable: if the user says "skip", "not now", "later", or similar, move on without complaint. If they say they're done at any point, stop cleanly — don't push the remaining steps.

Before each step, narrate to the user in your own words what's about to happen — one short, friendly sentence, no jargon. Don't read a scripted line; use the step context below to speak naturally.

Each step is invoked as `pnpm exec tsx setup/index.ts --step <name>` and emits a structured status block Claude parses to decide what to do next.

Start with a probe: a single upfront scan that snapshots every prerequisite and dependency. The rest of the flow reads this snapshot to decide what to run, skip, or ask about — no per-step re-checking. The probe is pure bash (`setup/probe.sh`) with no external deps so it runs correctly before Node has been installed.

## Current state

!`bash setup/probe.sh`

## Flow

Parse the probe block above. For each step below, consult the named probe fields and skip, ask, or run accordingly. The probe always returns a real snapshot — there is no "node not installed" fallback; `HOST_DEPS=missing` is how you know Node/pnpm haven't been bootstrapped yet.

## Ordering and parallelism

Run steps sequentially by default: invoke the step, wait for its status block, act on the result, move to the next.

One permitted parallelism:

- **Step 2 (container image build) and step 3 (OneCLI install)** are independent — they may start together in the background.
- **Step 4 (auth) must NOT start until step 3 has completed.** Auth writes the secret into the OneCLI vault; if OneCLI isn't installed and healthy yet, the user gets asked for a credential the system can't store. Do not open an `AskUserQuestion` for step 4 while OneCLI is still installing.
- Step 2's image build may continue running past step 4 — the image isn't consumed until step 6 (first CLI agent). Join before step 6.

### 1. Node bootstrap

Check probe results and skip if `HOST_DEPS=ok` — Node, pnpm, `node_modules`, and `better-sqlite3`'s native binding are already in place.

If `HOST_DEPS=missing` and `node --version` fails (Node isn't installed at all), run `bash setup/install-node.sh` **before** `bash setup.sh` — the script handles both macOS (via `brew`) and Linux/WSL (NodeSource + apt). It's idempotent and short-circuits when node is already on PATH.

Then run `bash setup.sh`. If Node is already present and only `HOST_DEPS=missing`, run `bash setup.sh` directly — deps just haven't been installed yet.

Parse the status block:

- `NODE_OK=false` → Node install didn't take effect (PATH issue, keg-only formula, etc.). Investigate `logs/setup.log`, resolve, re-run.
- `DEPS_OK=false` or `NATIVE_OK=false` → Read `logs/setup.log`, fix, re-run.

> **Loose command:** `bash setup.sh`. Justification: pre-Node bootstrap. Can't call the Node-based dispatcher before Node and `pnpm install` are in place.

### 2. Docker

Check probe results and skip if `DOCKER=running` AND `IMAGE_PRESENT=true`.

**Runtime:**
- `DOCKER=not_found` → Docker is missing — install it so agent containers have an isolated place to run. Run `bash setup/install-docker.sh` (handles macOS via `brew --cask` and Linux via the official get.docker.com script, and adds the user to the `docker` group on Linux). On Linux the user may need to log out/in for group membership to take effect. On macOS, launch Docker afterwards with `open -a Docker`.
- `DOCKER=installed_not_running` → Docker is installed but the daemon is down — start it.
  - macOS: `open -a Docker`
  - Linux: `sudo systemctl start docker`

Wait ~15s after either, then proceed.

> **Loose commands:** `open -a Docker`, `sudo systemctl start docker`. Justification: daemon-start is a one-liner per platform, not worth wrapping. The actual install (which had the unmatchable `curl | sh` pattern) is now inside `setup/install-docker.sh`.

**Image (run if `IMAGE_PRESENT=false`):** build the agent container image — takes a few minutes the first time, one-off cost.

`pnpm exec tsx setup/index.ts --step container -- --runtime docker`

### 3. OneCLI

Check probe results and skip if `ONECLI_STATUS=healthy`.

OneCLI is the local vault that holds API keys and only releases them to agents when they need them.

`pnpm exec tsx setup/index.ts --step onecli`

### 4. Anthropic credential

Check probe results and skip if `ANTHROPIC_SECRET=true`.

The credential never travels through chat — the user generates it, registers it with OneCLI themselves, and the skill verifies.

**4a. Pick the source.** `AskUserQuestion`:

1. **Claude subscription (Pro/Max)** — "Generate a token via `claude setup-token` in another terminal."
2. **Anthropic API key** — "Use a pay-per-use key from console.anthropic.com/settings/keys."

**4b. Wait for the user to obtain the credential.** For subscription, have them run `claude setup-token` in another terminal. For API key, point them to the console URL above. Either way, they keep the token — just confirm when they have it.

**4c. Pick the registration path.** `AskUserQuestion` — substitute `${ONECLI_URL}` from the probe (or `.env`):

1. **Dashboard** — "Open ${ONECLI_URL} in a browser; add a secret of type `anthropic`, value = the token, host-pattern `api.anthropic.com`."
2. **CLI** — "Run in another terminal: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

Wait for the user's confirmation. If their reply happens to include a token (starts with `sk-ant-`), register it for them: `pnpm exec tsx setup/index.ts --step auth -- --create --value <TOKEN>`.

**4d. Verify.**

`pnpm exec tsx setup/index.ts --step auth -- --check`

If `ANTHROPIC_OK=false`, the secret isn't there yet — ask them to retry, then re-check.

### 5. Service

Check probe results and skip if `SERVICE_STATUS=running`.

Start the NanoClaw background service — it relays messages between the user and the agent.

`pnpm exec tsx setup/index.ts --step service`

### 6. Wire a scratch CLI agent and verify end-to-end

**Do not narrate this step.** No "creating your first agent…", no "sending a ping…" chatter. The user's experience here is: they finished the last visible step (service), then a single success line appears. Wiring is an implementation detail at this point, not a user-facing milestone.

If step 2's container build is still running in the background, join it here before proceeding — the agent needs the image.

Use `INFERRED_DISPLAY_NAME` from the probe silently. **Do not ask the user.** The CLI agent at this stage is a scratch agent whose only purpose is to verify the end-to-end pipeline (host → container → agent → back). The user's real name capture happens in step 7.

Run wiring and ping back-to-back, silently:

```
pnpm exec tsx setup/index.ts --step cli-agent -- --display-name "<INFERRED_DISPLAY_NAME>"
pnpm run chat ping
```

First container spin-up takes ~60s. When the agent's reply arrives, emit exactly one line to the user:

> Test Agent success, proceeding with setup

If `pnpm run chat ping` times out or errors, tail `logs/nanoclaw.log`, diagnose, and fix — don't surface a half-success.

> **Loose command:** `pnpm run chat ping`. Justification: this is the same command the user will keep using after setup, so verification and the real channel are one and the same.

### 7. What should the agent call you?

Plain-prose ask (do **not** use `AskUserQuestion`):

> What should your agent call you? (Default: `<INFERRED_DISPLAY_NAME>`)

Capture the answer into a local variable `OPERATOR_NAME`. **Don't persist yet** — this value is consumed by step 10's channel wiring. If the user skips or confirms the default, set `OPERATOR_NAME = INFERRED_DISPLAY_NAME`.

### 8. What's your agent's name?

Plain-prose ask:

> What would you like to call your agent? (Default: `<OPERATOR_NAME>`)

Capture as `AGENT_NAME`. If skipped, set `AGENT_NAME = OPERATOR_NAME`. Nothing persisted yet.

### 9. Timezone

Run `pnpm exec tsx setup/index.ts --step timezone` and parse the status block.

- **RESOLVED_TZ is `UTC` or `Etc/UTC`** — before leaving UTC in `.env`, confirm with `AskUserQuestion`:

  - **Question**: "Your system reports UTC as the timezone. Is that right, or are you somewhere else?"
  - **Header**: "Timezone"
  - **Options**:
    1. `Keep UTC` — "Leave timezone as UTC."
    2. `I'm somewhere else` — "I'll name the IANA zone (e.g. `America/New_York`, `Europe/London`, `Asia/Tokyo`) via Other."

  If they pick "I'm somewhere else" (or type an IANA zone via Other), re-run `pnpm exec tsx setup/index.ts --step timezone -- --tz <answer>` to overwrite `.env`. If they keep UTC or skip, leave UTC in place.

- **NEEDS_USER_INPUT=true** — autodetection failed. Use `AskUserQuestion` with the same two options above (reword the question to "Autodetection failed — what timezone are you in?"), then re-run `pnpm exec tsx setup/index.ts --step timezone -- --tz <answer>` if they supply one. If they skip, move on.

- Otherwise — timezone is already set; move on.

### 10. Pick a messaging channel

Print the list as a numbered plain-prose list (too many options for `AskUserQuestion`, which caps at 4). The user replies with a number or channel name. Preserve the numbering exactly:

> Which messaging channel should I wire your agent to?
>
> 1. **WhatsApp (native)** — `/add-whatsapp`
> 2. **WhatsApp Cloud (Meta official)** — `/add-whatsapp-cloud`
> 3. **Telegram** — `/add-telegram`
> 4. **Slack** — `/add-slack`
> 5. **Discord** — `/add-discord`
> 6. **iMessage** — `/add-imessage`
> 7. **Teams** — `/add-teams`
> 8. **Matrix** — `/add-matrix`
> 9. **Google Chat** — `/add-gchat`
> 10. **Linear** — `/add-linear`
> 11. **GitHub** — `/add-github`
> 12. **Webex** — `/add-webex`
> 13. **Resend (email)** — `/add-resend`
> 14. **Emacs** — `/add-emacs`
> 15. **WeChat** — `/add-wechat`
>
> Or say "skip" to leave this for later.

When the user picks one:

1. **Install the adapter.** For **Telegram**, run `bash setup/install-telegram.sh` directly — it bundles the preflight + fetch + copy + register + `pnpm install` + build from `/add-telegram` into one idempotent call. Then handle Telegram credentials inline (below) — **do not** invoke `/add-telegram` afterward; its Credentials section would generate an unapprovable `grep && sed && rm` to write `.env`. For every other channel, invoke the matching `/add-<channel>` skill via the Skill tool; it copies the adapter source in from the `channels` branch, registers it, installs the pinned npm package, and handles credentials. Some channels also run a pairing step as part of their flow.

   **Telegram credentials (inline):**
   - Walk the user through BotFather: `/newbot` → pick name + username ending in `bot` → copy the token.
   - Remind them: in `@BotFather` → `/mybots` → their bot → Bot Settings → Group Privacy → **Turn off** (only needed if the bot will live in groups; DM-only can skip).
   - Persist the token and sync it to the container mount with the generic setter:

     ```
     pnpm exec tsx setup/index.ts --step set-env -- \
       --key TELEGRAM_BOT_TOKEN --value "<token>" --sync-container
     ```

2. **Capture platform IDs.** After the `/add-<channel>` skill finishes (or after inline credentials for Telegram), you need two values: the operator's user-id on that platform, and the chat/channel platform-id. Each channel surfaces these differently — consult the **Channel Info** section at the bottom of that skill's `SKILL.md` for the exact path. For Telegram, run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <main|wire-to:folder|new-agent:folder>` directly and follow its `PAIR_TELEGRAM_ISSUED`/`PAIR_TELEGRAM STATUS=success` blocks — `PLATFORM_ID` and `ADMIN_USER_ID` land in the success block.
3. **Wire the agent.** Run `init-first-agent.ts` in DM mode:

   ```
   pnpm exec tsx scripts/init-first-agent.ts \
     --channel <channel> \
     --user-id "<platform-user-id>" \
     --platform-id "<platform-chat-id>" \
     --display-name "<OPERATOR_NAME>" \
     --agent-name "<AGENT_NAME>"
   ```

4. **Announce.** On success, emit the encouragement line verbatim:

   > Your agent is now available on {channel-name}, you can already start chatting — But I encourage you to continue and finish this setup, we're almost done!

   Substitute `{channel-name}` with the friendly name (e.g. "Telegram", "WhatsApp", "Slack").

If the user skipped, move on to step 11.

### 11. Host directory access

By default, agent containers can only touch their own workspace. If the user wants the agent to read or write files in specific host directories, those paths need to go on the mount allowlist.

Use `AskUserQuestion`:

- **Question**: "Want your agent to read or write files in any host directories (e.g. a code project, `~/Documents`)?"
- **Header**: "Host mounts"
- **Options**:
  1. `Keep isolated` — "Agent only touches its own workspace (Recommended)."
  2. `Add host paths` — "I'll name the directories to allowlist via Other."

If they pick "Add host paths" (or name paths via Other), invoke `/manage-mounts` via the Skill tool to add them. If they keep it isolated or skip, move on.

### 12. Quality of life

Optional polish. Print the list; the user may pick zero, one, or several — invoke each chosen skill in sequence:

> Want to add any of these? Pick any that sound useful — or skip:
>
> - `/add-dashboard` — browser dashboard showing agent activity
> - `/add-compact` — `/compact` slash command for managing long sessions
> - `/add-karpathy-llm-wiki` — persistent knowledge-base memory for the agent

If the probe reports `PLATFORM=darwin`, also offer:

> - `/add-macos-statusbar` — macOS menu bar indicator with Start/Stop/Restart controls

Do **not** list `/add-macos-statusbar` on Linux. If the user skips everything, just move on.

### 13. Done

Short wrap-up:

> Setup complete. You can chat with your agent on {channel-name} — or via CLI with `pnpm run chat <message>`.

Substitute `{channel-name}` with whatever was wired in step 10. If step 10 was skipped, drop the "on {channel-name} — or" clause entirely so the line just mentions the CLI form.

## If anything fails

Any step that reports `STATUS: failed` in its status block: read `logs/setup.log` (or `logs/nanoclaw.log` for runtime failures), diagnose, fix the underlying cause, re-run the same `--step`. Don't bypass errors to keep moving.
