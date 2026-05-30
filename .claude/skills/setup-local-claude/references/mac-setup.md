# claude-ws on a second machine (e.g. MacBook)

Two ways to reach the OneCLI gateway from a second machine.

## Option A — Install a local OneCLI gateway (self-contained)

Best when the machine should work offline / independent of the host.

1. **Install OneCLI** (CLI + gateway daemon) per https://onecli.sh docs. Verify:
   ```bash
   onecli version
   onecli auth status
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:10254   # gateway up
   ```
2. **Recreate the agent identities** (the second vault is separate):
   - **Easiest:** if your host vault is cloud-backed (`onecli auth status`),
     `onecli migrate --cloud-key <key>` syncs the same agents + secrets.
   - **Manual:** for each workstream `onecli agents create --name <n>
     --identifier <same-id>`, create the secrets, then `onecli agents
     set-secrets --id <uuid> --secret-ids <ids>`. Use the **same identifiers**
     so `workstreams.json` is portable verbatim. Read each group's
     `onecliSecrets` from `groups/<folder>/container.json`. Connect OAuth apps
     (GitHub, Gmail, Atlassian, …) at http://127.0.0.1:10254.
3. **Copy the kit** to the same paths and `chmod +x`:
   - `~/.local/bin/claude-ws`
   - `~/.config/claude-ws/{workstreams.json,parity-shim.sh,mcp.json}`
   Ensure `~/.local/bin` is on PATH (`~/.zshrc`).
4. **Log in + test:**
   ```bash
   claude                                 # then /login to your subscription
   claude-ws <workstream> --version       # plumbing
   onecli run --agent <id> -- curl -sS -o /dev/null -w '%{http_code}\n' <product-host>
   ```

## Option B — SSH-tunnel to the host gateway (single source of truth)

Best when you don't want a second vault. The host must be reachable.

1. Tunnel the gateway proxy + API ports from the Mac to the host:
   ```bash
   ssh -N -L 10254:127.0.0.1:10254 -L 10255:127.0.0.1:10255 <host>
   ```
   (10254 = API, 10255 = proxy; confirm with `onecli run --dry-run -- true` on
   the host — the proxy port shows in the injected `HTTPS_PROXY`.)
2. Point the Mac `onecli` at the tunneled API (`ONECLI_URL=http://127.0.0.1:10254`
   in the Mac's env / onecli config) and authenticate with the same API key.
3. Copy the kit (step 3 above). Credentials resolve host-side; nothing to
   re-provision. The tunnel must be up whenever you use `claude-ws`.

## CA path note

The shim derives the CA from `$NODE_EXTRA_CA_CERTS`, which `onecli run` sets — no
hardcoded path. If curl/python complain about certs, check the real path:
`onecli run --agent <id> -- bash -c 'echo $NODE_EXTRA_CA_CERTS'`.
