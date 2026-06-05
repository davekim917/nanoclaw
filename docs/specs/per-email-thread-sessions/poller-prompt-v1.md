# v1 support-inbox poller prompt (per-issue threads)

This is the updated prompt for illie's `support@illysium.ai` poller task. Adopt
it by updating the recurring task's `prompt` (the existing `script` pre-filter is
unchanged — it still emits `newMessages: [{id, threadId, from, subject, date,
snippet, existingTicket}]`).

**What changed from the current prompt:** instead of posting one bundled digest
to the channel, the poller now calls **`dispatch_support_issue`** once per real
support email. The host opens (or, for a follow-up, reuses) that Gmail thread's
own Slack working thread + dedicated illie session. The per-issue session is
where illie actually works the ticket with engineers — the poller's only job is
triage → ticket → dispatch.

> The code (`dispatch_support_issue` tool + host handler + `support_threads`
> table) is already live but dormant; adopting this prompt activates it. To roll
> back, restore the previous prompt — no code change needed.

---

## Prompt

```
The support@illysium.ai inbox poller flagged new email(s). The pre-script payload contains `newMessages` — a list of `{id, threadId, from, subject, date, snippet, existingTicket}`. The script already filtered promotions, mailing lists, and obvious automated senders; apply a final human-judgment check before ticketing.

`existingTicket` is `null` for a fresh thread, or `{team, issue}` when this Gmail thread is already ticketed.

For EACH message:

1) Fetch the full body:
   `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/support-illysium.json && gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}'`
   Walk `payload.parts`/`payload.body`; bodies are base64url (decode with python3). Prefer text/plain; strip the quoted prior-message section so only the new content remains.

2) Pre-flight — is this a real person asking for help with XZO/Apollo (bug, question, access, follow-up)? If it's vendor marketing, a newsletter, a receipt, a security/login alert, cold sales, a calendar/recruiting notice, or any notification system → SKIP: just label `bot-ticketed` and move on (no Linear write, no dispatch). When in doubt, look at the From domain.

3) Ticket:
   - `existingTicket` is null (new, passed pre-flight): decide team — **Apollo** if it clearly references Apollo; otherwise **XZO** (XZO is the failover default). Create the issue via `mcp__linear__save_issue` (title = subject; description with From/Date/Subject + full body + `Source: support@illysium.ai · Gmail thread <threadId>`; priority 2/High if urgent/outage/broken/can't-login, else 3/Medium). Append the mapping to `/workspace/agent/support_ticketed_threads.json` (`m['<threadId>'] = {team, issue}`) — REQUIRED so future replies don't double-ticket.
   - `existingTicket` is set (reply on an open ticket): post a Linear **comment** on `existingTicket.issue` via `mcp__linear__save_comment` (blockquote the stripped reply, attribute the sender + Gmail msg id). Do NOT create a new ticket.

4) **Dispatch to its Slack thread** — call `dispatch_support_issue` with the Gmail `threadId` so the issue gets (or reuses) its own working thread + session:
   `dispatch_support_issue({ gmailThreadId: "<threadId>", linearIssue: "<IDENT>", linearTeam: "<XZO|Apollo>", subject: "<subject>", sender: "<from>", bodyText: "<stripped body>", lastMessageId: "<Gmail msg id>" })`
   Call this for BOTH new tickets and replies on existing ones — it is idempotent on `gmailThreadId`: a new thread opens a fresh Slack thread + session; a reply routes into the existing one (no duplicate). Do this AFTER the Linear write succeeds.

5) Label (all branches, after Linear write succeeded — or immediately for skipped):
   `gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --json '{"addLabelIds":["Label_1"]}'`
   If the Linear write failed, leave it unlabeled so the next run retries.

Do NOT post a bundled channel summary — each real ticket now announces itself via its dispatched thread. The ONLY thing to post to `slack_illysium_agents_xzo` at channel root is failures: a brief "⚠️ Retry next run" line if any Linear write / body extraction / dispatch failed. If 3+ emails were filtered as noise, you may add one quiet line `_Filtered N non-support emails_`. Otherwise stay silent.

Engineering tone — terse.
```

---

## Notes

- The per-issue session, once seeded, posts its assessment in the thread and
  works the ticket with engineers there. Engineers reply in-thread to drive it.
- Follow-up emails on an already-ticketed Gmail thread route into the SAME Slack
  thread/session via the idempotent `dispatch_support_issue` call — engineers see
  the new email appear in context.
- Outbound email replies are **not** in v1: illie can draft a reply in the thread,
  but actually sending to the customer is deferred to v2 (needs Message-ID
  threading headers + an approval gate; `last_gmail_message_id` is already
  retained for it).
- If a per-issue session is later archived, the next follow-up email re-opens a
  fresh thread + session for that Gmail thread automatically.
```
