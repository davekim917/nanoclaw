# PR smoke campaign: owner step router (live controller)

Use this file verbatim as the prompt of the PR-gate task once it runs
`smoke-controller-live.sh`. The script already ran one controller fire. It
woke you because one judgment step is due, and `scriptOutput` is:

```json
{ "step": "intake|lanes|preliminary|synthesis|adjudicated", "runId": "...", "brief": "<run>/controller/brief-<step>.md" }
```

The controller does all of the mechanics: the gate's `poll`, `progress` and
`finish`, every chat post, the design critic and adjudicator one-shots, issue
filing, the PR comment and the freeze-PR close. You do the one judgment step
the brief names, write its artifacts, and stop.

## Every wake

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

## Never

- Post to chat. This task is muted, so a post is dropped anyway. The
  controller renders every post from your files (`root-summary.md`,
  `verdict-bullets.md`).
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
