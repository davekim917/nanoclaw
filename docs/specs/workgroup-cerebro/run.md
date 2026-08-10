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

| measurement | result |
|---|---|
| `count(*)` FTS, one common term | 48,405 ms |
| `count(*)` FTS, OR of three terms | 25,494 ms |
| same match set, `LIMIT 8`, warm | 0–1 ms |
| `ORDER BY node_fts.node_id` + node join | 92,232 ms |
| `ORDER BY rank` (bm25) | 737 ms cold |
| `ORDER BY rank` + `relative_path LIKE 'workgroup/%'` | 132 ms cold / 118 ms warm |
| cold canonical query across four workgroups | 197 / 761 / 449 / 593 ms |
| readonly handle open | 0.2–4.3 ms |
| total miss | 0–10 ms |
| source prefixes (largest graph) | `agents/` 117,928 · `workgroup/` 18,734 · `conversations/` 5,522 |

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

| field | value |
|---|---|
| stage | plan, on the raw proposed `plan.md` |
| primary runtime / family | Claude Code / Anthropic (Opus 5) |
| requested target | Codex CLI, `gpt-5.6-sol`, `model_reasoning_effort=high` |
| command | `codex exec --ignore-user-config --model gpt-5.6-sol -c 'model_reasoning_effort="high"' --ephemeral --yolo` |
| outcome | **`unauthenticated`** — `401 token_invalidated` on the default `CODEX_HOME`; retried once against the configured fallback `CODEX_HOME`, `401 token_expired`. Both ChatGPT OAuth credentials are dead. |

**Substitution** (the one permitted by the cross-model contract, different model family):

| field | value |
|---|---|
| target runtime | OpenCode CLI 1.18.9 |
| effective model | `grok-4.5` (xAI) — different model family from both Claude and GPT |
| command | `opencode run "$(cat <prompt>)"` |
| timeout | 600,000 ms (the Bash tool caps at 600 s; the contract specifies 3,600,000 ms — **deviation recorded**, review completed in well under the cap) |
| outcome | `completed` |
| raw verdict | `must_fix` — 4 MUST-FIX, 1 SHOULD-FIX |

Coverage is **not** degraded — an other-family reviewer succeeded — but it is not the
configured primary reviewer. Effort/model were not self-reported by the target and were
not asked for; the model line above is what the CLI printed.

### Findings — verified individually against source

| # | Reviewer claim | Lead verdict | Evidence traced |
|---|---|---|---|
| 1 | Eviction order lets the 600-char scent evict an archive excerpt, violating the plan's own invariant 5; AC12 would still pass | **ACCEPTED (MUST-FIX)** | `pre-turn-context.ts:1163-1171` — the first eviction loop drops non-exact-link conversation excerpts. Shedding the scent *after* them means a turn that previously fit can lose a real archive excerpt while keeping advisory pointers. My draft §5.7 was wrong. |
| 2 | The pointer cache reintroduces exactly the index-promote staleness §4.6 rejects for handles; AC7 and AC8 are mutually unsatisfiable | **ACCEPTED (MUST-FIX)** | AC7 required a post-rename call to return the new graph; AC8 required a repeated identical query to skip the open. With a terms-keyed cache both cannot hold. Confirmed against the promote path at `daemon.ts:1245-1247`, `:2032-2038`. |
| 3 | The sync FTS read stalls the whole host, and a 1,000 ms breaker above the ~800 ms measured cold cost never fires | **ACCEPTED (MUST-FIX)** | `session-manager.ts:813` calls `buildRecallRow` synchronously inside `writeSessionMessage` with the inbound DB open, in the host's single Node process (`CLAUDE.md`: "The host is a single Node process"). So the stall is host-wide, not per-turn. The threshold criticism is arithmetic and correct: 1,000 > 800 means the breaker is dead code on the measured envelope, and 3 strikes permits 3 full stalls first. |
| 4 | No AC covers container rendering; `RECALL_EVIDENCE_KEYS` is a closed list, so the host could ship a field the agent never sees | **ACCEPTED (MUST-FIX), and worse than stated** | `formatter.ts:528` — the constant is exactly `['memoryEvidence','conversationEvidence','notices']`, and `:567` requires `presentEvidenceKeys.length === RECALL_EVIDENCE_KEYS.length`. The reviewer noted the silent-drop risk. It verified worse: *adding* the key makes every pre-existing recall row — including rows already written into session inbound DBs — fail `isComplete` and render as `"malformed structured payload / No capability state was accepted from this row"` (`:569-577`), dropping trusted capability delivery for in-flight rows. |
| 5 | Cache + breaker are complexity compensating for main-thread sync (SHOULD-FIX) | **ACCEPTED** | Correct, and resolved as a consequence of #2 and #3 rather than separately: the corrected design deletes the cache, the strike counter, and the disable state, replacing all three with one measured boolean per workgroup. |

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

