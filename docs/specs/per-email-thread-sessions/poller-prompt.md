# Support-inbox poller prompt (purest design — zero poller-side state)

The prompt for the `person24@fixture5.example.com` poller task (paired with
`poller-prescript.sh` as the task's `script`). The poller is a **thin triager**:
fetch body → human-judgment noise check → `dispatch_support_issue` → label.

It does **no Linear work and keeps no state**. The host decides new-vs-existing
from the central `support_threads` table (idempotent on Gmail `threadId`), and
the **per-issue session** creates the Linear ticket (or comments on follow-ups),
reports it back via `update_support_ticket`, and works the issue in its thread.
Any agent assigned to this workflow inherits the full protocol from the repo and
the full state from the host — nothing lives in any agent's workspace.

---

## Prompt

```
The person24@fixture5.example.com inbox poller flagged new email(s). The pre-script payload contains `newMessages` — a list of `{id, threadId, from, subject, date, messageIdHeader, snippet}`. The script already filtered promotions, mailing lists, and obvious automated senders; apply a final human-judgment check before dispatching.

For EACH message:

1) Fetch the full body:
   `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/support-example-labs.json && gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}'`
   Walk `payload.parts`/`payload.body`; bodies are base64url (decode with python3). Prefer text/plain; strip the quoted prior-message section so only the new content remains.

2) Pre-flight — is this a real person asking for help with EXAMPLE/Example Data (bug, question, access request, follow-up)? If it's vendor marketing, a newsletter, a receipt, a security/login alert, cold sales, a calendar/recruiting notice, or any notification system → SKIP: just label it `bot-ticketed` and move on (no dispatch). When in doubt, look at the From domain.

3) Dispatch — one call per email, new threads AND replies alike:
   `dispatch_support_issue({ gmailThreadId: "<threadId>", subject: "<subject>", sender: "<from>", date: "<date>", bodyText: "<stripped body>", lastMessageId: "<messageIdHeader>" })`
   Do NOT create Linear tickets yourself and do NOT track which threads are ticketed — the host routes the email to its support thread (existing thread for replies, fresh thread otherwise), and the per-issue session handles all Linear work.

4) Label — after the dispatch call returns ok:
   `gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --json '{"addLabelIds":["Label_1"]}'`
   If the dispatch call itself errored, leave the email unlabeled so the next run retries.

Do NOT post a channel summary — each dispatched issue announces itself with its own thread. The ONLY channel-root post is a brief "⚠️ Retry next run" line if a dispatch or body extraction failed. If 3+ emails were filtered as noise, you may add one quiet line `_Filtered N non-support emails_`. Otherwise stay silent.

Engineering tone — terse.
```

---

## Notes

- The per-issue session's seed instructs it to create the Linear issue (team:
  Example Data if clearly Example Data, else EXAMPLE failover; priority rules included), call
  `update_support_ticket`, then work the issue in-thread. Follow-ups instruct a
  Linear comment instead. The channel announcement is auto-updated with the
  ticket id once recorded.
- Outbound email replies are **not** in v1: drafts in-thread are fine; sending
  to the customer is a later phase (`last_gmail_message_id` is retained for
  In-Reply-To/References threading when that lands).
- If a per-issue session was archived, the next email on that Gmail thread
  automatically opens a fresh thread + session and carries the recorded ticket
  forward (comment, not duplicate).
- Edge: if host-side dispatch fails permanently after retries (e.g. Slack
  outage), the email is already labeled and won't re-poll — the failure is
  visible in host logs, and the next *reply* on that Gmail thread re-enters the
  flow cleanly.
