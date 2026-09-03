# `modules/mailbox` — the fork's agent mailbox

This directory is NanoClaw's implementation of upstream's agent-mailbox seam:
`NanoclawAgentMailbox extends SqliteAgentMailbox`, plus every fork-only
session-DB customization (repository fence, recall pairing, work continuation,
done proposals, sticky settings, provider health, usage tables).

`../../mailbox/` is upstream's seam. It is ported byte-for-byte from
nanocoai/nanoclaw and is never edited — `src/mailbox-seam-upstream.test.ts`
fails on drift. The only sanctioned edit point is `../../mailbox/compose.ts`,
which registers the class exported here.

`admission.ts` is the fork's `registerAdmissionGate` observer: the repository
ingress fence, read at the poll loop's provider-idle boundary. `poll-loop.ts`
asks `evaluateAdmission()` and knows nothing about fences.

Nothing outside this directory (and upstream's `../../mailbox/sqlite/`) may
open a session DB. See `docs/specs/upstream-mailbox-seam/plan.md` §4.1/§4.3.