| field | value |
|---|---|
| requested target | Codex `gpt-5.6-sol` — still `unauthenticated`, not retried |
| target used | OpenCode CLI 1.18.9, **`opencode-go/grok-4.5`**, other-family |
| command | `opencode run -m opencode-go/grok-4.5 "$(cat <prompt>)"` |
| outcome | `completed` |
| raw verdict | `must_fix` — 2 MUST-FIX, 2 SHOULD-FIX |

Two transport notes worth keeping. A first foreground attempt hit the **Bash tool's
600 s cap**, which is below the contract's 3,600 s ceiling — not a `timeout` under the
contract's definition; reruns were backgrounded. A first background rerun then **silently
rotated to a different model** (`deepseek-v4-flash`) and failed uncredentialed. An
unpinned reviewer is a reproducibility hole in the review contract: **always pass `-m`.**

An additional Claude-family consult (Fable) was requested by the operator and spawned.
It is additive only — same family as the lead, so it adds a lens and **not** diversity.

### Findings — all verified against source before acceptance

| # | Claim | Verdict | Evidence traced |
|---|---|---|---|
| 1 | `domain_knowledge` must join **both** reason enums, not just the capture subset | **ACCEPTED (MUST-FIX)** | `curator-contract.ts:52-65` is the 12-value parent; `:73` is the subset declared `satisfies readonly CuratorReasonCode[]`; the provider JSON schema binds to the parent at `:134`; `parseModelDecision` re-validates against the parent at `:230`. Capture-only would not compile, and if forced would throw `curator reasonCode is invalid` on every domain decision — a feature capturing nothing. My draft was wrong. |
| 2 | The new marker regex group shifts capture indices and breaks the parser | **ACCEPTED (MUST-FIX)** | `parseGeneratedMemoryFacts` (`:157-165`) reads `match[1]/[2]/[3]` positionally. A capturing `reason` group after `id=` moves evidence to `[3]` and captured to `[4]`, so the evidence list reaches `Date.parse` and every reason-bearing fact throws `has invalid timestamp`. Fails closed, but fails every write. **Took the smaller fix than the reviewer proposed**: make the group non-capturing so indices are untouched and the consumer needs no change, rather than reindexing the consumer and extending `GeneratedMemoryFact`. Nothing in the write path needs the reason — only the audit does. |
| 3 | The "required enum protects against the premise-ledger failure" argument is false | **ACCEPTED (SHOULD-FIX)** | Correct, and it was my reasoning. The enum constrains how a decision is *labelled*, never whether the model captures. Noop → nothing written, nothing counted. Written as `durable_fact` → counted under that code. Either way the domain share stays flat while every string-level test passes. Claim withdrawn from P0.7 rather than softened; an offline fixture eval added as non-blocking evidence. |
| 4 | Stale `§5.4 (breaker) and §5.5 (cache)` cross-reference survives from revision 1 | **ACCEPTED (SHOULD-FIX)** | Confirmed at plan line 333. Revision 1's correction deleted the cache and replaced the breaker with warm-gating; the stale pointer invites reintroducing a rejected design during build. |

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

| field | value |
|---|---|
| target | Claude Fable 5, in-process subagent with source access |
| status | `completed` after two explicit requests (it idled twice before delivering) |
| verdict | **SOUND WITH CHANGES** |
| coverage | **Additive only.** Same model family as the lead, so under the cross-model contract it adds a lens and **not** diversity. The other-family requirement was met by grok-4.5. |

It verified all six briefed questions against source, checked both marker regexes
character by character, and confirmed via grep that only two parsers exist
(`curator-contract.ts:273` is a substring sniff; `CAPTURED_AT_PATTERN` is a loose search).
Findings accepted after independent verification:

