# Run record — workgroup cerebro

## 2026-08-08 — `/team-plan`, pillar 1 (graph scent lane)

### Grounding

Read end to end before designing: `src/modules/memory/pre-turn-context.ts` (1,489 lines),
`src/session-manager.ts` recall path, `src/graphify/store.ts`, `src/graphify/client.ts`,
`src/graphify-daemon/daemon.ts` index-promote path, `src/modules/memory/curator-worker.ts`
maintenance path, `container/agent-runner/src/formatter.ts` recall rendering.

Entered from the recorded scope in the operator's persistent memory
(`workgroup-cerebro-plan`), not from scratch.

### Measurements (2026-08-08, live host graphs, read-only)

Probe scripts run under the session scratchpad; no repository files written by them.
Largest graph: 337,091 nodes / 142,144 indexed sources / 7.6 GB.

| measurement                                          | result                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `count(*)` FTS, one common term                      | 48,405 ms                                                        |
| `count(*)` FTS, OR of three terms                    | 25,494 ms                                                        |
| same match set, `LIMIT 8`, warm                      | 0–1 ms                                                           |
| `ORDER BY node_fts.node_id` + node join              | 92,232 ms                                                        |
| `ORDER BY rank` (bm25)                               | 737 ms cold                                                      |
| `ORDER BY rank` + `relative_path LIKE 'workgroup/%'` | 132 ms cold / 118 ms warm                                        |
| cold canonical query across four workgroups          | 197 / 761 / 449 / 593 ms                                         |
| readonly handle open                                 | 0.2–4.3 ms                                                       |
| total miss                                           | 0–10 ms                                                          |
| source prefixes (largest graph)                      | `agents/` 117,928 · `workgroup/` 18,734 · `conversations/` 5,522 |

**Decisions forced by measurement**, each contradicting the recorded scope or the obvious
implementation:

1. **No match count.** The recorded scope asked for one; it costs 25–48 s. Dropped.
2. **Do not reuse `store.query`.** Its `ORDER BY node_fts.node_id` is 125× slower than
   `ORDER BY rank` on this corpus.
3. **Not a notice.** `enforceFinalBound` caps every `notice.detail` at 120 chars
   (`pre-turn-context.ts:1195`), so the "few-hundred-char notice line" in the recorded
   scope is unimplementable as a notice. It became a first-class bounded field.
4. **No cached handle.** The daemon renames `index.next-*.db` over `index.db`
   (`daemon.ts:1245-1247`); a cached fd would serve a deleted inode forever.
5. **Own FTS terms, not `tokenizeForRecall`.** `node_fts` has no `tokenize=` clause
   (`store.ts:935`) so it is unstemmed, while `canonicalToken` stems and collapses
   `manages`→`host`. Reusing it would both miss and drift.

### Cross-model review (plan stage)

| field                    | value                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stage                    | plan, on the raw proposed `plan.md`                                                                                                                                                                   |
| primary runtime / family | Claude Code / Anthropic (Opus 5)                                                                                                                                                                      |
| requested target         | Codex CLI, `gpt-5.6-sol`, `model_reasoning_effort=high`                                                                                                                                               |
| command                  | `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo`                                                                                           |
| outcome                  | **`unauthenticated`** — `401 token_invalidated` on the default `CODEX_HOME`; retried once against the configured fallback `CODEX_HOME`, `401 token_expired`. Both ChatGPT OAuth credentials are dead. |

**Substitution** (the one permitted by the cross-model contract, different model family):

| field           | value                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| target runtime  | OpenCode CLI 1.18.9                                                                                                                            |
| effective model | `grok-4.5` (xAI) — different model family from both Claude and GPT                                                                             |
| command         | `opencode run "$(cat <prompt>)"`                                                                                                               |
| timeout         | 600,000 ms (the Bash tool caps at 600 s; the contract specifies 3,600,000 ms — **deviation recorded**, review completed in well under the cap) |
| outcome         | `completed`                                                                                                                                    |
| raw verdict     | `must_fix` — 4 MUST-FIX, 1 SHOULD-FIX                                                                                                          |

Coverage is **not** degraded — an other-family reviewer succeeded — but it is not the
configured primary reviewer. Effort/model were not self-reported by the target and were
not asked for; the model line above is what the CLI printed.

### Findings — verified individually against source

| #   | Reviewer claim                                                                                                                      | Lead verdict                                   | Evidence traced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Eviction order lets the 600-char scent evict an archive excerpt, violating the plan's own invariant 5; AC12 would still pass        | **ACCEPTED (MUST-FIX)**                        | `pre-turn-context.ts:1163-1171` — the first eviction loop drops non-exact-link conversation excerpts. Shedding the scent _after_ them means a turn that previously fit can lose a real archive excerpt while keeping advisory pointers. My draft §5.7 was wrong.                                                                                                                                                                                                                                                                                            |
| 2   | The pointer cache reintroduces exactly the index-promote staleness §4.6 rejects for handles; AC7 and AC8 are mutually unsatisfiable | **ACCEPTED (MUST-FIX)**                        | AC7 required a post-rename call to return the new graph; AC8 required a repeated identical query to skip the open. With a terms-keyed cache both cannot hold. Confirmed against the promote path at `daemon.ts:1245-1247`, `:2032-2038`.                                                                                                                                                                                                                                                                                                                    |
| 3   | The sync FTS read stalls the whole host, and a 1,000 ms breaker above the ~800 ms measured cold cost never fires                    | **ACCEPTED (MUST-FIX)**                        | `session-manager.ts:813` calls `buildRecallRow` synchronously inside `writeSessionMessage` with the inbound DB open, in the host's single Node process (`CLAUDE.md`: "The host is a single Node process"). So the stall is host-wide, not per-turn. The threshold criticism is arithmetic and correct: 1,000 > 800 means the breaker is dead code on the measured envelope, and 3 strikes permits 3 full stalls first.                                                                                                                                      |
| 4   | No AC covers container rendering; `RECALL_EVIDENCE_KEYS` is a closed list, so the host could ship a field the agent never sees      | **ACCEPTED (MUST-FIX), and worse than stated** | `formatter.ts:528` — the constant is exactly `['memoryEvidence','conversationEvidence','notices']`, and `:567` requires `presentEvidenceKeys.length === RECALL_EVIDENCE_KEYS.length`. The reviewer noted the silent-drop risk. It verified worse: _adding_ the key makes every pre-existing recall row — including rows already written into session inbound DBs — fail `isComplete` and render as `"malformed structured payload / No capability state was accepted from this row"` (`:569-577`), dropping trusted capability delivery for in-flight rows. |
| 5   | Cache + breaker are complexity compensating for main-thread sync (SHOULD-FIX)                                                       | **ACCEPTED**                                   | Correct, and resolved as a consequence of #2 and #3 rather than separately: the corrected design deletes the cache, the strike counter, and the disable state, replacing all three with one measured boolean per workgroup.                                                                                                                                                                                                                                                                                                                                 |

No findings rejected. All five traced to a named file and line before acceptance.

### Correction batch (one, as the contract allows)

1. **§5.7 / AC12 / AC13 — scent is shed FIRST**, before any other lane. Invariant 5 now
   holds by construction. AC12 gains a tip-over fixture: a lane set sized so attaching the
   scent crosses `finalChars`. That is precisely the case the pre-review order would fail.
2. **§5.4 rewritten — warm-gating replaces the breaker and the cache.** The cold query
   never runs on a turn. `host-sweep.ts` probes one workgroup per 60 s sweep round-robin;
   a probe inside `GRAPH_SCENT_BUDGET_MS` (300) marks it warm, and `readGraphScent`
   refuses a cold workgroup with zero graph opens. Deleted: result cache, strike counter,
   disable state. New invariant 6.
3. **§5.8 — `graphScent` must never join `RECALL_EVIDENCE_KEYS`.** Rendered when present,
   never part of the completeness check. New invariant 9; AC15 is the in-flight-row
   regression guard.
4. **AC7–AC10 rewritten** for warm-gating; AC14–AC15 added for the formatter. 13 → 15
   cases.

No correction created a workflow-only blocker, so no second loop.

### Other checks run

- `pnpm exec tsx scripts/check-public-boundary.ts` — initially **passed misleadingly**
  because it scans `git ls-files` only and `plan.md` was untracked. Staged the file and
  re-ran: **7 `private-identifier` findings** (workgroup names, a client name, personal
  names). Neutralized all of them; re-ran staged: **passed**. Worth recording — an
  unstaged new file is invisible to that gate.

---

## 2026-08-09 — `/team-plan` revision 2, pillar 0 added

Revision 1 was never approved. Operator asked for a capture-side pillar after a separate
session observed the fleet has deep process memory and almost none about the product.
Adding pillar 0 makes this a new revision; revision 1's pending approval question is void.

