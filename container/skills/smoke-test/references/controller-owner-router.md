# PR smoke campaign: owner step router (live controller)

Use this file verbatim as the prompt of the PR-gate task once it runs
`smoke-controller-live.sh`. The script already ran one controller fire, and it
woke you for exactly one of two reasons. **Read `scriptOutput` first.**

**A `failure` key** means the fire could not complete. Go to "A failure wake"
below and do only that; nothing else in this file applies.

```json
{ "failure": "<cause slug>", "detail": "<short text>", "fire": "<iso>", "note": "..." }
```

Otherwise one judgment step is due and `scriptOutput` is:

```json
{ "step": "intake|lanes|preliminary|synthesis|adjudicated", "runId": "...", "brief": "<run>/controller/brief-<step>.md" }
```

The controller does all of the mechanics: the gate's `poll`, `progress` and
`finish`, every chat post, the design critic and adjudicator one-shots, issue
filing, the PR comment and the freeze-PR close. You do the one judgment step
the brief names, write its artifacts, and stop.

## Every judgment wake

1. Before anything else, create an empty file `<run>/controller/brief-<step>.ack`
   next to the brief. It tells the controller you have the step, so it stops
   re-offering the wake.
2. Read the brief end to end, then read the `/smoke-test` skill. The standing
   "Retained technical ownership" rules apply unchanged: one retained
   provider-native `qa-smoke-worker` owns every substantive QA decision, and
   the two QA sides stay independent.
3. Do only that step. Write only the artifacts the brief names, under
   `<run>/`. Source `/workspace/agent/smoke-gate-env.sh` before any direct
   `smoke-run-scaffold.sh` or `smoke-evidence-barrier.sh` call. For a scaffold
   writer, pass `SMOKE_GATE_OWNER=<coordinatorOwnerToken>` from
   `<run>/controller/wake.json`.
4. Stop when the step's artifacts are written. The next controller fire picks
   them up. If the step genuinely cannot finish in one turn (usually lanes),
   call `continue_work({ task })` before yielding and resume from durable
   state.

## A failure wake

The wrapper posts nothing itself — you are its only way out. Do exactly two
things, and nothing else:

1. Post ONE operator alarm to the campaign room, through the same helper the
   controller uses. Source `/workspace/agent/smoke-gate-env.sh` first, then,
   with `DAY` the `fire` date as `YYYYMMDD` and `SLUG` the `failure` value
   verbatim (slugs are hyphenated, which the id and fingerprint patterns
   accept; an underscore would be rejected as invalid input):

   ```bash
   SLUG=<the failure value>; DAY=<the fire date, YYYYMMDD>
   bun /app/src/cli/enqueue-send.ts \
     --id "ctl.failure.$SLUG.$DAY#1" --to "$SMOKE_CONTROLLER_SEND_TO" \
     --text "Smoke controller (live): a fire failed closed ($SLUG). No run was advanced and nothing new was claimed. The reason is in the task's run log (\`ncl tasks runs\`) and the controller's wrapper/fires.ndjson. Posted once a day per cause while it persists." \
     --thread-key "ctl.failure-$SLUG-$DAY" --run-id "ctl.wrapper.$DAY" \
     --fire "<the fire value>" --fingerprint "$SLUG"
   ```

   The id and the text are constant per cause per day ON PURPOSE: the same id
   with the same payload is a `replay` (exit 0, no second row, no budget
   consumed), and a *different* payload under that id is refused as a
   `mismatch` — so keep `detail` and the fire timestamp out of the post text
   and put them in your reply. (`--fire` and `--run-id` are budget
   accounting, not payload, so they may vary.)
   This is the one send this task may make, and it is not affected by the
   mute: `enqueue-send` is its own process and writes the outbound row
   directly (`cli/enqueue-send.ts:286,347-351`), so it never reaches
   `NanoclawAgentMailbox.writeMessageOut` → `admitChatWrite`
   (`modules/mailbox/index.ts:302-305,117-129`), which is where `muteChat`
   zeroes the per-turn chat budget (`poll-loop.ts:3422-3430`). A
   `send_message` call, by contrast, IS dropped.

2. Take no campaign action at all. No gate verb, no `step`, no brief, no
   artifacts, no GitHub. The fire already stopped before any gate effect; your
   job is to make the failure visible, not to work around it.

The `note` in the wake is literal: the same cause re-reports on every fire
while it persists, so the alarm you post may be a replay of one you posted
earlier today. That is the intended behaviour — do not invent state to
suppress it.

## Never

- Post to chat, except the single operator alarm of a failure wake above. This
  task is muted, so any `send_message` is dropped. The controller renders every
  post from your files (`root-summary.md`, `verdict-bullets.md`).
- Run a gate verb (`finish`, `challenger-timeout`, `release`, `claim`,
  `progress`). The gate refuses them from you (`claimantMismatch`), and a
  refusal is not a problem to work around.
- File or comment on GitHub, or close a PR. Write
  `<run>/controller/issues/<findingId>.json` instead, and the controller files
  it.
- Dispatch the design critic or the adjudicator. The controller runs both as
  fresh one-shots. To ask for adjudication, write
  `<run>/controller/adjudication-request.md` naming the disputed findings and
  their evidence, write no `synthesis.json` yet, and stop. You are woken
  again with step `adjudicated` once the ruling is in
  `<run>/controller/adjudication.json`.
- Touch another run, or any run named in the controller's `cutover.json`.
  Those belong to the legacy coordinator.

## Steps

| step | done when this exists | you write |
|---|---|---|
| `intake` | `completion-contract.json` (written LAST) | journeys pin, unmapped-path dispositions, contract via the scaffold, the contact sheet when a frontend preview exists, `controller/root-summary.md` (1–2 plain sentences: what changes, what is tested) |
| `lanes` | every lane marker passes the `lanes` barrier | lane workers' evidence and markers (dispatch in the foreground, await in this turn) |
| `preliminary` | `coordinator/preliminary.md` | the preliminary, written before reading anything under `challenger/` |
| `synthesis` | `synthesis.json` | `coordinator/synthesis.md`, `synthesis.json`, `run-record.md`, `controller/verdict-bullets.md` (at most three plain-language bullets, no machine tokens), `controller/issues/<findingId>.json` per confirmed finding |
| `adjudicated` | `synthesis.json` | the synthesis, now with the adjudicator's ruling applied |

`synthesis.json` follows the skill's "Machine-readable verdict files" section.
The controller validates it against the gates and the run's evidence. Leave
an item open rather than change the verdict to fit: a GO the controller
cannot validate finishes BLOCKED, never GO.
