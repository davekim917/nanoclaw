# Activation runbook — support on helper-codex in a dedicated #support channel

Chosen config (2026-06-05): **helper-codex runs the whole support flow** (poller +
per-issue work) in a **dedicated #support Slack channel**; helper (Claude) stays
reachable in the thread by @-mention.

Purest-design revision (2026-06-09, Operator's principle): **zero agent-side workflow
state**. The poller is a thin triager (no Linear, no map file); the host decides
new-vs-existing from the central `support_threads` table; the per-issue session
owns all Linear work and reports its ticket via `update_support_ticket`. Protocol
lives in the repo, state lives host-side — any agent can be assigned without
migration.

The feature code derives the channel from the poller's messaging group and the
worker from the poller's agent group, so running the poller as helper-codex in
#support is sufficient — no per-agent configuration.

## Prereqs (already satisfied)

- helper-codex `container.json` declares `linear` + `google-workspace:support-example-labs`
  creds (symmetric with helper) — pre-script (gws) and per-issue Linear work both
  covered. No new credential provisioning.
- The pre-script runs in the agent-runner before the provider is invoked, so it
  works identically under Codex.
- Internal MCP tools (`dispatch_support_issue`, `update_support_ticket`) are
  served by the single `nanoclaw` stdio server every provider connects to.

## Steps (host-executable; performed 2026-06-09)

1. **Deploy the feature code** — merge to `main`, `pnpm run build`,
   `sudo systemctl restart nanoclaw-v2` (runs migrations 041/042). Safe:
   dormant until a poller calls the tool.

2. **Create #support in Slack** and @-mention **both** helper-codex and helper
   once — workspace-trust auto-wire wires each sibling. ✅ done by Operator
   (mg `slack:CTEST00008` wired for both bot apps).

3. **Seed `support_threads` from the legacy ticket map** (one-time, host-side):
   helper's old flow kept `gmailThreadId → {team, issue}` in its workspace JSON.
   Insert one row per entry (`linear_*` set, `session_id`/`slack_*` NULL) so a
   follow-up email on an in-flight thread opens its working thread with the
   existing ticket attached (Linear comment, not a duplicate ticket). The legacy
   JSON is then retired — nothing reads it anymore.

4. **Schedule the poller** (host-side insert into helper-codex's #support
   channel-root session, or ask helper-codex in #support):
   - `script` = `poller-prescript.sh` (no map, emits `messageIdHeader`)
   - `prompt` = the prompt block in `poller-prompt.md`
   - `recurrence` = `*/15 * * * *`
   - Channel-root task by design — the detector must not be thread-bound; each
     issue gets its thread via `dispatch_support_issue`.

5. **Cut over — cancel helper's old #agents-example poller** (host-side `cancelTask`
   on its channel-root inbound, or ask helper). With both running you'd get
   double-processing races on the Gmail `bot-ticketed` label.

6. **Verify (first real ticket):** a genuine support email should produce
   (a) one announcement in #support (`🎫 Support: subject — sender`),
   (b) a working thread with the email + helper-codex's assessment,
   (c) a Linear ticket created BY the per-issue session,
   (d) the announcement auto-edited to `🎫 TEAM ISSUE: subject — sender`,
   (e) a fully-populated `support_threads` row.
   A follow-up email on the same Gmail thread lands in the SAME thread (Linear
   comment, no duplicate). @-mention helper in a thread to confirm the sibling
   joins.

## Rollback

- Cancel the helper-codex poller task; restore helper's old bundled-digest poller
  if desired. The code stays deployed but dormant.
- `support_threads` rows + opened threads are harmless if left; new tickets
  simply stop being dispatched.