### Evidence for pillar 0

Verified the originating observation before acting on it — the quoted figures were exact:
`groups/<wg>/releases/RUNBOOK.md` 59,817 B, `decisions.md` 131,860 B, an agent's
`instructions.prepend.md` 8,884 B.

That framing compares one agent's release artifacts against another's instruction file,
which understates the shared store both read. So the substantive claim was tested
directly instead: classifying all 2,505 facts in the largest store by content gives
**47.8% process-leaning vs 11.9% product-leaning** — 4:1. `memory/methods/` (90 files,
279 KB) is procedural by construction and is the fastest-growing part of the tree, so the
method-memory work shipped 2026-08-06 is part of why the gap is widening.

Root cause traced to three prompt lines in `curator-contract.ts:415-421`: line 417
enumerates capturable categories and omits the product domain; line 420 forbids "facts
recoverable from code/Graphify"; line 419 carves out an exception only for human
corrections. **Domain knowledge therefore has exactly one capture path and it is
reactive** — which is how the reference incident's architecture finally landed, as a
correction after the fact.

### Cross-model review — revision 2

| field            | value                                                         |
| ---------------- | ------------------------------------------------------------- |
| requested target | Codex `gpt-5.6-sol` — still `unauthenticated`, not retried    |
| target used      | OpenCode CLI 1.18.9, **`opencode-go/grok-4.5`**, other-family |
| command          | `opencode run -m opencode-go/grok-4.5 "$(cat <prompt>)"`      |
| outcome          | `completed`                                                   |
| raw verdict      | `must_fix` — 2 MUST-FIX, 2 SHOULD-FIX                         |

Two transport notes worth keeping. A first foreground attempt hit the **Bash tool's
600 s cap**, which is below the contract's 3,600 s ceiling — not a `timeout` under the
contract's definition; reruns were backgrounded. A first background rerun then **silently
rotated to a different model** (`deepseek-v4-flash`) and failed uncredentialed. An
unpinned reviewer is a reproducibility hole in the review contract: **always pass `-m`.**

An additional Claude-family consult (Fable) was requested by the operator and spawned.
It is additive only — same family as the lead, so it adds a lens and **not** diversity.

### Findings — all verified against source before acceptance

| #   | Claim                                                                             | Verdict                   | Evidence traced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `domain_knowledge` must join **both** reason enums, not just the capture subset   | **ACCEPTED (MUST-FIX)**   | `curator-contract.ts:52-65` is the 12-value parent; `:73` is the subset declared `satisfies readonly CuratorReasonCode[]`; the provider JSON schema binds to the parent at `:134`; `parseModelDecision` re-validates against the parent at `:230`. Capture-only would not compile, and if forced would throw `curator reasonCode is invalid` on every domain decision — a feature capturing nothing. My draft was wrong.                                                                                                                                                                                   |
| 2   | The new marker regex group shifts capture indices and breaks the parser           | **ACCEPTED (MUST-FIX)**   | `parseGeneratedMemoryFacts` (`:157-165`) reads `match[1]/[2]/[3]` positionally. A capturing `reason` group after `id=` moves evidence to `[3]` and captured to `[4]`, so the evidence list reaches `Date.parse` and every reason-bearing fact throws `has invalid timestamp`. Fails closed, but fails every write. **Took the smaller fix than the reviewer proposed**: make the group non-capturing so indices are untouched and the consumer needs no change, rather than reindexing the consumer and extending `GeneratedMemoryFact`. Nothing in the write path needs the reason — only the audit does. |
| 3   | The "required enum protects against the premise-ledger failure" argument is false | **ACCEPTED (SHOULD-FIX)** | Correct, and it was my reasoning. The enum constrains how a decision is _labelled_, never whether the model captures. Noop → nothing written, nothing counted. Written as `durable_fact` → counted under that code. Either way the domain share stays flat while every string-level test passes. Claim withdrawn from P0.7 rather than softened; an offline fixture eval added as non-blocking evidence.                                                                                                                                                                                                   |
| 4   | Stale `§5.4 (breaker) and §5.5 (cache)` cross-reference survives from revision 1  | **ACCEPTED (SHOULD-FIX)** | Confirmed at plan line 333. Revision 1's correction deleted the cache and replaced the breaker with warm-gating; the stale pointer invites reintroducing a rejected design during build.                                                                                                                                                                                                                                                                                                                                                                                                                   |

No findings rejected.

### Lead-originated finding (not from either reviewer)

**The curator already computes the measurement pillar 0 needs, and discards it.**
`MemoryCuratorRunReport` (`curator-worker.ts:54`) carries `action` but not `reasonCode`,
so the reason for every decision — including each noop — is validated and dropped
(`:460-470`). Zero occurrences of any noop reason code in the live logs.

`code_derived` is one of the seven noop codes and is the machine-readable footprint of the
exact prohibition P0.2 blames. Logging it converts P0.1's keyword estimate into a direct
count of the suppression as it happens, and makes the premise **falsifiable before the
prompt change ships**. Added as P0.3(e) and promoted to implementation **step 0**, an
explicit stop-if-false decision point: if `code_derived` noops are rare, the diagnosis is
wrong and the rest of pillar 0 should not be built.

### Correction batch (one)

1. P0.3(a) — `domain_knowledge` into both enums, parent first.
2. P0.3(d) — non-capturing group; `REASON_PATTERN` for the audit read; P0-AC3/AC4
   retargeted from the regex onto `parseGeneratedMemoryFacts`, the actual consumer.
3. P0.3(e) + P0-AC8 + step 0 — log `reasonCode`, falsify the premise first.
4. P0.5 — added the "what these criteria do NOT prove" statement and the offline fixture
   eval, following the existing `evaluateRecallCorpus` pattern (`pre-turn-context.ts:156-196`).
5. P0.7 — withdrew the false enum-counting claim; top risk restated as unmitigated.
6. §4.4 — stale cross-reference retargeted to warm-gating.

### Second reviewer — Fable (same-family consult, operator-requested)

| field    | value                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| target   | Claude Fable 5, in-process subagent with source access                                                                                                                      |
| status   | `completed` after two explicit requests (it idled twice before delivering)                                                                                                  |
| verdict  | **SOUND WITH CHANGES**                                                                                                                                                      |
| coverage | **Additive only.** Same model family as the lead, so under the cross-model contract it adds a lens and **not** diversity. The other-family requirement was met by grok-4.5. |

It verified all six briefed questions against source, checked both marker regexes
character by character, and confirmed via grep that only two parsers exist
(`curator-contract.ts:273` is a substring sniff; `CAPTURED_AT_PATTERN` is a loose search).
Findings accepted after independent verification:

| #   | Claim                                               | Verdict                                                                                       | Evidence traced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **P0-AC6 is unsatisfiable as written**              | **ACCEPTED (MUST-FIX)**                                                                       | The delivered excerpt text _includes_ the marker: `toExcerpt` calls `boundedFactLine(candidate.content, …)` (`pre-turn-context.ts:962`) and `candidate.content` is the full line, marker attached, by deliberate design (`:735-744`). Two stores differing only by `reason=` therefore can never produce byte-identical excerpts. The guarded invariant is true — ranking scores the marker-stripped `searchable` (`:915`) — but the assertion would have failed a _correct_ implementation, or been silently reinterpreted at build time. This was the one AC guarding a durable-store invariant, and neither the lead nor the other-family reviewer caught it. |
| 6   | `reason=` is per-**decision**, not per-fact         | **ACCEPTED (SHOULD-FIX)**                                                                     | `CuratorModelDecision` carries one `reasonCode`; the render loop (`curator-contract.ts:358-366`) stamps it on every fact in the batch. Multi-fact decisions are normal. Countability was the stated justification for the marker change, so the limit is now stated with it: the count is directional, not exact.                                                                                                                                                                                                                                                                                                                                                |
| 7   | The enum-argument correction needs an (a)/(b) split | **ACCEPTED (SHOULD-FIX)**                                                                     | Sharper than the other reviewer's version. Case (a) noop = real failure. Case (b) captured-but-mislabelled = **the intervention succeeded and only the counter missed it**, since recall does not read the reason. So the share is a _lower bound on domain capture_, not the outcome. P0.7 rewritten accordingly, and day-7 now requires spot-reading facts, not just counting.                                                                                                                                                                                                                                                                                 |
| 8   | Prompt-line citations off by one                    | **ACCEPTED**                                                                                  | Verified: `:415` is `Default to noop`, `:416` is the `Remember only …` whitelist, `:417` the roles line. Plan said 417/416.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | "Only one placement satisfies both" is overstated   | **ACCEPTED**                                                                                  | Before `id=` also satisfies both regexes. Chosen placement unchanged; the claim was softened.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| —   | Capture-group renumbering hazard                    | Already fixed in the first batch via the non-capturing group; Fable reached it independently. |

