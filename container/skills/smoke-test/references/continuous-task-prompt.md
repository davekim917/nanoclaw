# Continuous develop task — coordinator prompt template

Template for the recurring scheduled task registered to the coordinator agent.
Angle-bracket values are deployment configuration; the deployed prompt in the
task row stays short and defers to the group's standing instructions plus this
skill. Register it with `quietStatus: true` and `chatLimit: 8`.

`chatLimit: 1` physically drops the verdict — the contract is the root post,
one reply per browser lane whose evidence became durable, the verdict, and the
fix hand-off, and a budget of 1 cannot carry that. See the posting contract in
the skill; around 8 fits it.

The deterministic pre-task gate has already run. Its JSON is in
`scriptOutput`. Follow the coordinator's standing instructions and read the
`/smoke-test` skill before acting.

If `scriptOutput.trigger` is not `develop_build_settled`, do not smoke an
unknown build. Diagnose only the watcher evidence named by the trigger and use
the task's single allowed chat send for one concise
`<coordinator name> — watcher blocked` root in the QA channel, plain words, no log-style tag. A
`gate_misconfigured` trigger names the missing `SMOKE_GATE_*` values in the
deployed wrapper. Do not claim product coverage.

For `develop_build_settled`:

1. Treat `runId`, `sourceSha`, `backendDeploySha`, `frontendDeploySha`,
   `previousCompletedSha`, `devUrl`, and `checkCount` as frozen inputs. Recheck
   all three SHAs immediately before the public root, before each worker starts,
   and when evidence is captured. If any differ, stop workers, void the run as
   `BLOCKED_BUILD_IDENTITY`, close the gate, and do not claim product coverage.
2. Create `<qa-run-root>/<runId>/` (default `/workspace/workgroup/qa-smoke/runs/`) and write the run
   record plus immutable coverage manifest before testing. Use the GitHub
   compare from `previousCompletedSha` to `sourceSha` to identify changed
   surfaces. Default to `audit`; expand to `full` only under the skill's
   escalation rules. Then write the completion contract before dispatch —
   **through the scaffold, never by hand**:

   ```bash
   SMOKE_LANE_ROLE=coordinator \
   bash /app/skills/smoke-test/scripts/smoke-run-scaffold.sh contract \
     <run-dir> <sourceSha> B1:browser:'<title>' S1:source:'<title>' ...
   ```

   A freehand contract drifts from what the barrier validates, and the
   barrier's failure mode is silent — it returns `ready:false` for the run's
   life while the run proceeds on self-discipline. Declare every lane the run
   is committing to; markers land at `markers/<lane-id>.json` and take their
   `sourceSha` and `generation` from the contract, never from the caller.

   Declare **coordinator lanes only**. The barrier deliberately does not wait
   on challenger output — the challenger must never queue behind the lanes it
   exists to challenge — so a challenger marker in the required set would
   stall the run forever.
3. Use the task's chat budget for the channel-root message:
   `<coordinator name> — smoke campaign started` (plain words, never a
   log-style tag), then the exact SHA, dev environment, run id, and the
   challenger hand-off as a real @-mention of the challenger's bot username
   with its independent challenge assignment and the instruction not to read
   the coordinator's tentative conclusions — a bare name wakes nobody. Scope
   and lease owner go in the run record, not the post.
   Resolve the browser credential location from the group's standing
   instructions and mounts. Do not print or copy its values, search other agent
   folders, or reset the shared account.
4. Assign non-overlapping manifest checks to the coordinator's native
   `qa-smoke-worker` workers. For every user-visible changed surface, exercise
   a connected real-browser journey against the deployed dev frontend and
   capture screenshots, request evidence, console evidence, save/reload
   persistence, failure/boundary behavior, parity/polish, and cleanup. A
   backend-only result cannot clear a user-visible change.
   - **Dispatch every worker in the foreground and await it inside this turn.**
     Never start a background agent and end the turn expecting its notification
     to wake you: background agents live inside the container, and the host
     reaps a scheduled-task container within seconds of the turn going idle, so
     the workers die unrun and the next fire finds no completion markers.
   - If the lanes genuinely cannot finish inside one turn, call
     `continue_work({ task })` before yielding and resume them from durable
     state on the next wake. That is the only follow-up promise the host
     honors — future-tense prose in a work log is not one.
5. Keep candidate findings and worker narration in the canonical run directory.
   Workers write their declared completion markers only after all referenced
   evidence is durable. Before this scheduled turn yields or ends, run:

   ```bash
   bash /app/skills/smoke-test/scripts/smoke-evidence-barrier.sh \
     <qa-run-root>/<runId> lanes
   ```

   Do not continue until it returns `ready:true`. Then write
   `coordinator/preliminary.md` before reading the challenger's disposition. Do
   not send another chat message from this scheduled turn. The challenger
   writes its independent `challenger/disposition.md` and
   `challenger/challenge.complete.json` before checking only that
   `coordinator/preliminary.md` exists, then its one thread reply mentioning
   the coordinator wakes the per-thread synthesis session.
6. The per-thread coordinator synthesis session must first run the same
   evidence barrier with phase `synthesis`. If it does not return `ready:true`,
   it must wait for or recover the named missing lane; process state and
   elapsed time do not prove that a worker died. Only after the barrier clears
   may it publish the sole final verdict and close the gate:

   ```bash
   bash /workspace/agent/smoke-develop-gate.sh finish \
     <sourceSha> <runId> <GO|NO_GO|HUMAN_DECISION|BLOCKED>
   ```
   It must not start a successor campaign itself. The watcher owns debounce,
   build identity, and the next wake.

Never deploy, merge, promote, test production, or let a fixer close its own
fix. The release recommendation is advisory; the release channel and humans
retain ship authority.