| # | Claim | Verdict | Evidence traced |
|---|---|---|---|
| 5 | **P0-AC6 is unsatisfiable as written** | **ACCEPTED (MUST-FIX)** | The delivered excerpt text *includes* the marker: `toExcerpt` calls `boundedFactLine(candidate.content, …)` (`pre-turn-context.ts:962`) and `candidate.content` is the full line, marker attached, by deliberate design (`:735-744`). Two stores differing only by `reason=` therefore can never produce byte-identical excerpts. The guarded invariant is true — ranking scores the marker-stripped `searchable` (`:915`) — but the assertion would have failed a *correct* implementation, or been silently reinterpreted at build time. This was the one AC guarding a durable-store invariant, and neither the lead nor the other-family reviewer caught it. |
| 6 | `reason=` is per-**decision**, not per-fact | **ACCEPTED (SHOULD-FIX)** | `CuratorModelDecision` carries one `reasonCode`; the render loop (`curator-contract.ts:358-366`) stamps it on every fact in the batch. Multi-fact decisions are normal. Countability was the stated justification for the marker change, so the limit is now stated with it: the count is directional, not exact. |
| 7 | The enum-argument correction needs an (a)/(b) split | **ACCEPTED (SHOULD-FIX)** | Sharper than the other reviewer's version. Case (a) noop = real failure. Case (b) captured-but-mislabelled = **the intervention succeeded and only the counter missed it**, since recall does not read the reason. So the share is a *lower bound on domain capture*, not the outcome. P0.7 rewritten accordingly, and day-7 now requires spot-reading facts, not just counting. |
| 8 | Prompt-line citations off by one | **ACCEPTED** | Verified: `:415` is `Default to noop`, `:416` is the `Remember only …` whitelist, `:417` the roles line. Plan said 417/416. |
| 9 | "Only one placement satisfies both" is overstated | **ACCEPTED** | Before `id=` also satisfies both regexes. Chosen placement unchanged; the claim was softened. |
| — | Capture-group renumbering hazard | Already fixed in the first batch via the non-capturing group; Fable reached it independently. |

**The most valuable thing it produced was a pointer it explicitly refused to vouch for.**
It suggested `scripts/run-memory-provider-behavior-eval.ts` *might* be the shape needed and
said plainly it had not read the file. Following it up found a better one:
**`scripts/run-memory-curator-model-eval.ts` already exists** and already has
`CuratorEvalCase { transcript, expectedAction: 'capture'|'noop', acceptedReasons,
mustInclude, mustExclude }` over a JSON fixture with `baseline`/`hard` corpora.

Both reviewers independently proposed *building* an offline eval. The correct answer was
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
  never wrote an explicit approval — their last statement on the plan was that it was *not*
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

Verified before writing that the field would actually be *countable*:
`runMemoryCurationInBackground` (`curator-worker.ts:600-612`) spreads the report into
`log.info('memory-curator: episode complete', { ...report })`, so the new field reaches
`logs/nanoclaw.log` with no logging change. Without that spread the field would have been
countable in name only.

| check | result |
|---|---|
| `pnpm exec vitest run src/modules/memory/curator-worker.test.ts -t countable` (pre-implementation) | **failed as expected** — field absent |
| `pnpm exec vitest run src/modules/memory/` | 83 passed |
| `pnpm test` | **239 files, 3373 passed**, 1 skipped, 1 todo |
| `pnpm run build` | clean |
| diff | 2 files, 34 lines |

### Review — DID NOT COMPLETE. This is the blocker.

| field | value |
|---|---|
| requested target | Codex `gpt-5.6-sol` — `unauthenticated` since 2026-08-08, both credentials dead |
| substitute | OpenCode `opencode-go/grok-4.5`, other-family, model pinned |
| outcome | **killed at ~35 min with zero bytes written** |
| classification | **not `timeout`** — the contract's ceiling is 60 min and this ended before it. Closest to `empty-output`; the kill cause is not known to this session. |

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
   content as *unevidenced* rather than as *code-recoverable*, which would redirect the
   pillar-0 prompt fix at a different line.

### Not done at this stage

No production code written; planning is artifact-only. No tests materialized — per the
shared contract, `/team-build` writes the acceptance cases into the test tree after
approval, so a rejected plan leaves no trace in the product repository.

### Known risks carried into approval

Listed in `plan.md` §10. The two the operator must weigh: this plan builds pillar 1 and
sequences pillars 2–4 rather than designing all four, and no efficacy eval exists for the
memory system as a whole — the outstanding A/B remains unbuilt and is out of scope here.