**The most valuable thing it produced was a pointer it explicitly refused to vouch for.**
It suggested `scripts/run-memory-provider-behavior-eval.ts` _might_ be the shape needed and
said plainly it had not read the file. Following it up found a better one:
**`scripts/run-memory-curator-model-eval.ts` already exists** and already has
`CuratorEvalCase { transcript, expectedAction: 'capture'|'noop', acceptedReasons,
mustInclude, mustExclude }` over a JSON fixture with `baseline`/`hard` corpora.

Both reviewers independently proposed _building_ an offline eval. The correct answer was
that the harness exists and the work is fixture data plus a `curatorCorpusSha256` update.
That converted P0.5 from "non-blocking evidence" into **P0.6 step 4, a real pre-deploy
gate**: the new prompt must flip at least one known-domain episode from noop to capture,
or it does not deploy.

### Follow-up on the eval harness

Located the fixture: `tests/fixtures/workgroup-memory-curator.json`, 16 cases across
`baseline`/`hard`, loaded via `--fixture` (default resolved at
`run-memory-curator-model-eval.ts:506`) and hash-pinned by `curatorCorpusSha256`.

Its `acceptedReasons` already span ten reason codes **including `code_derived`** — so the
first question was whether scoping the line-420 prohibition would break an existing eval
case. It does not. The sole `code_derived` case is a transcript naming which function a
router calls in a source file: pure implementation detail, which must still noop under the
scoped wording.

That turns step 4 into a **two-sided** boundary test — new domain cases must flip
`noop → capture`, and the existing `code-derived` case must keep nooping — so an
over-widened prohibition fails the gate before deploy. Recorded in P0.5.

### On batching

Both reviews were commissioned concurrently; Fable's arrived after grok's corrections were
applied. Treated as one review round delivered in two parts rather than a second loop —
the contract's one-batch rule exists to prevent iterative re-review, not to discard a
reviewer's findings because it was slower.

### Other checks

- `check-public-boundary.ts` (staged): the two spec files are clean. One finding remains
  at `src/container-runner.ts:3133` — an **uncommitted worktree edit belonging to another
  live session**, not this work, and deliberately not touched. Flagged to the operator: it
  will fail that session's pre-commit gate.

---

## 2026-08-10 — `/team-auto`, pillar 0 step 0 — STOPPED at the review gate

### Preflight

- No sentinel present; created at Build, refreshed at each transition, removed at stop.
- Branch `main`. `src/container-runner.ts` carries **another session's uncommitted work**;
  every operation was scoped to this change's own paths and **nothing was committed**.
- **Approval interpretation, recorded because it was inferred, not stated.** The operator
  never wrote an explicit approval — their last statement on the plan was that it was _not_
  yet approved — but then invoked `/team-auto` against this feature, which presupposes an
  approved plan. Treated the invocation as the approval act. It commits to the plan's two
  standing defaults: scope is pillars 0+1 with 2–4 sequenced, and no numeric success gate
  on pillar 0. Flagged back to the operator in the same turn.
- **Scope limit found at preflight.** The plan cannot be run straight through by this state
  machine: P0.6 step 0 is a stop-if-false decision requiring a live deploy, a multi-day
  wait, and a human call, and steps 1–3 are explicitly forbidden until it resolves. So this
  run built step 0 only.

### Build — completed

Materialized the acceptance case first per the shared contract, ran it, and observed it
fail for the right reason (`reasonCode` absent from the report) before implementing.

- `src/modules/memory/curator-worker.test.ts` — P0-AC8, a `code_derived` noop must surface
  its reason on the run report.
- `src/modules/memory/curator-worker.ts` — optional `reasonCode` on
  `MemoryCuratorRunReport`, populated from the episode decision; deliberately absent on the
  maintenance path, which makes no model decision.

Verified before writing that the field would actually be _countable_:
`runMemoryCurationInBackground` (`curator-worker.ts:600-612`) spreads the report into
`log.info('memory-curator: episode complete', { ...report })`, so the new field reaches
`logs/nanoclaw.log` with no logging change. Without that spread the field would have been
countable in name only.

| check                                                                                              | result                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `pnpm exec vitest run src/modules/memory/curator-worker.test.ts -t countable` (pre-implementation) | **failed as expected** — field absent         |
| `pnpm exec vitest run src/modules/memory/`                                                         | 83 passed                                     |
| `pnpm test`                                                                                        | **239 files, 3373 passed**, 1 skipped, 1 todo |
| `pnpm run build`                                                                                   | clean                                         |
| diff                                                                                               | 2 files, 34 lines                             |

### Review — DID NOT COMPLETE. This is the blocker.

| field            | value                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| requested target | Codex `gpt-5.6-sol` — `unauthenticated` since 2026-08-08, both credentials dead                                                                        |
| substitute       | OpenCode `opencode-go/grok-4.5`, other-family, model pinned                                                                                            |
| outcome          | **killed at ~35 min with zero bytes written**                                                                                                          |
| classification   | **not `timeout`** — the contract's ceiling is 60 min and this ended before it. Closest to `empty-output`; the kill cause is not known to this session. |

**Coverage: `degraded`.** The mandatory cross-model implementation review produced no
verdict, so this change has **test evidence but no independent review**. Per the shared
contract a degraded review requires an explicit human decision to proceed, and per
`/team-auto` the run records the evidence, removes the sentinel, and stops without
starting another review cycle. Not retried automatically.

### State at stop

