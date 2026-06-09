# Activation runbook — support on illie-codex in a dedicated #support channel

Chosen config (2026-06-05): **illie-codex runs the whole support flow** (poller +
per-issue work) in a **dedicated #support Slack channel**; illie (Claude) stays
reachable in the thread by @-mention.

The feature code needs **no changes** for this — `dispatch_support_issue` derives
the channel from the poller's messaging group and the worker from the poller's
agent group, so running the poller as illie-codex in #support is sufficient.

## Prereqs (already satisfied)

- illie-codex `container.json` already declares `linear` + `google-workspace:support-illysium`
  creds (symmetric with illie) — so its container can run the Gmail pre-script
  and write Linear tickets. No new credential provisioning.
- The pre-script runs in the agent-runner before the provider is invoked, so it
  works identically under Codex.
- Internal MCP tools (incl. `dispatch_support_issue`) are served by the single
  `nanoclaw` stdio server every provider connects to — available to illie-codex.

## Steps

1. **Deploy the feature code** — merge this branch to `main`, `pnpm run build`,
   `sudo systemctl restart nanoclaw-v2`. Safe: dispatch_support_issue is dormant
   until a poller calls it.

2. **Create #support in Slack** and @-mention **both** illie-codex and illie in
   it once. Workspace-trust auto-wire (router.ts) wires each sibling to the new
   channel on first mention — no manual `/manage-channels` needed. (illie must be
   wired too so it receives thread @-mentions.)

3. **Schedule the poller as illie-codex, in #support.** In the #support channel
   (so the task lands in illie-codex's #support channel-root session), have
   illie-codex create the recurring support poller:
   - **`script`**: reuse the existing Gmail pre-filter from illie's current
     support poller verbatim (it emits `newMessages` with `threadId` +
     `existingTicket`). illie-codex can read it from illie's current scheduled
     task, or copy it from the shared workgroup.
   - **`prompt`**: the v1 prompt in `poller-prompt-v1.md` (triage → ticket →
     `dispatch_support_issue` per email; no bundled digest).
   - **`recurrence`**: `*/15 * * * *` (or whatever cadence you want).
   - This is a normal `schedule_task` — it stays a channel-root task in #support
     (correct: the detector must not be thread-bound). Each new ticket then gets
     its own thread via `dispatch_support_issue`.

   - **Shared workflow state (no per-agent bedroom):** the pre-script + prompt
     keep the Gmail-thread → Linear-issue map at
     `/workspace/workgroup/support_ticketed_threads.json` — SHARED across every
     support-assigned sibling, so reassigning the workflow keeps continuity and
     no agent owns the state privately. The host's central `support_threads`
     table is the authoritative routing record. **One-time migration:** move
     illie's existing `/workspace/agent/support_ticketed_threads.json` into
     `/workspace/workgroup/` so in-flight threads are recognized (already-labeled
     emails are skipped by the Gmail query regardless). After that it's shared
     and agent-agnostic forever.

4. **Cut over — disable illie's old #agents-xzo poller.** IMPORTANT: the existing
   support poller on illie (in #agents-xzo) must be **cancelled/paused** when the
   new one goes live, or BOTH run — double-ticketing races on the Gmail
   `bot-ticketed` label and two sets of Slack output. Have illie `cancel_task`
   its current support poller (or `pause_task` it during a soak). Verify only one
   support poller is active (`list_tasks`).

5. **Verify (first real ticket):** a genuine support email should produce (a) a
   Linear ticket, (b) one announcement in #support, (c) a working thread under it
   with illie-codex's assessment, (d) a `support_threads` row. A follow-up email
   on the same Gmail thread should land in the SAME thread, no duplicate. @-mention
   illie in a thread to confirm the sibling joins.

## Rollback

- Feature: restore illie's old #agents-xzo poller prompt (the bundled-digest one)
  and cancel the illie-codex poller. The code stays deployed but dormant.
- The `support_threads` rows + opened threads are harmless if left; new tickets
  simply stop being dispatched.