Sentinel removed. Step 0 is **written, tested, unreviewed, uncommitted, and undeployed.**
Nothing else from either pillar was built. The three open decisions are: whether to accept
the degraded review or re-run it, whether to commit, and whether to deploy (a host restart,
which is the operator's call).

### 2026-08-10 (later) — operator decisions

1. **Degraded review coverage: ACCEPTED by the operator, explicitly.** The change ships
   with test evidence (3,373 passing, failure-first AC) but no completed independent
   review. Recorded per the shared contract's requirement that this be a human decision.
2. **Commit scoped to this work only** — the two curator files plus the two spec files.
   `src/container-runner.ts` belongs to another session and stays out.
3. **Deploy: already live, verified rather than assumed.** The service (restarted 21:38 UTC
   by the fleet's ordinary deploy cadence, not by this session) is running a `dist/` that
   contains the change; `logs/nanoclaw.log` shows `reasonCode=` on `episode complete`
   lines since ~18:05 UTC. First live counts — 12 decisions: 10 `insufficient_evidence`,
   2 `transient`, **0 `code_derived`**. Sample far too small to judge the P0.2 premise;
   the step-0 readout needs days. Worth noting the early shape anyway: if
   `code_derived` stays at zero while `insufficient_evidence` dominates, the suppression
   story may be wrong in an unexpected direction — the curator may be discarding domain
   content as _unevidenced_ rather than as _code-recoverable_, which would redirect the
   pillar-0 prompt fix at a different line.

---

## 2026-08-10 (later) — `/team-build`, pillar 1 (graph scent lane) — COMPLETE

Operator decisions received first: degraded review on step 0 **accepted explicitly**;
step 0 committed as `ea4b5a08` (scoped to this work's four files only); deploy verified
live rather than assumed — `reasonCode=` visible in `logs/nanoclaw.log` since ~18:05 UTC,
first 12 decisions: 10 `insufficient_evidence`, 2 `transient`, 0 `code_derived`. Sample
too small to judge the P0.2 premise; early shape noted in case it holds (suppression may
be evidence-shaped, not code-derived-shaped).

Builder: single cohesive builder (the lead, directly) — every stage shares
`pre-turn-context.ts` or its types, so parallel builders fail the write-set rule.

### Files changed

| file                                           | change                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/memory/graph-scent.ts`            | new module: terms, bounded FTS query, warm-gating, degradation, sweep probe rotation. STOP_WORDS moved here (leaf) so the value dependency runs one way.   |
| `src/modules/memory/graph-scent.test.ts`       | new — AC1–AC10 plus probe rotation and serialized-bound cases, on real seeded `WorkgroupGraphStore` fixtures (no SQLite mocking).                          |
| `src/modules/memory/pre-turn-context.ts`       | `'graph'` notice source, `graphScent?` field, `graphScentChars` bound, call site, **first** eviction step in `enforceFinalBound`; STOP_WORDS now imported. |
| `src/modules/memory/pre-turn-context.test.ts`  | AC11, AC12(a), AC12(b)+AC13 (baseline-vs-warm equality at the bound, with a fixture-reaches-the-bound guard assertion).                                    |
| `src/host-sweep.ts`                            | one probe call per sweep, round-robin, try/caught.                                                                                                         |
| `container/agent-runner/src/formatter.ts`      | renders `graphScent` when present + advisory line; `RECALL_EVIDENCE_KEYS` untouched.                                                                       |
| `container/agent-runner/src/formatter.test.ts` | AC14 (failure-first) and AC15.                                                                                                                             |

### Failure-first evidence

- graph-scent suite run before the module existed: failed (unresolvable import).
- AC14 run before the formatter change: failed (`graphScent` absent from output). AC15
  passed pre-change, as it must — it guards the legacy path staying untouched.

### Deviations from the plan (both recorded as grounded judgment)

1. **No-graph workgroups are SILENT, not `degraded`.** The plan's degradation table
   emitted `graph-scent-unavailable` whenever `index.db` is absent. Implemented per-turn,
   that stamps a permanent degraded notice on every turn of every workgroup that never
   enabled graphify — notice spam, the exact failure the notice budget exists to prevent,
   and it broke the pre-existing `test_source_failure_degrades_independently` contract.
   Semantics shipped: no graph on disk → silent (lane inapplicable); graph present but
   cold → `graph-scent-cold` degraded; **warm** but file gone (mid-rename/deleted) →
   `graph-scent-unavailable` degraded. AC6 unchanged (tests the warm+missing case).
2. **Sweep probe rotation is tested in `graph-scent.test.ts`**, not `host-sweep.test.ts`:
   the rotation logic lives in the module; the sweep wiring is one guarded call, verified
   by inspection.

### Step 6 — live latency gate: FAILED, root-caused, design revised, PASSED

First run (module as planned, 40 most recent real user queries from the live archive,
largest graph, warm): **p50 643 ms / p95 2,519 ms / max 5,063 ms — FAIL** against the
p95 ≤ 300 ms gate. Root cause: the §4.4 design probes used 3–4 terms; real queries
produced eight OR'd **prefix** terms, and FTS5 must bm25-score the whole match union —
prefix expansion multiplies that union.

Variants measured on the same 40 queries (table now in plan §5.2): prefix vs exact is
the dominant axis; **4-exact-OR** wins at p50 78 / p95 231 / max 716 with an identical
40/40 hit rate. Plan corrected first (§5.2, AC1, risk table), then the module: `terms`
8→4, exact match expression, plus **self-healing warmth** — a turn query over `budgetMs`
unmarks the workgroup so a tail costs one turn per probe cycle, not every turn.

Gate re-run with the corrected module: **p50 80.5 ms / p95 161.1 ms / max 162.9 ms,
40/40 populated — PASS.** Honesty note: the OS page cache was warm from the variant
sweeps; a genuinely cold graph costs the sweep probe (~2.8 s observed once on this box),
which is the design — that cost lands on the batch timer, never on a turn.

### Verification (fresh runs, this session)

| check                                      | result                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run src/modules/memory/` | 99 passed                                                                                                                             |
| `pnpm test` (full host)                    | **246 files, 3,459 passed**, 1 skipped, 1 todo                                                                                        |
| `pnpm run build`                           | clean                                                                                                                                 |
| `bun test src/formatter.test.ts`           | 66 passed                                                                                                                             |
| `bun run typecheck` (container tsconfig)   | clean                                                                                                                                 |
| full `bun test` (container)                | 4 failures in `task-script.test.ts` — the recorded parallel-run DB race; the file passes 4/4 isolated and is untouched by this change |
| step 6 live gate                           | PASS (above)                                                                                                                          |

### Edge cases checked beyond the happy path

Cold workgroup (zero opens), absent graph while warm, index swap mid-session with an
identical query, over-budget probe unmarking a warm workgroup, fewer-than-two-term
queries, basename-duplicate collapse, `agents/`+`conversations/` exclusion, serialized
scent > 600 chars, final-bound tip-over with counts compared against a cold baseline,
legacy recall rows without the field, and a malicious-payload serialization test that
predates this change still passing around the new field.

### Remaining risk carried to review

The scent lane has clean latency and zero proof it changes an agent's answer — §11's
efficacy evidence remains unbuilt by design. Next stage: `/team-review --implementation`
(non-auto; operator present). The other-family reviewer transport remains the open
question from the step-0 attempt.

---

## 2026-08-11 — `/team-review --implementation`, pillar 1 — must_fix, corrected, re-verified

### Transport

| field       | value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| primary     | Claude Code / Anthropic (lead)                                                                                                      |
| reviewer    | **Codex CLI, `gpt-5.6-sol`, `model_reasoning_effort=high`** — the configured other-family primary, re-authenticated by the operator |
| command     | contract transport + `< /dev/null`                                                                                                  |
| outcome     | `completed`                                                                                                                         |
| raw verdict | **`must_fix` — 3 MUST-FIX, 2 SHOULD-FIX**                                                                                           |

Two transport incidents, recorded so they stop recurring: (1) the first launch hung for
54 minutes on an open stdin — the documented `codex exec` gotcha (`</dev/null`), known in
the operator's memory and not applied; (2) the kill-and-relaunch died instantly because
`pkill -f "codex exec"` matched its own wrapper's command line. Third launch (stdin
closed, no self-matching pkill) completed normally.

### Findings — all five verified against source and ACCEPTED

| #   | Finding                                                                                                                                                                                                                                                                   | Verification                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **(MUST-FIX)** Warm mark keyed by workgroup only: survives an index promote (authorizing a query against the freshly promoted cold graph) and survives query failures (retrying a failing graph every turn). AC7 as materialized _required_ the unsafe post-promote path. | Confirmed — `WARM` was a `Set<string>`; nothing tied the mark to the probed file. Fixed: marks are `{ino, mtimeMs}` captured **after** the probe query (a racing promote cannot inherit the old timing); every read revalidates and any mismatch or failure unmarks. AC7 rewritten to demand cold-refusal-then-reprobe; AC7b added for failure unmarking. |
| 2   | **(MUST-FIX)** Graph notices survive the excerpt-eviction loops: a ~140-byte cold/no-match notice could evict a 900-char archive excerpt, violating invariant 5 structurally.                                                                                             | Confirmed against `enforceFinalBound` — only the field was shed. Fixed: the shed-first step removes `graphScent` AND all `source:'graph'` notices. AC13b added (over-bound + cold graph → zero graph notices, counts equal a no-graph baseline).                                                                                                          |
| 3   | **(SHOULD-FIX)** Term validation ran before applicability, so a short query on a graph-less workgroup emitted `no-match` — recreating the notice spam the recorded deviation exists to prevent.                                                                           | Confirmed. Fixed: existence check first; no graph → silent for any input. AC18 added.                                                                                                                                                                                                                                                                     |
| 4   | **(MUST-FIX)** The 600-char bound was not absolute: the trim loop stopped at one pointer, so a single pathological path escaped over-bound.                                                                                                                               | Confirmed. Fixed: trim to zero; zero pointers → `null` + `no-match`. AC17 added with a single-oversized-pointer fixture.                                                                                                                                                                                                                                  |
| 5   | **(SHOULD-FIX)** Three ACs materialized weaker than specified: nothing exercised the MATCH expression (restoring the failed `*` prefix would pass silently); AC4 didn't assert which duplicate survived; AC12 lacked the attach assertion and the true tip-over fixture.  | Confirmed on all three. Fixed: AC16 (morphological-variant document must NOT match — flips if prefix returns), AC4 asserts the higher-ranked path, AC12 asserts attach + no bound notice, AC12b lands a measured two-channel fixture inside the `(finalChars−600, finalChars]` window with guard assertions.                                              |

No findings rejected. Finding 1 is the standout: the reviewer caught that my own AC
enshrined the unsafe behavior as the expected result — a test asserting the bug.

### Correction batch (one) and re-verification

`graph-scent.ts` (identity-bound warmth, failure unmark, absolute bound, applicability
order), `pre-turn-context.ts` (lane-wide shed), tests (AC7 rewrite; AC7b, AC12
strengthened, AC12b, AC13b, AC16, AC17, AC18 added; AC4 sharpened), `plan.md` AC table
and §5.4/§5.7 updated first per the contract.

| check (fresh, post-correction)                         | result                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph-scent.test.ts`                                  | 17 passed                                                                                                                                                     |
| `pre-turn-context.test.ts`                             | 39 passed                                                                                                                                                     |
| `pnpm test`                                            | **246 files, 3,446 passed**, 1 skipped, 1 todo (count moved −13 vs the build run from ANOTHER session's uncommitted test edits in the shared tree; all green) |
| `pnpm run build`                                       | clean                                                                                                                                                         |
| `bun test src/formatter.test.ts` + container typecheck | 65 passed / clean                                                                                                                                             |

### Step-0 counter (in passing)

203 curator decisions logged since deploy: `insufficient_evidence` 53, `transient` 51,
`durable_fact` 33, `duplicate` 28, `durable_workflow` 20, `correction` 15,
`explicit_decision` 3, **`code_derived` 0**. Trend says P0.2's blamed prohibition is not
the operative filter — the line-416 whitelist likely rejects domain content before the
code-recoverable question is reached, surfacing as `insufficient_evidence`/`transient`.
Formal read at ~day 7; if it holds, pillar 0 narrows to the capture line and the
prohibition scoping is dropped.

---

## 2026-08-11 (later) — pillar 1 live verification (deployed via the fleet's ordinary cadence)

The operator's deploys picked the working tree up before commit: `dist/` carries the
post-correction build and the service (restarted 15:15 UTC) is running it.

**~13h of live behavior (788 probes, 75 populated scents):**

- Probe rotation round-robin across 12 graphed workgroups; budget refusal visibly
  working (one mid-size graph probed at 357 ms → left cold).
- Turn-path delivery: populated p50 **152 ms**; the largest workgroup's scents deliver 4–5 pointers.
- **The live tail is heavier than the step-6 replay predicted: 32 of 75 populated
  scents (43%) overran the 300 ms budget** — 26 + 6, all on the two multi-GB graphs; populated p95 1,322 ms, max 2,487 ms. Root cause: the replay ran on
  a quiet box; live, the graphify daemon's continuous reindex and container workloads
  churn the page cache, so probe warmth covers less of a real query's pages.
- Self-healing is working as designed: the largest workgroup was cold-refused 14 times — each an
  overrun unmarking the workgroup until the next probe re-verified. The overrun cost is
  therefore bounded at ~one slow turn per workgroup per probe cycle (~12 min), observed
  ~2 stalls/hour fleet-wide at 0.3–2.5 s each on the single-process host.

**Watch item, with an action threshold instead of vibes:** if overruns exceed ~5/hour
fleet-wide or any single stall exceeds 3 s, the next lever is raising the re-warm bar
for large graphs (N consecutive clean probes), not removing the lane. Not built now —
the current cost is modest and the mechanism that bounds it is verified live.

---

## 2026-08-13 — section B build (bootstrap recall budget + capability audit)

Triggered by a live incident: an agent denied knowing a project with 165 facts in its
own store. Autopsy in plan §B.1 — retrieval found the evidence; the 12k final bound
evicted all of it on a bootstrap turn in favor of the capability block. Operator asked
in the same breath whether the 8,000-char capability cap was too generous.

### Capability audit (operator question answered with measurement)

Built every active group's live snapshot offline: largest family **9,508 chars raw
(18 services)** — OVER the 8k cap, silently dropping services today; second 6,313;
median band 2,900–4,400. The prose is dominated by `activation` text that is operative
instruction hardened by prior denial incidents; trimming was rejected as whack-a-mole
against a known failure class. So the cap was too SMALL for one family and mis-placed
for everyone — the fix is stopping the block from competing with recall, not shrinking it.

### The bound was corrected twice during build, both by test arithmetic

1. First draft 18,000 **re-created the incident** in the worst-case fixture (the cap
   raise had grown the mandatory payload).
2. Second draft summed every bootstrap lane cap (24,500) — and fixture work proved that
   number **unreachable**: the per-lane caps bound a natural row below it, which would
   have made the final bound dead code.
3. Landed: `bootstrapFinalChars = 22_000 = finalChars + capabilityTotalChars`, with
   `capabilityTotalChars` 8,000 → 10,000. Measured saturated ceiling of a natural
   bootstrap row: **21,134** — the bound is a live safety net ~900 above the worst
   natural row, and `final-context-limit` should now effectively vanish from
   production rows. That disappearance is itself the observable success signal.

### Test restructuring forced by the fix succeeding

The three heavy shed-order tests (AC12b/AC13/AC13b) were built by pushing natural
fixtures over the bound — which the fix made impossible (21,134 < 22,000; ordinary rows
ceiling ~11.8k < 12k). Two failed attempts to force it are recorded honestly: growing
the capability fixture (clipped by its own cap) and exact-link bulk (dead end —
`parseArchivePermalinks` matches platform permalinks only, not arbitrary URLs).

Resolution: `enforceFinalBound` is now exported and the shed-order invariant is tested
**at the seam** with synthetic contexts — four deterministic cases (scent tips → shed,
whole lane incl. notices before any excerpt, notice-only lane, conversation-before-memory
order regression) replacing ~100 lines of fixture arithmetic. One contract subtlety
documented in-test: the function appends its own bound notice after trimming, so a
minimal-notice context may end ~140 chars over; real rows absorb this in late notice
eviction.

### Verification

| check                               | result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-turn-context.test.ts`          | 44 passed (B-AC1..4 + 4 seam tests; B-AC1 failed pre-fix as required)                                                                                                                                                                                                                                                                                                                                      |
| `graph-scent.test.ts`               | 17 passed                                                                                                                                                                                                                                                                                                                                                                                                  |
| memory module                       | 61 passed                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm test` full / `pnpm run build` | **BLOCKED by another session's in-flight edits**, not this change: uncommitted `session-manager.ts/.test.ts` (+119 lines, UNIQUE-constraint bug in their new test), `repo_fence_epoch` column referenced by their session-db change without its migration in fixtures, and a tsc error in their `repo-publication-coordinator.test.ts`. My suites pass isolated; their files are untouched by this commit. |

Deploy note: `dist/` cannot rebuild until the concurrent session's tsc error clears, so
this fix reaches production on their next green build + restart, not before.

### Cross-model review — section B

| field       | value                                                              |
| ----------- | ------------------------------------------------------------------ |
| target      | Codex `gpt-5.6-sol`, high effort, contract transport, `</dev/null` |
| outcome     | `completed`                                                        |
| raw verdict | `must_fix` — 1 MUST-FIX, 0 SHOULD-FIX                              |

**Finding (ACCEPTED): the limit-selection matrix was unprotected.** Verified against the
materialized B-AC4: it asserted only "no-caps row ≤12k" and "caps field exists". The
implementation at the `Math.max` branch is correct, but a regression to
16k-instead-of-max on bootstrap+exact-link rows, or treating an empty-but-present
capability snapshot as absent, would have passed every B test. Exactly the AC-weaker-
than-spec failure class this workflow keeps catching.

Correction: four matrix cases at the `enforceFinalBound` seam, each with a guard that
the fixture genuinely exceeds the smaller bound so the selection is discriminated —
absent caps trims at 12k; exact-link selects 16k (and provably not 12k); an EMPTY
capability snapshot still gets 22k with zero eviction; bootstrap+exact-link takes
max = 22k. Memory module after correction: **114 passed**.

---

## 2026-08-15/16 — pillar 0 narrowed build + the replay gate's supply-chain saga

Operator asked whether to proceed early; the counter answered: **`code_derived` 0 of
3,631 decisions** with every other code ≥1 (even `sensitive`, once). Verdict recorded in
the plan; prohibition scoping demoted to a replay-gate contingency (the counter proves
it is not the CURRENT filter; it cannot prove it won't obstruct once the whitelist
opens — only the replay can).

### Built (tests first; memory module 121 + curator-contract 17 + audit guard 1, all green)

`domain_knowledge` in both enums/schema/validation (P0-AC1); `reason=` persisted in the
marker, non-capturing, between `id` and `evidence` (P0-AC2–AC4); splitting-audit
compatibility pinned by a new `scripts/audit-memory-splitting.test.ts` (P0-AC5); ranking
neutrality (P0-AC6); domain capture line + carve-out-verbatim assertion (P0-AC7). The
deterministic-render contract test updated to the new marker shape — a plan-driven
contract change, not a silent retarget. REASON_PATTERN from P0.3(d) was NOT added:
nothing in the write path reads the reason and the measurement is a store grep (YAGNI,
recorded). Four tenant-neutral domain cases added to the eval fixture, hash re-pinned.

### Finding: the eval harness never used the production prompt

`buildCuratorEvaluationPrompt` is a hand-written PROXY prompt with its own category list
— already drifted (it lacks the people/orgs category shipped 2026-08-06). Gating pillar 0
on it would be theater. The gate therefore replays through the real `buildCuratorPrompt`

- `CURATOR_OUTPUT_SCHEMA` + the production model config (sonnet, medium), one case per
  call; the OLD prompt is reconstructed at runtime by stripping the domain line from the
  pure function's output — no source edits between phases, no race with concurrent
  sessions building `dist`. Harness drift logged for a separate fix; its env list also
  reads only 2 of the fleet's 4 OAuth slots (second latent gap, found below).

### Finding: the replay gate cannot land — the OAuth account runs at 100% utilization

~90 paced attempts over ~3 hours, across all four OAuth slots, all 429 (live Anthropic
request ids). Meanwhile the production curator lands a call roughly every minute on the
same account: the fleet's ~1.7 decisions/min steady state consumes the subscription's
whole throughput, and any external marginal caller starves. Instrumented, not assumed:
single 64-token probes 429 identically. The gateway-vault escape hatch (Anthropic API
key, separate limits) 401s from this shell — its gateway agent does not carry the
Anthropic secret (correct per design; model traffic bypasses the gateway).

State: a sentinel probes every 25 min and fires the two-phase gate on the first open
window. Two operator-owned unblocks exist if the saturation never breaks: assign the
vault Anthropic key to this workstream's gateway agent, or briefly disable
`NANOCLAW_MEMORY_CURATOR_ENABLED` to free the account for ten minutes.

### Operator decision 2026-08-16: SHIP AHEAD OF THE GATE

Operator: "Ship it." The replay gate converts from pre-deploy requirement to post-deploy
evidence: the sentinel keeps probing and the old-vs-new table attaches here when a
rate-bucket window opens. Grounds: the change is additive and prompt-level; its
failure mode is capturing wanted facts under a countable label before efficacy proof;
retreat is deleting one prompt line. The shared worktree also meant the change could
leak into `dist` on any concurrent build regardless of when we committed.

Also recorded from the credential investigation (full detail above): the fleet's 429s
were per-minute rate-bucket contention, NOT usage-window exhaustion; "all credentials
unavailable" is worker cooldown bookkeeping; failover to slots 3/4 is deliberate
resilience (restriction proposed once, REJECTED); API-key migration REJECTED. The one
accepted follow-up is renaming the misleading log label, on the operator's word, separately.

### Cross-model review — pillar 0 (pre-ship)

Codex `gpt-5.6-sol`, contract transport, `</dev/null`: **`must_fix` — 2 MUST-FIX,
2 SHOULD-FIX. All four verified and ACCEPTED; none rejected.**

| #   | Finding                                                                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The expanded fixture's `recordedSelection` still pinned the July corpus hash, so `verifyCuratorEvalFixture` BLOCKS every run and 2 harness tests fail. **Verified: I would have shipped a red suite.** | Hash carried forward with a truthful provenance annotation (selection is 2026-07-26/16-case, carried over the 4-case domain addition, re-selection due with the post-deploy replay). Both tests green.                                                                                                                 |
| 2   | The replay gate existed only as session scratch — a repository consumer could not reproduce P0.6 step 4, and the checked-in harness's proxy prompt cannot serve it.                                    | `scripts/run-memory-domain-replay.ts` checked in: derives BOTH variants from the production `buildCuratorPrompt` (old = domain sentences stripped at runtime + whitelist wording reverted), production schema/model, agentic-lane credential policy, old-phase domain misses labeled as baseline rather than failures. |
| 3   | The `Remember only …` whitelist — the operative filter per our own verdict — still excluded the domain, contradicting the later capture line.                                                          | Domain added to the whitelist sentence itself; explanatory line retained; AC7 still asserts carve-out verbatim.                                                                                                                                                                                                        |
| 4   | P0-AC6 could not fail under the realistic regression (ranking the full line instead of marker-stripped text) because no query term lived only in the marker.                                           | AC6 gains a marker-only-vocabulary query that must select nothing.                                                                                                                                                                                                                                                     |

Post-correction: memory module + both script suites **125 passed**, build clean. The
`migrate-repo-store-*` failures in the wider suite belong to the concurrent session's
domain and are untouched by this commit.

### Post-ship observation 2026-08-16: agentic-lane saturation is continuous, not peaked

The replay sentinel exhausted 40 probes over ~17 hours (25-min cadence, agentic lanes,
single 64-token calls) without one landing — every sampled instant found the per-minute
buckets drained, day and night alike. The production curator continues to succeed via
persistent retry, so this changes nothing about capture health, but it upgrades the
contention picture from "peak windows" to "steady state at current fleet load."
Sentinel relaunched (60 probes, jittered cadence, two taps per probe to exclude
sweep-phase alignment). If it exhausts again, the replay realistically needs an
operator-created window rather than luck.

### 2026-08-16 (post-restart review) — pillar 0 producing; scent watch item FIRED and lever built

**Pillar 0 live and capturing.** Within ~3.5h of the 17:22Z restart: 133 reason-bearing
facts in the stores, **16 `domain_knowledge`** among them (largest workgroup), quality on
target — metric semantics, product rules, an operator standing ruling, a rewritten
publish flow. The `reason=` share is now directly countable, replacing the keyword
estimate forever. (A `reason='SUSPENDED...'` grep hit was prose inside a fact quoting
code, not a marker defect.)

**Scent watch item fired.** 19 turn queries >3s since deploy (8 in the 3.5h after the
restart), worst **26.9s**, all on the two multi-GB graphs — deploy churn evicts their
page cache and a single lucky probe re-warmed them into a stall. The pre-named lever is
built: `largeGraphBytes` (1 GiB) / `largeGraphCleanProbes` (3) — a large index needs
three CONSECUTIVE clean probes to re-warm; any failed/slow probe resets the streak;
small graphs keep the single-probe bar. Cost: a big graph re-warms ~36 min after churn
instead of ~12 — acceptable for an advisory lane whose worst case was a 27s host stall.
Tests: 3 new cases (single probe insufficient, streak reset, small-graph unchanged);
memory module 123 passed; build clean.

**Replay gate still starved:** sentinel run 2 underway; run 1's 40 probes over ~17h all
found drained buckets.

### 2026-08-17 — replay gate CLOSED by production evidence; prohibition contingency DEAD

The synthetic replay never landed: two sentinel campaigns (100 probes over ~34h) found
the agentic lanes' per-minute buckets drained at every sampled instant. It is no longer
needed — production answered both of its questions with stronger evidence:

- **Old prompt suppressed domain capture:** 0 `domain_knowledge`-class captures in 3,631
  old-prompt decisions (the code did not exist and the whitelist excluded the class).
- **New prompt captures, and the prohibition does not obstruct:** 26 `domain_knowledge`
  facts in the first ~19h across two workgroups (12.4% of new reason-bearing captures),
  quality spot-checked (metric semantics, product rules, operator rulings, rewritten
  flows — meaning and rationale, not call sites), and `code_derived` remains **zero**
  even with the whitelist open — the P0.3(c) prohibition-scoping contingency is dead,
  permanently unbuilt.

`scripts/run-memory-domain-replay.ts` stays in-tree for future prompt changes, where a
pre-deploy comparison will again be the right tool under less saturated conditions.

### Not done at this stage

No production code written; planning is artifact-only. No tests materialized — per the
shared contract, `/team-build` writes the acceptance cases into the test tree after
approval, so a rejected plan leaves no trace in the product repository.

### Known risks carried into approval

Listed in `plan.md` §10. The two the operator must weigh: this plan builds pillar 1 and
sequences pillars 2–4 rather than designing all four, and no efficacy eval exists for the
memory system as a whole — the outstanding A/B remains unbuilt and is out of scope here.

## Pillar 2 planning — 2026-08-19

### Entry evidence (measured today, not estimated)

- `domain_knowledge` captures: **235 facts, 18.5% of new reason-bearing captures** across
  two workgroups, three days after pillar 0 deployed — the pillar-2 entry criterion
  ("domain facts are flowing") is met.
- Scent pointer-following: **0 explicit citations in 270 sampled scent deliveries**
  (30-minute reply window against the archive). Lower bound — silent follows are
  unmeasurable — but the excerpt lanes demonstrably do change behavior (bootstrap-fix
  replay). Design consequence adopted into P2: topic files target the file-excerpt
  lane (short, dense, one entity per file), not scent pointability.

### Grounding reads (source evidence for P2.3)

- `curator-worker.ts` `runMaintenance`: deliberate no-op with full lease machinery
  (claim/complete/fail) and `maintenance_written` already in the report union.
- `message-archive.ts`: `maintenance_pending` set at 50 accepted updates or 6 MiB
  (:225, :230, :640-657), claimed at :674, reset at :706.
- `memory-write.ts:337-345`: the shared CAS write core reserves only
  `generated/memory.md`; arbitrary memory-relative paths flow through the same
  lock/CAS machinery — the topic-file writer is a thin wrapper, not new machinery.
- Recall: `people/ domain/ systems/` markdown is ordinary file-lane input; zero
  recall-side changes required. `preferences/` untouched.

### Plan written

`plan.md` §P2: cursor column (`consolidated_through`, captured-stamp based — survives
supersession rewrites where a line-count cursor breaks), tail-bounded consolidation
pass (≤150 facts) inside `runMaintenance`, host-side path/size validation
(`^(people|domain|systems)/[a-z0-9][a-z0-9-]*\.md$`, ≤8 KiB, ≤12 files), per-file CAS
via a `writeMemoryTopicFile` wrapper, ledger byte-identical invariant (P2-I1),
P2-AC1..AC10. Rejected: full-store rewrite (store exceeds one context window),
separate worker (duplication), Graphify entity extraction (pillar 4's job).

### Plan-stage review (2026-08-19) — Codex gpt-5.6-sol, high reasoning

Operator-directed review lane (not the default `/team-plan` reviewer set). 15 findings,
13 MUST-FIX and 2 SHOULD, all verified against source and accepted. Disposition below,
one line per finding; full P2 rewrite is in `plan.md` §P2.

1. **MUST-FIX, cursor not monotone/tie-safe.** Cursor design dropped entirely — replaced
   with an order-independent `memory_consolidated_facts` id-set (P2.4 item 1).
2. **MUST-FIX, supersession stability incomplete, no lineage.** Moot under the id-set:
   replacements get new ids and re-enter the tail automatically (P2.4 item 1); prompt
   reworded to state topic files are rewritten views, not lineage-tracked (P2.4 item 5).
3. **MUST-FIX, 150-fact continuation incompatible with unconditional counter reset.**
   `completeMemoryMaintenance` now subtracts the job's snapshot count (floor 0) instead
   of zeroing, and reasserts `maintenance_pending` when a tail remains (P2.4 item 2,
   P2-AC15).
4. **MUST-FIX, bounded tail doesn't bound the backlog.** Migration backfill enqueues
   every non-empty-ledger workgroup; combined with item 3's reassert, backlog drains at
   ≤150 facts per workgroup per sweep round (P2.4 items 2–3, P2-AC14).
5. **MUST-FIX, P2-I2 false under tail-only reconstruction.** P2-I2 reworded: recovery is
   a workgroup-granular reset of the id-set (optionally plus topic files), which replays
   the whole ledger as tail; a lone file delete without a set reset is explicitly not
   recoverable (P2.4 item 4, P2-I2).
6. **MUST-FIX, mid-batch writes not proven merge-idempotent.** "Idempotent" dropped from
   the plan; a failed pass marks nothing consolidated and the retry re-presents the same
   tail against current (possibly partial) file state — convergent by re-presentation,
   duplication auditable via the header, not structurally prevented (P2.4 item 5,
   P2-AC6).
7. **MUST-FIX, production transport hardcoded to the episode schema.** New
   `MemoryCuratorBackend.consolidate()` method with its own `CONSOLIDATION_OUTPUT_SCHEMA`,
   plus a non-mocked schema-contract AC (P2.4 item 9, P2-AC12).
8. **MUST-FIX, maintenance outside lifecycle wiring.** `runMaintenance` moves inside the
   same admission/credential/failover/abort machinery as episode calls, with an AC
   asserting admission-accounting and abort-propagation under mocks (P2.4 item 9,
   P2-AC13).
9. **MUST-FIX, first-run topic dirs don't exist.** `writeMemoryTopicFile` creates its
   topic directory first; P2-AC1 now starts from a memory root containing only
   `generated/` (P2.4 item 8, P2-AC1).
10. **MUST-FIX, nothing schedules an initial pass.** Migration backfill sets
    `maintenance_pending = 1` for every workgroup with a non-empty ledger (P2.4 item 3,
    P2-AC14).
11. **MUST-FIX, `{files: []}` on a non-empty tail undefined.** Defined as valid success:
    tail facts marked consolidated, `maintenance_written` with `fileCount: 0`, logged
    distinctly; risk of model laziness on this path recorded in P2.8, not structurally
    prevented (P2.4 item 7, P2-AC7).
12. **MUST-FIX, unbounded model input from "every current topic file."** Input caps
    added: 16 KiB per presented file, 256 KiB total; over-cap files excluded, logged,
    and locked from writes that pass (P2.4 item 6, P2-AC11).
13. **MUST-FIX, allowlist permits overwriting human-authored memory.** Ownership
    restricted to files carrying the consolidation header; unmarked files are read-only
    context and host-rejected as write targets even if the model returns their path
    (P2.4 item 6, new invariant P2-I6, P2-AC10).
14. **SHOULD, recall claim eligible-but-not-guaranteed, "whole file" untested.** P2.2
    reworded: the 900-char excerpt is the delivery unit, not full-file delivery; recall
    AC now covers all three directories and asserts excerpt content, dropping the
    "delivered whole" claim (P2.2, P2-AC8).
15. **SHOULD, validation ACs pass while the contract stays broken.** Path-rejection AC
    split into seven independently asserted forbidden classes; size-cap AC now measures
    the final serialized file including the generated header, not model output alone
    (P2-AC3, P2-AC4).

## Pillar 2 build — 2026-08-19

Approved plan: `plan.md` §P2 at commit 871c8507; operator approval given explicitly
2026-08-19 ("approved"). Build start recorded here. Builder: one cohesive worker
(write sets across message-archive/curator-\* overlap too much for parallel builders);
lead reviews the diff and runs fresh checks before `/team-review --implementation`.

## Pillar 2 implementation — 2026-08-19

### Build

One cohesive worker built §P2.7 steps 1–10 on an isolated worktree branched from
871c8507 (the live tree carried another session's uncommitted curator-worker change;
isolation chosen so neither session's work could clobber the other's). All 15 AC test
titles materialized verbatim. Builder deviations accepted by the lead: three ACs placed
in module-local test files (precedented), additive `GeneratedMemoryFact.text`,
`MEMORY_CONSOLIDATOR_MAX_TOKENS = 32,768` (plan gap — the episode output budget cannot
fit the plan's own 12×8,192-byte ceiling), header `facts=<n>` = pass-tail count,
locked-path writes fail the whole pass (conservative), reset lever deliberately not
shipped as code.

### Lead verification catches

Fresh full-suite run by the lead found 4 test SUITES broken (green at base) that the
builder's self-report missed — suite-level failures masked by a clean test-level count.
Root cause: migration 051 imported application modules (message-archive, curator-write/
contract), transitively pulling `secret-scrubber.ts`'s import-time `setLogScrubber`
side effect into every DB-touching test's module graph, crashing suites that
partial-mock `log.js`. Fix: migration rewritten fully self-contained (frozen logic —
inline ledger check, inline upsert, deliberate duplication documented in place), the
now-caller-less helper removed, and a new shape guard
(`src/db/migrations/import-allowlist.test.ts`) pins the class: migration imports must
resolve to node builtins, better-sqlite3, sibling files, or verified-safe utility
modules. Allowlist deliberately wider than the lead's literal directive — the narrow
version would have retroactively failed three shipped migrations; widening to
verified-safe reality accepted. After fix: 278/278 suites, 3,980 tests.

### Implementation review (2026-08-19) — cross-model, high reasoning

8 findings (7 MUST-FIX, 1 SHOULD); lead traced all 8 to source; all 8 accepted with
lead-adjusted fixes (one bounded correction batch):

1. Ids could be marked consolidated after lease loss → reorder: owner-conditioned
   `completeMaintenance` BEFORE `markConsolidated`; failure direction becomes
   re-present (merge-safe), never skip. Lead note: reviewer's stated harm was
   overdrawn (written facts leaving the tail is mostly correct) but the ordering fix
   is right and cheap.
2. Completion clobbered `maintenance_pending` set by mid-pass accrual with a stale
   `hasMore` → completion recomputes: reassert OR post-subtraction counter ≥ threshold.
3. Insert-only membership rows suppressed A→B→A semantic reversion (deterministic
   text-hash ids) → prune rows absent from the live ledger at pass start; table now
   bounded by ledger size.
4. Input-cap TOCTOU (lstat-then-read; read used the 8 MiB bound) → post-read re-check
   against the 16 KiB/256 KiB caps + bounded read in the scanner.
5. Presented-as-human paths not durably locked (delete-mid-pass let the model claim
   the path create-only) → all `owned:false` paths join the locked set.
6. Prompt instructed date-aware conflict handling but the payload carried no dates →
   `capturedAt` added to the tail payload.
7. Abort signal reached only the model call → `throwIfAborted` after the call, before
   each write, and before completion; AC13 strengthened to abort mid-write.
8. (SHOULD) AC1/6/7 membership assertions were spy-only → rewired to the real
   `memory_consolidated_facts` table on a temp DB.

Reviewer's own verification: 138/138 on the focused seven-file suite, tsc clean.

### Correction batch closed — verdict: clear

All 8 findings fixed in one batch (worktree commit `0d7934ac`). Lead spot-verified the
three subtlest fixes in source (completion-before-mark ordering with abort checks at
the model return, each write, and pre-completion; the counter-aware pending CASE; the
owned:false lock union) and independently re-ran the full host suite: 279 files /
3,986 tests, zero failures. Membership assertions now hit the real
`memory_consolidated_facts` table on a migrated temp DB. No verified MUST-FIX remains;
implementation review returns **clear**.

### Integration — 2026-08-19

The orphaned curator-worker bot-gate change was committed by the operator (6fd669e9);
P2 branch merged --no-ff on top. git auto-merged `curator-worker.ts` (bot-gate and P2
touch different regions of `runOne`); merged-main verification: build clean, both
features present, P2-touched suites 27 files / 250 tests green, full suite 4,013
passed with 9 failures confined to `migrate-repo-store` — pre-existing environmental
flake in this working tree (independently reported by a sibling session BEFORE the
merge with a drifting count; the same suite passes 47/47 on identical code in the
clean worktree). Deployed to dist by the verification build; activates on next host
restart.

## Recall-lane cap starvation — found by the fleet, fixed same day (2026-08-19)

A fleet probe (two agents coordinating over their own recall blocks) proved the
per-person `preferences/` lane never fires in the largest workgroup: the lane filtered
the output of `listMarkdownFiles`, whose 256-visited-entry BFS cap exhausts before
`preferences/` is enumerated at 338 files. Lead verified the diagnosis in source and
found the same latent class one level deeper: `generated/memory.md`'s read-first
priority also depended on walk enumeration — a large enough tree would silently drop
the whole fact store from recall. This is P2.8's "traversal ceiling" risk, already
tripped in production before P2's topic files add pressure (`domain/` sorts before
`generated/`; `systems/` after `preferences/`).

Fix (7a0edf5f): deterministic direct-path lanes decoupled from the capped walk —
`preferences/` listed by its own non-recursive readdir; the ledger spliced into scan
order behind an lstat existence guard. Red-first tests reproduce the starvation with a
300-file tree. Walk, cap, and ranking untouched; the ranked lexical lane still lives
under the cap and still announces truncation. Other-lanes audit: CORE_PATHS, exact-link,
archive, and graph-scent lanes all independent of the walk — class closed. The
workgroup's `index.md` workaround bullet ("preferences not reaching you") should be
retired after the restart activates this fix.

## Post-deploy: consolidation was failing on every large workgroup (2026-08-20)

Verification after the first P2 restart found the mechanism working for small stores
(25 topic files across four workgroups, all header-stamped and coherent) and failing
for every large one — the two largest workgroups had consolidated **zero** facts ever.

**Root cause: the consolidation call was killed by its own timeout.** `consolidate()`
was given 4x the episode output budget (`MEMORY_CONSOLIDATOR_MAX_TOKENS` 32,768 vs
8,192) but the unchanged `MEMORY_CURATOR_TIMEOUT_MS` of 120s. The stale comment stated
the wrong invariant out loud — "Same model/effort/timeout as episodes; only the output
budget differs" — and lead review approved it without catching that a 4x budget on an
unchanged clock is incoherent. Node SIGTERMs the CLI at 120s; exit 143 surfaces as
`structured Claude CLI call failed with exit 143`; 85 such failures logged. The
"successes" were already grazing the ceiling: 101.2s and 101.6s on the two largest stores that did finish.

**Second bug, found while diagnosing: the failure backoff was defeated.**
`recordAcceptedGeneratedMemory` set `not_before = excluded.not_before` (= now) in its
conflict branch, so every accepted episode write wiped the 6-hour backoff
`failMemoryMaintenance` had just set. the busiest workgroup retried an impossible call ~60x/day
instead of ~4 — roughly two hours of blocked curation pump per day, ~22k input tokens
per doomed attempt, and (because maintenance is claimed before episodes) episode
curation starved behind it. a quiet workgroup with zero accepted writes that day was the
natural control: its backoff held at clean ~6h intervals.

Fix (002e5fb5): `MEMORY_CONSOLIDATOR_TIMEOUT_MS = 480_000` scaled to the output budget;
`not_before = MAX(existing, now)` so an accepted write cannot clear a backoff (verified
NULL-safe — column is NOT NULL and both operands are always bound ISO strings, so
scalar MAX cannot propagate NULL). Red-first tests for both. Deliberately deferred
pending observation: smaller cold-start `CONSOLIDATION_MAX_FACTS`, exit-143 error
reclassification, graduated maintenance backoff — the timeout fix likely moots them,
and adding knobs before measuring is how this gets worse.

Projected drain once live: the largest store, 5,784 facts / 150 per pass = 39 passes at ~120s
each ≈ 78 minutes, during which episode curation is starved (maintenance claims first,
unconditionally) — watch for that.

## Investigated and cleared: `bounded write request is required` (2026-08-20)

Eight episode-curation write failures appeared post-restart with
`memory writer helper failed (1): ... bounded write request is required`. Because they
began the same day pillar 2 changed the shared writer, they were treated as a possible
P2 regression and investigated on commit-level evidence rather than on the earlier
review's reasoning.

**Not pillar 2.** The two byte caps that gate this path — `GENERATED_MEMORY_MAX_BYTES`
and the helper's `MAX_CURATOR_WRITE_REQUEST_BYTES` — were raised together in one commit
on 2026-08-05, fifteen days before the P2 commits, and remain exactly synced on main
(8 MiB + 16 KiB = the helper bound). P2's diff to `curator-write.ts` renamed error
strings and added `ensureMemorySubdirectory` / `readMemoryTopicFile` /
`writeMemoryTopicFile`; `invokeHelper` and `writeGeneratedMemory` — the failing path —
are functionally untouched.

**Actual cause: empty stdin under host-reboot load.** The helper's guard collapses two
conditions into one message (`!raw` OR oversized). The oversized branch was ruled out:
the real ledger files are well under the cap, the host pre-checks the same bound before
spawning, and 15 direct helper invocations with the real 5.6 MB payload produced zero
failures. All eight failures fall inside the window where the **host machine rebooted**
(16:23:56Z) and the event loop stalled 5–30s repeatedly; the preceding ~16 hours of
pillar 2 in production produced none. Failing path is the episode ledger, never the
topic-file lane (topic writes are capped at 8 KiB — nowhere near this size class).

**Impact: none permanent.** Validation-class episode failures retry on exponential
backoff (5 min · 2^(n-1), flattening to 24h) and are never marked permanently failed;
all eight remain queued. A live check confirmed the curation pump is healthy — claiming
and completing episodes every ~60s — so the "retries not firing" observation was queue
ordering, not a wedge.

**Deferred hardening** (not urgent, deliberately not bundled into the current restart):
split the helper's ambiguous error message so empty-stdin and oversized-request are
distinguishable in logs, and attach an `error` listener to the child's stdin in
`invokeHelper`.

## Timeout fix verified; validation poison loop found and fixed (2026-08-21)

**The timeout fix works.** Zero `exit 143` failures since the restart that deployed it
(previously 100). Consolidation calls now run to completion.

**Completion exposed the next blocker, and it was a contract defect, not a bug.** The
first completed call returned one topic file over the 8,192-byte ceiling.
`validateConsolidationFiles` threw, `runMaintenanceJob` failed the whole pass, nothing
was marked consolidated, and a 6-hour backoff was booked — after which the identical
tail would be re-presented to the same model, producing the identical oversized file,
forever. Zero progress at one wasted model call per six hours, permanently.

Fail-whole-pass is right for a **transport** failure (CAS conflict, lost lease,
malformed payload) where a retry can succeed. It is wrong for a **deterministic
validation** failure where a retry cannot. The plan drew no such distinction, and lead
review approved it: this exact poison-loop shape was predicted in-session before the
timeout diagnosis arrived, and was not acted on once the diagnosis pointed elsewhere.

**Fix.** `validateConsolidationFiles` now partitions into `{accepted, rejected}`:
per-file path/size violations are rejections; over-count accepts the first twelve in
order and rejects the remainder; structural/protocol violations (payload not an object,
`files` not an array) still throw. `runMaintenanceJob` writes the accepted files, logs
every rejection at WARN with path, reason and byte size, marks the tail consolidated,
and reports `fileCount` plus a new `rejectedCount`. The locked-path check deliberately
stays a hard throw — a model writing to a path it was told is read-only is a protocol
violation, not an unrepresentable tail. The prompt now states the per-file ceiling and
that an oversized file is discarded entirely.

**Accepted trade, recorded deliberately.** An entity whose view is persistently too
large is dropped rather than deadlocking its whole workgroup. Its facts remain in the
ledger and stay recallable through the ordinary lanes; the WARN names the path so the
loss is visible and measurable rather than silent. The 8,192-byte cap was NOT raised to
paper over this — short dense files are what the ~900-char excerpt window can actually
deliver. If logs show one entity dropping repeatedly, that is the signal to revisit.

`plan.md` §P2.6 P2-AC4 amended accordingly; its original assertion is quoted there so
the change of contract is legible rather than silent. Full host suite green (289 files,
4,257 tests).
