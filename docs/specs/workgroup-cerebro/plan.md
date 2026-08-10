# Workgroup cerebro — Pillar 0 (domain capture) and Pillar 1 (graph scent lane)

**Status:** proposed, revision 2, awaiting approval
**Approval state:** NOT approved. Revision 1 (pillar 1 only) was never approved and is
superseded; pillar 0 was added after evidence that the capture side is the binding
constraint. Approval of revision 1 would not carry to this revision.
**Stage:** `/team-plan`
**Behavior-changing:** yes — executable acceptance criteria apply.

**Build order: pillar 0, then pillar 1.** Pillar 1 is a retrieval fix; pillar 0 is a
capture fix. The measured defect (P0.1) is on the capture side, so shipping retrieval
first would treat the symptom. Pillar 0 is also the smaller change.

Pillar 0 sections are numbered `P0.n`; pillar 1 keeps `§n`.

---

## 1. Outcome

**Pillar 0.** The shared store must accumulate what the product *means* and *why it is
the way it is* — not only how the fleet operates. Today it accumulates almost only the
latter (P0.1), so judgment calls that need domain knowledge are made without it.

**Pillar 1.** An agent that is *confidently wrong* about its own workgroup should be told,
before it answers, that the knowledge graph holds material on the topic it is about to
answer from.

These are the two halves of one failure. The reference incident — an agent proposing a
Postgres-only fix while the two-store architecture sat in indexed source — needed *both*:
the architecture had never been captured as a domain fact (pillar 0), and nothing pointed
the agent at the source that held it (pillar 1).

Recall is **pull-only** for the graph today: the agent must decide to query Graphify,
which fails exactly when the agent is confident, because a confident agent has no reason
to look.

Pillar 1 adds a **scent**, not an answer: a short, bounded list of canonical file
pointers the graph considers most relevant to the current turn, delivered in the same
pre-turn context row that already carries memory and archive evidence. It tells the agent
*where to look*, and costs the agent nothing if it decides the pointers are irrelevant.

This deliberately preserves the operator's stated requirement (2026-08-06): the agent
must not be locked down to strict rules — it needs enough freedom to reason and be
creative, while knowing it has a brain with memory. A pointer list is a prompt to
curiosity. A mandatory query gate would be the rule-lock.

## 2. Scope

**In scope — pillar 0**

- One new curator capture reason code for product/business-domain knowledge.
- Two curator prompt changes: a domain capture line, and a scoping of the existing
  "recoverable from code/Graphify" prohibition.
- Persisting the capture reason in the fact provenance marker so the process/domain mix
  becomes auditable from the store.

**In scope — pillar 1**

- A new sync, read-only graph lookup module used by `buildPreTurnContext`.
- A new bounded `graphScent` field on `PreTurnContext` with its own char budget and its
  own position in the final-bound eviction order.
- Warm-gating and degradation behavior for that lookup.
- Container-side rendering of the new field so the agent actually sees it.

**Out of scope (non-goals)**

- Backfill. The curator only ever sees new episodes; pillar 0 changes what is captured
  from here on and does not distil the existing archive. Stated because it is the
  obvious next question and the answer is no.
- Any change to Graphify's schema, extractors, daemon, or node types.
- Any *mandatory* graph query, tool call, or gate before the agent answers.
- A total match count (see §4.1 — measured unaffordable).
- Pillars 2–4 (§9). This plan does not design them.
- Rewriting or reclassifying existing facts. Markers stay backward compatible; old facts
  simply carry no reason (P0.3).

## P0 — Pillar 0: domain capture

### P0.1 The measured defect

Classifying all 2,505 facts in the largest live store by content:

| class | share |
|---|---|
| process-leaning (PRs, deploys, gates, tests, containers, routing) | **47.8%** |
| product/domain-leaning (customers, forecasting, pricing, volume, inventory) | **11.9%** |
| both or neither | 40.3% |

A 4:1 bias against the product. `memory/methods/` — 90 files, 279 KB, procedural by
construction — is the fastest-growing part of the tree, so the imbalance is widening. The
method-memory work shipped 2026-08-06 is a large part of why: it worked, and what it
accelerated was process.

The classification is keyword-based and therefore approximate. It does not need to be
precise: a 4:1 ratio survives a wide margin of error, and P0.3 makes the mix directly
countable afterwards so this estimate never has to be repeated.

### P0.2 Root cause — domain knowledge has exactly one capture path, and it is reactive

The curator system prompt (`src/modules/memory/curator-contract.ts:414-421`) is explicit
about what is capturable:

- **Line 416** enumerates the categories: *"explicit durable decisions, corrections,
  stable cross-task preferences, verified outcomes, durable workflows, and durable facts
  about people, organizations, and external systems"*. The product and business domain
  are **not** in that list. People/organizations/systems were added 2026-08-06 (the supporting roles line is :417);
  the domain never was.
- **Line 420** prohibits *"facts recoverable from code/Graphify"*. Product structure —
  what a dataset represents, how a metric is defined, what a pipeline does — reads as
  recoverable from code, so this rule preferentially discards exactly this class.
- **Line 419** is the single carve-out: *"When a person corrects an agent's wrong
  assumption about how a system works, capture the corrected fact even if it looks
  recoverable from code."*

So domain knowledge is capturable **only after a human catches an agent being wrong.**
That is precisely how the two-store architecture finally landed: as a correction, after
the incident. Nothing lets the fleet learn its own product proactively.

`CURATOR_CAPTURE_REASON_CODES` (`curator-contract.ts:73`) is
`durable_fact, explicit_decision, correction, stable_preference, durable_workflow` —
two of five explicitly process-shaped, none domain-shaped.

**Precedent this design copies.** The people/roles gap was the same shape and was closed
the same way: one category added to line 416 plus one supporting line on 2026-08-06. Three
days later the store held 33 person facts including the two the operator had specifically
flagged as missing. One prompt category, zero new machinery, measurable within days.

### P0.3 Design

**(a) New reason code `domain_knowledge`, added to BOTH arrays.** Corrected after review —
the first draft said "append to `CURATOR_CAPTURE_REASON_CODES`", which does not work:

- `CURATOR_REASON_CODES` (`curator-contract.ts:52-65`) is the full 12-value enum — seven
  codes that explain a noop (`duplicate`, `insufficient_evidence`, `transient`,
  `speculative`, `code_derived`, `capability_state`, `sensitive`) plus the five capture
  codes.
- `CURATOR_CAPTURE_REASON_CODES` (`:73`) is the capture subset, declared
  `satisfies readonly CuratorReasonCode[]` — so a value absent from the parent fails to
  typecheck.
- The provider JSON schema binds `reasonCode` to `CURATOR_REASON_CODES` (`:134`), and
  `parseModelDecision` re-validates against the same parent list (`:230`).

Capture-list-only would therefore not compile, and if forced through, every
`domain_knowledge` decision would be rejected with `curator reasonCode is invalid` —
a feature that silently captures nothing. Add to the parent first, then the subset.

A distinct code rather than reuse of `durable_fact`, because the whole point is that the
mix must be countable (P0.1 had to be estimated by keyword because it is not).

**(b) One capture line**, mirroring the phrasing that worked for people/roles:

> Durable facts about the product and business domain are capturable: what a system,
> dataset, or metric represents in business terms; how a metric is defined; why an
> architecture, model, or tradeoff was chosen and what was accepted in exchange; who the
> product serves and what they need. Capture the meaning and the reasoning, not the
> implementation that can be read from the code.

The final clause is what makes this coexist with the prohibition rather than fight it.

**(c) Scope the prohibition** (line 420) from *"facts recoverable from code/Graphify"* to
*"implementation details recoverable from code/Graphify"*, with one added sentence: *"What
code means in business terms, and why it was chosen, is not recoverable from code."*

This is a scoping, not a deletion. Code answers *what*; it does not answer *what this
means to the business* or *why this over the alternative*. The existing correction
carve-out (line 419) stays as-is.

**(d) Persist the reason in the provenance marker.** Today
(`curator-contract.ts:365`) a fact is written as:

```
- <text> <!-- nanoclaw-memory:id=<id>;evidence=<ids>;captured=<iso> -->
```

**Field order is load-bearing** — two regexes pin it:

| parser | pattern | constraint |
|---|---|---|
| `curator-contract.ts:120` | `id=(...);evidence=(...);captured=([^;\s]+)\s*-->` | `captured` must stay **last**, or `\s*-->` fails |
| `scripts/audit-memory-splitting.ts:38` | `evidence=([^;]+);captured=([^\s]+?)\s*-->` | `captured` must stay **immediately after** `evidence` |

Between `id` and `evidence` satisfies both. (Before `id=` also would; the chosen
placement keeps the id first, which is how every existing marker reads.)

```
- <text> <!-- nanoclaw-memory:id=<id>;reason=<code>;evidence=<ids>;captured=<iso> -->
```

The `curator-contract.ts:120` regex gains an optional group after `id=`. **That group must
be NON-capturing** — `(?:;reason=[a-z_]+)?`, not `(?:;reason=([a-z_]+))?`. Corrected after
review; the first draft had it capturing, which is a build-breaker:

`parseGeneratedMemoryFacts` (`curator-contract.ts:157-165`) reads the match **positionally**
— `match[1]` id, `match[2]` evidence, `match[3]` captured. A new capturing group after
`id=` shifts evidence to `[3]` and captured to `[4]`, so `match[3]` (now the evidence list)
reaches `Date.parse` and every reason-bearing fact throws
`generated memory ... has invalid timestamp`. It fails closed rather than corrupting, but
it fails every curator write.

Non-capturing keeps all existing indices intact, so `parseGeneratedMemoryFacts` needs no
change at all. The reviewer's alternative — reindex the consumer and extend
`GeneratedMemoryFact` — also works and was rejected as the larger diff: nothing in the
write path needs the reason, only the audit does.

The reason is read where it is actually needed by a separate loose pattern,
`REASON_PATTERN = /reason=([a-z_]+)/`, exactly as `CAPTURED_AT_PATTERN`
(`pre-turn-context.ts:729`) already does for the timestamp.

Every existing marker still parses unchanged and no migration is needed — rewrites copy
old lines verbatim (`preservedLines`, `curator-contract.ts:342`), so nothing rewrites a
legacy fact. `audit-memory-splitting.ts` is untouched.

**The reason is per-DECISION, not per-fact — and countability is the stated justification
for this change, so the limit belongs here.** `CuratorModelDecision` carries a single
`reasonCode`, and the render loop at `curator-contract.ts:358-366` stamps that one code
onto every fact in the batch. Multi-fact decisions are normal — `audit-memory-splitting.ts`
exists precisely to study them. So a mixed batch (one domain fact plus two workflow facts)
labels all three identically.

The resulting count is therefore **directional, not exact**: a lower bound with
batch-level noise, better than P0.1's keyword estimate but not a clean measurement. Making
it per-fact would mean a per-candidate reason in the output schema — a larger change to the
model contract than this pillar justifies. Read the number as a trend and spot-check the
facts behind it (P0.7).

**(e) Log the reason code on every curator decision.** `MemoryCuratorRunReport`
(`curator-worker.ts:54`) carries `action` but not `reasonCode`, so the curator computes a
reason for every decision — *including each noop* — and the value is discarded
(`curator-worker.ts:460-470`). Confirmed: zero occurrences of any noop reason code in the
live logs.

This matters more than it looks. `code_derived` is one of the noop codes, and it is the
machine-readable footprint of the exact prohibition P0.2 blames. Surfacing it turns
P0.1's keyword estimate into a **direct count of the suppression as it happens**, and
gives a genuine pre/post baseline. It also makes the premise falsifiable *before* the
prompt change ships: if `code_derived` noops turn out to be rare, the causal story in
P0.2 is wrong and pillar 0 needs rethinking rather than building. Two lines.

Retrieval impact is nil by construction: `readMemoryEvidence` scores `line.slice(0, markerAt)`
(`pre-turn-context.ts:915`), so nothing inside the marker has ever influenced ranking.
`boundedFactLine` (`pre-turn-context.ts:745`) measures the marker at runtime, so a longer
marker costs a few characters of prose budget only on facts that were already over-length.

### P0.4 Invariants

- P0-I1. Existing fact markers parse unchanged; no rewrite, migration, or backfill.
- P0-I2. Nothing inside a marker affects retrieval ranking.
- P0-I3. The correction carve-out (line 419) keeps working; scoping the prohibition
  must not narrow what corrections can capture.
- P0-I4. The prohibition still blocks secrets, transient status, speculation, and raw
  output. Only the *"recoverable from code"* clause is scoped.

### P0.5 Acceptance criteria

In `src/modules/memory/curator-contract.test.ts` unless noted.

| # | Test name | Assertion |
|---|---|---|
| P0-AC1 | `curator-contract > accepts domain_knowledge as a capture reason code` | A decision with `reasonCode: 'domain_knowledge'` and `supersedesMemoryIds` validates; the pre-fix contract rejected it. |
| P0-AC2 | `curator-contract > writes the reason between id and evidence` | A rendered fact line matches `id=<id>;reason=domain_knowledge;evidence=`. |
| P0-AC3 | `curator-contract > parseGeneratedMemoryFacts reads a legacy marker unchanged` | Assert against the **consumer**, not the regex: `parseGeneratedMemoryFacts` on a marker with no `reason=` returns the correct `id`, `evidenceIds`, and `capturedAt`. Backward-compat guard for P0-I1. |
| P0-AC4 | `curator-contract > parseGeneratedMemoryFacts is unshifted by a reason-bearing marker` | Same function on a `reason=`-bearing marker returns the same three fields correctly. This is the group-index regression guard — it fails with `invalid timestamp` if the new group is ever made capturing. |
| P0-AC5 | `audit-memory-splitting > still parses reason-bearing markers` (in `scripts/audit-memory-splitting.test.ts`) | Its `MARKER` regex extracts evidence and captured from a reason-bearing line unchanged. The field-order regression guard. |
| P0-AC6 | `pre-turn-context > the reason field does not affect ranking` (in `pre-turn-context.test.ts`) | Two fact stores differing only by `reason=` produce **the same excerpts in the same order** — compare the ranked `path` sequence and each excerpt's text **with the marker stripped**. Guards P0-I2. **Do not assert byte-identical excerpt text**: the delivered text deliberately keeps the marker (`boundedFactLine`, `pre-turn-context.ts:962`, docstring at `:735-744`), so a byte comparison is unsatisfiable and would fail a correct implementation. |
| P0-AC7 | `curator-contract > the system prompt states the domain capture category` | The composed system prompt contains the domain line and the scoped prohibition, and still contains the correction carve-out verbatim. Guards P0-I3; the prompt is the deliverable, so it is asserted directly. |
| P0-AC8 | `curator-worker > the run report carries the reason code` | A noop decision with `reasonCode: 'code_derived'` produces a `MemoryCuratorRunReport` whose `reasonCode` is `code_derived`. Guards P0.3(e); today the field does not exist. |

**What these criteria do NOT prove — stated because the reviewer was right to press it.**
Every case above locks strings, marker shape, index stability, and ranking neutrality.
**None of them fails if the curator simply keeps nooping domain content.** A green P0 suite
is evidence the plumbing is correct, not that behavior changed.

**Offline episode replay closes most of that gap, and the harness already exists.**
`scripts/run-memory-curator-model-eval.ts` runs real transcripts through the curator and
scores the decisions. Its `CuratorEvalCase` already carries exactly the fields needed —
`transcript`, `expectedAction: 'capture' | 'noop'`, `acceptedReasons`, `mustInclude`,
`mustExclude` — over a JSON fixture with `baseline` and `hard` corpora.

So the pre-deploy check is **fixture data, not new code**: add 10–20 archived episodes
known to contain domain statements (the pre-correction two-store discussion is the
canonical one; P0.1's classifier surfaces more) with `expectedAction: 'capture'` and
`acceptedReasons: ['domain_knowledge']`, then run the eval under the old prompt and the
new one and diff. **If the new prompt does not flip a known-domain episode from noop to
capture in replay, it will not do it live either** — and that is learned before touching
the durable store.

The fixture is `tests/fixtures/workgroup-memory-curator.json` — 16 cases today across
`baseline` and `hard`. `curatorCorpusSha256` (`:156`) pins it, so adding cases requires
updating the recorded hash. That is the intended workflow, not an obstacle.

**The negative case pillar 0 needs is already in the fixture.** Case `code-derived`
(baseline) is a transcript stating which function a router calls in a named source file,
with `expectedAction: 'noop'` and `acceptedReasons: ['code_derived']`. That is pure
implementation detail, so under the scoped prohibition it must **still noop** — the
scoping only admits meaning and rationale, not call sites.

That makes step 4 a real two-sided boundary test rather than a one-way check:

- **positive:** new domain cases must flip `noop → capture` with `domain_knowledge`;
- **negative:** the existing `code-derived` case must keep nooping, unchanged.

If scoping the prohibition over-widens, the second half fails and says so before deploy.
A one-sided eval could not have caught that.

This is *mechanism* evidence: the prompt change flips real capture decisions. It is not
*outcome* evidence — replay cannot say how much domain content will actually flow through
future episodes (P0.7). Both are needed; neither substitutes for the other, and P0-AC7's
string assertion is neither.

Credit where due: this harness was found by following a reviewer's explicitly
unverified pointer. Both reviewers proposed *building* an eval; the smallest correct
answer was that one already exists.

### P0.6 Implementation path

**Step 0 is a decision point, not a formality.**

0. **Log the reason code and look at it before building the rest.** P0.3(e) only —
   `reasonCode` onto `MemoryCuratorRunReport`. Satisfies P0-AC8. Deploy, wait a few days,
   count noop reasons. **If `code_derived` noops turn out to be rare, stop: P0.2's
   diagnosis is wrong and steps 1–3 would be building on a bad premise.** Two lines, and
   the only cheap way to falsify the whole pillar before committing to it.
   Check: `pnpm exec vitest run src/modules/memory/curator-worker.test.ts`
1. **Reason code + marker.** `domain_knowledge` into **both** enums
   (`curator-contract.ts:52-65` first, then `:73`), the render at `:365`, and the
   **non-capturing** optional group in the regex at `:120`, plus `REASON_PATTERN` where
   the audit needs it. Satisfies P0-AC1–AC5.
   Check: `pnpm exec vitest run src/modules/memory/curator-contract.test.ts scripts/`
2. **Prompt changes.** The domain line and the scoped prohibition. Satisfies P0-AC7.
   Same check.
3. **Ranking guard.** Satisfies P0-AC6. Check: `pnpm exec vitest run src/modules/memory/`
4. **Offline episode replay — the pre-deploy gate.** Add the domain cases to
   `scripts/run-memory-curator-model-eval.ts`'s JSON fixture and update
   `curatorCorpusSha256`. Run under the old prompt and the new one.
   **Gate: the new prompt must flip at least one known-domain episode from noop to
   capture.** If it flips none, the prompt change does not work and steps 1–3 should be
   revised rather than deployed. Output into `run.md`.
5. **Deploy and measure.** After 7 days: count facts by `reason=` from the store (a
   directional lower bound — see P0.3(d)), compare the domain share against the 11.9%
   baseline, re-run the replay, and **spot-read the actual new facts** rather than trusting
   the count alone. Record all four in `run.md`. No numeric gate — see §10.

### P0.7 Risks

| Risk | Assessment |
|---|---|
| The category produces noise instead of domain knowledge | The real risk. `Default to noop` (`curator-contract.ts:415`) still governs, and the people/roles precedent produced 33 facts with no observed noise complaint. If it does go noisy the retreat is deleting one prompt line. |
| Scoping the prohibition re-admits code trivia | Mitigated by the "meaning and reasoning, not implementation" clause, and now countable: a rising `domain_knowledge` share that reads as restated code is visible in a way it was not before. |
| **A curator model ignores the new category — the top risk** | An earlier draft argued the required enum *prevents* the premise-ledger failure. **Withdrawn: the enum delivers detection, not prevention.** `Default to noop` (`curator-contract.ts:415`) is the standing instruction and a noop on domain content is schema-valid, so nothing structural forces capture. Two outcomes, and they are not the same failure: **(a)** the curator noops domain content — a real failure, and the share stays flat; **(b)** it captures the fact but labels it `durable_fact` — **the intervention succeeded** and only the counter missed it, since agents get the fact at recall time regardless of its label. So the `domain_knowledge` share is a **lower bound on domain capture, not the outcome itself**; a flat reading at day 7 must be spot-checked against the actual new facts before concluding failure. What genuinely supports "capture will change" is the people/roles precedent — same prompt, same seam, same edit type, measurable in 3 days — which is **empirical evidence, not a structural guarantee**, plus the replay in P0.5. |
| The 7-day readout is confounded by episode mix | P0.1 measured the **store** mix, not the **discard** mix. If little domain content flows through chat, the share moves slowly however good the prompt is. P0.3(e) addresses this directly by measuring the discard side, which is the other half of the picture and the reason step 0 comes first. |
| 7 days is too short to judge | Possible. The people/roles category was legible in 3. If the signal is ambiguous at 7 days the answer is to wait, not to tune. |
| The premise in P0.2 is wrong | Newly *checkable* thanks to P0.3(e): if `code_derived` noops are rare once logged, the suppression story is wrong. Cheapest de-risking available — land P0.3(e) first, look at a few days of counts, and only then decide whether the prompt change is worth making. |

## 3. Current architecture (source evidence) — pillar 1

### 3.1 The pre-turn path is synchronous

`buildRecallRow` (`src/session-manager.ts:560`) builds the recall row inline while
writing the inbound message, calling `buildPreTurnContext` (`src/session-manager.ts:578`)
synchronously. `buildPreTurnContext` (`src/modules/memory/pre-turn-context.ts:1243`) is a
sync function throughout — `getDb()`, `fs.readSync`, `searchArchiveEvidence`.

**Consequence:** the Graphify daemon client is unusable here.
`sendGraphifyRequest` (`src/graphify/client.ts:103`) is `async`, over a Unix socket, with
a 30 s default timeout. Making the pre-turn path async to accommodate it would refactor
the message-write path for one advisory lane. Rejected.

### 3.2 The graph store is a synchronous SQLite store with a read-only mode

`WorkgroupGraphStore` (`src/graphify/store.ts:128`) wraps `better-sqlite3` and accepts
`{ readonly: true, fileMustExist: true }`. WAL is enabled by the writer, so a reader sees
the last committed snapshot while background reconcile workers mutate
(`src/graphify/store.ts:113-118` comment). The graph lives at
`<DATA_DIR>/graphify/workgroups/<workgroupId>/index.db` (`src/graphify-daemon/daemon.ts:1242`).

This is the seam Pillar 1 uses.

### 3.3 The final-bound eviction order is load-bearing

`enforceFinalBound` (`src/modules/memory/pre-turn-context.ts:1157`) evicts in a fixed
order: conversation excerpts → memory excerpts → halve memory core → capabilities →
remaining conversation excerpts. Two prior incidents are recorded in the bounds comments
(`pre-turn-context.ts:16-87`): capabilities silently consuming the whole budget and
starving recall, and long facts evicting the entire archive lane. A new lane must declare
its own total and its own eviction position, or it repeats those incidents.

### 3.4 Notices are hard-capped at 120 characters

`enforceFinalBound` runs `notice.detail = boundedText(notice.detail, 120, ...)`
(`pre-turn-context.ts:1195`) over **every** notice unconditionally.

**Consequence:** the originally recorded design — "a few-hundred-char notice line" — is
not implementable as a notice. 120 characters does not hold five file paths. The scent
must be a first-class field, not a notice.

## 4. Measurements that constrain the design

Taken 2026-08-08 against the live host graphs, read-only.
Probe: bounded FTS5 query against `node_fts` joined to `sources`.

Corpus (workgroup A, the largest on this host): 337,091 nodes, 142,144 indexed sources, 7.6 GB.
Source prefixes: `agents/` 117,928 · `workgroup/` 18,734 · `conversations/` 5,522.

### 4.1 A match count is unaffordable — the recorded scope is wrong here

| query shape | latency |
|---|---|
| `count(*)` on one common term (`postgres`, 23,700 hits) | **48,405 ms** |
| `count(*)` on an OR of three terms (50,267 hits) | **25,494 ms** |
| `count(*)` on one rare term (3,687 hits) | 4,277 ms |
| same query, `LIMIT 8`, no count | **0–1 ms** warm |

FTS5 can stop early for a bounded query and cannot for a count. The recorded pillar-1
scope said "match count + top node/file titles". **The count must be dropped.** The
"6,164 matches" figure that motivated the pillar is precisely the number that costs
25–48 seconds to produce on the hot path.

This is not a downgrade. A count is a weak signal anyway — every broad query matches
thousands of chunks. The pointers are the signal.

### 4.2 Ordering choice is a 125× latency difference *and* a relevance difference

| shape | latency (workgroup A, a four-term architecture query) |
|---|---|
| `ORDER BY node_fts.node_id` + join (what `store.query` does) | **92,232 ms** |
| `ORDER BY rank` (bm25) | **737 ms** cold |
| `ORDER BY rank` + `relative_path LIKE 'workgroup/%'` | **132 ms** cold, 118 ms warm |

`store.query` (`src/graphify/store.ts:499`) orders by `node_fts.node_id`, which for a
broad term forces reading the whole match set. **Pillar 1 must not reuse `store.query`.**

### 4.3 The canonical-path filter is both the latency fix and the relevance fix

Without it, results are dominated by duplicate worktree copies — one mapper source file
returned **8 times** from 8 different `agents/<id>/<worktree>/` clones, and a staging SQL
model 3 times. `agents/` is 83% of workgroup A's indexed
sources and is stale-clone noise (see the recorded `worktree-clone-no-autoclean` note).

`conversations/` is excluded for a different reason: the pre-turn context **already** has
a dedicated archive lane over the same conversations
(`searchArchiveEvidence`, `pre-turn-context.ts:1398-1451`). The scent lane's job is to
point at what the other lanes cannot reach.

With `LIKE 'workgroup/%'`, sampled results are legible and on-target:

| query | top canonical pointers |
|---|---|
| people | a hand-written client-liaison roster `.md`, several `linear-*.md`, a deployment-source reference `.md` |
| release | two release shell scripts and two cutover runbook `.md` files |
| feature | the two interface files that define that feature's result type |

### 4.4 Cross-workgroup latency envelope

Cold, canonical-filtered, `LIMIT 24`, across four live workgroup graphs (7.6 GB, 2.2 GB,
94 MB, 94 MB): 197 ms · 761 ms · 449 ms · 593 ms. Warm: 0–120 ms. Handle open:
0.2–4.3 ms. A total miss: 0–10 ms.

**Worst observed cold latency is ~800 ms.** That is the number the design must survive,
and it is why §5.4 (warm-gating) exists rather than being speculative
hardening. For reference, the memoization shipped on 2026-07-29 removed 875 ms/turn — this
lane must not quietly hand that back.

### 4.5 The FTS index is unstemmed

`node_fts` is declared with no `tokenize=` clause (`src/graphify/store.ts:935`), so it
uses the default `unicode61` — **no stemming**.

`canonicalToken` (`pre-turn-context.ts:281`) *does* stem: `materialized` → `materializ`,
`columns` → `column`, and it collapses `manages`/`managed`/`managing` **and**
`host`/`hosts`/`hosted` to the single token `host`.

**Consequence:** feeding `tokenizeForRecall` output to FTS would (a) miss, because
`materializ` is not a term in an unstemmed index, and (b) semantically drift, because
"who *manages* the pipeline" becomes a search for `host`. The scent lane must build its
own terms from the raw query — reusing `STOP_WORDS` but not `canonicalToken` — and use
FTS prefix matching (`"term"*`) to recover morphological variants.

### 4.6 A cached DB handle would be a correctness bug

The daemon builds `index.next-<hash>.db` and renames it over `index.db`
(`src/graphify-daemon/daemon.ts:1245-1247`, cleanup at `:2021`). A cached file descriptor
survives the rename pointing at the **deleted inode**, so a long-lived host process would
serve a permanently stale graph. Open per call. Measured at 0.2–4.3 ms, so this is the
cheap option as well as the correct one.

## 5. Design

New module: **`src/modules/memory/graph-scent.ts`**. No changes to `src/graphify/`.

### 5.1 Interface

```ts
export interface GraphScentPointer {
  /** Workgroup-relative canonical path, e.g. "workgroup/<repo>/.../volume.service.ts". */
  path: string;
  /** Graph node type: code | structured | document_chunk | … */
  type: string;
}

export interface GraphScent {
  /** The prefix terms actually searched, so the agent can widen or narrow. */
  terms: string[];
  pointers: GraphScentPointer[];
}

/** Sync, bounded, never throws. Returns null when cold, unavailable, or empty. */
export function readGraphScent(
  workgroupId: string,
  query: string,
  notices: ContextNotice[],
): GraphScent | null;

/**
 * Called off the hot path (host sweep). Runs one bounded probe query and marks the
 * workgroup warm when it completes inside the budget. Returns the elapsed ms.
 */
export function probeGraphScentWarmth(workgroupId: string): number;
```

`PreTurnContext` gains `graphScent?: GraphScent`.

### 5.2 Term construction

Tokenize the raw query with the existing `/[\p{L}\p{N}_-]{2,}/gu` pattern, lowercase,
drop `STOP_WORDS`, dedupe, keep the **longest** `graphScentTerms` (8) — longer tokens
carry more signal than short ones and this bounds the OR fan-out. Emit
`"tok1"* OR "tok2"* OR …`. Fewer than 2 surviving terms → return `null` (a one-token
scent is noise).

`STOP_WORDS` is reused as-is. `canonicalToken` is deliberately **not** used (§4.5).

### 5.3 Query

```sql
SELECT s.relative_path AS path, n.type AS type
  FROM node_fts
  JOIN sources s ON s.id = node_fts.source_id
  JOIN nodes   n ON n.id = node_fts.node_id
 WHERE node_fts MATCH ?
   AND s.workgroup_id = ?
   AND s.state = 'indexed'
   AND s.relative_path LIKE 'workgroup/%'
 ORDER BY rank
 LIMIT 24
```

Opened with `{ readonly: true, fileMustExist: true }` and `busy_timeout = 250` — fail
fast rather than stall a turn behind a WAL checkpoint. Handle closed in `finally`.

Post-process: deduplicate by **basename**, keep first (highest-ranked) occurrence, take
the top `graphScentPointers` (5). Basename dedupe is what collapses the residual
duplicate-clone families that survive the canonical filter (§4.3).

### 5.4 The cold query never runs on a turn — warm-gating

This replaces both a breaker and a result cache. Corrected after plan review; the
reasoning is recorded because the discarded design is the obvious one.

`buildRecallRow` runs synchronously inside `writeSessionMessage`
(`src/session-manager.ts:813`, with the inbound DB handle open), in the host's **single**
Node process. A synchronous `better-sqlite3` read there does not slow one turn — it stalls
routing, delivery, and the sweep for **every** session, and `better-sqlite3` exposes no
way to interrupt a query in flight. At the measured cold cost of up to ~800 ms (§4.4)
that is not acceptable, and a breaker cannot help: a threshold above the measured cold
cost never fires, and one below it disables the lane on nearly every workgroup.

So the cold cost is moved off the turn path entirely:

- **`host-sweep.ts` probes one workgroup per 60 s sweep, round-robin.** One bounded query
  (§5.3) with a fixed probe term. Elapsed ≤ `GRAPH_SCENT_BUDGET_MS` (300) marks the
  workgroup **warm**; over budget, or a throw, unmarks it. Worst case adds one ~800 ms
  probe to one sweep — a batch timer, not a user turn.
- **`readGraphScent` queries only a warm workgroup.** Cold → `null` plus a
  `graph-scent-cold` notice, costing nothing. Warmth is measured, so "warm" means "this
  graph answered inside budget within the last sweep cycle".
- After a host restart no workgroup is warm; warmth converges at one per minute. An
  advisory lane being absent for the first minutes is the correct trade.

Warmth tracks OS page-cache residency, which the measurements show is the dominant term
(cold 197–761 ms vs warm 0–120 ms, §4.4). A fixed probe term is an approximation of a
real query's cost, not a guarantee — stated in the code, not hidden.

**No result cache.** An earlier draft cached pointer lists by workgroup + terms. That
reintroduces exactly the staleness §4.6 rejects for handles: the daemon renames a fresh
`index.db` into place, and a keyless cache would serve pre-promote pointers until it was
cleared. Warm queries cost 0–120 ms, so the cache bought little and cost a correctness
question. Dropped.

### 5.6 Degradation

Every failure path returns `null` plus one notice, never throws:

| condition | notice code | status |
|---|---|---|
| `index.db` absent (incl. mid-rename `ENOENT`) | `graph-scent-unavailable` | `degraded` |
| open or query threw | `graph-scent-read-failed` | `degraded` |
| workgroup not warm (§5.4) | `graph-scent-cold` | `degraded` |
| fewer than 2 usable terms, or 0 pointers | `graph-scent-no-match` | `no-match` |

`ContextNotice['source']` gains `'graph'`.

### 5.7 Budget and eviction

New bound `graphScentChars: 600` in `PRE_TURN_BOUNDS`, enforced by dropping
lowest-ranked pointers before the field is attached. Five paths plus types fits
comfortably; the bound exists so a pathological path length cannot blow the lane.

In `enforceFinalBound`, `graphScent` is deleted **first — before any other lane**.
Corrected after plan review: an earlier draft shed it after conversation excerpts, which
would let 600 chars of advisory pointers push a previously-fitting turn over `finalChars`
and evict a real archive excerpt in their place. That directly violates invariant 5.
Shedding the scent first makes invariant 5 hold by construction rather than by argument,
which is the lesson of both prior budget incidents (§3.3).

### 5.8 Container rendering

The container renders the recall row's `subtype: 'recall_context'` in
`container/agent-runner/src/formatter.ts`. Two constraints, both load-bearing:

1. **`graphScent` must NOT be added to `RECALL_EVIDENCE_KEYS`** (`formatter.ts:528`).
   That constant is a closed three-key list, and `isComplete` requires every key be
   present (`formatter.ts:567`). Adding a fourth key makes every recall row written
   before the change — including rows already sitting in session inbound DBs — fail the
   completeness check and render as *"malformed structured payload / No capability state
   was accepted from this row"* (`formatter.ts:569-577`), silently dropping trusted
   capability delivery for in-flight rows. `graphScent` is rendered **when present** and
   is never part of completeness.
2. It is rendered inside the existing untrusted-evidence envelope, as terms plus pointer
   paths. Exact wording is a build detail; the **invariant** is that it never reads as an
   instruction to query. It is a pointer list, not a gate (§1).

## 6. Invariants

1. The pre-turn path stays synchronous. No `await` is introduced into `buildRecallRow`.
2. `readGraphScent` never throws; every failure degrades to `null` + a notice.
3. No total match count is ever computed (§4.1).
4. Neither the graph handle nor the pointer list is cached, so a daemon index promote is
   always observed (§4.6, §5.4).
5. **Enabling the lane never reduces the number of memory or archive excerpts delivered**
   — at any budget, not only below the final bound. Guaranteed structurally by shedding
   `graphScent` first (§5.7), not by fixture choice.
6. No graph query runs on the message-write path unless that workgroup measured inside
   `GRAPH_SCENT_BUDGET_MS` on a recent sweep (§5.4).
7. The lane is advisory. No code path requires the agent to act on it.
8. `agents/` and `conversations/` sources never appear as pointers.
9. A recall row without `graphScent` renders exactly as it does today (§5.8).

## 7. Acceptance criteria — exact cases for `/team-build`

New file `src/modules/memory/graph-scent.test.ts` unless noted. Fixtures build a small
real graph with `WorkgroupGraphStore` (writable) then read it back — no mocking of SQLite.

| # | Test name | Assertion |
|---|---|---|
| AC1 | `graph-scent > builds unstemmed prefix terms from the raw query` | `graphScentTerms('Which columns does the materialized view expose?')` returns terms containing `materialized` and `columns` verbatim (not `materializ`/`column`), excludes `which`/`does`/`the`, and every emitted FTS term ends in `*`. |
| AC2 | `graph-scent > returns fewer than two terms as null` | `readGraphScent(wg, 'the a is', notices)` is `null`; notices contain `graph-scent-no-match`. |
| AC3 | `graph-scent > orders pointers by bm25 rank` | Fixture where one source repeats the term far more; that source's path is `pointers[0].path`. |
| AC4 | `graph-scent > deduplicates by basename, keeping the highest ranked` | Fixture with `workgroup/a/x.ts` and `workgroup/b/x.ts` both matching; exactly one pointer whose basename is `x.ts`. |
| AC5 | `graph-scent > excludes agents/ and conversations/ sources` | Fixture with one matching source under each of `agents/`, `conversations/`, `workgroup/`; result contains only the `workgroup/` path. |
| AC6 | `graph-scent > returns null and a degraded notice when the graph is absent` | Call against a workgroup with no `index.db`: returns `null`, does not throw, notices contain `graph-scent-unavailable` with status `degraded`. |
| AC7 | `graph-scent > observes an index swap because nothing is cached` | Warm the workgroup, query graph A, then rename a differently-populated graph B over `index.db` and query again **with the identical query string**: the second call returns B's pointers. Identical terms are the point — a result cache would fail this. |
| AC8 | `graph-scent > does not query a cold workgroup` | Without a warmth probe, `readGraphScent` performs **zero** graph opens (counted via injected opener), returns `null`, and emits `graph-scent-cold`. |
| AC9 | `graph-scent > a probe inside budget marks the workgroup warm` | `probeGraphScentWarmth` with an injected clock reporting 100 ms → the next `readGraphScent` queries and returns pointers. |
| AC10 | `graph-scent > a probe over budget leaves the workgroup cold` | Injected clock reports 900 ms (over `GRAPH_SCENT_BUDGET_MS`) → the next `readGraphScent` performs zero opens and emits `graph-scent-cold`. A previously warm workgroup that probes over budget is unmarked. |
| AC11 | `pre-turn-context > attaches the graph scent within its char bound` (in `pre-turn-context.test.ts`) | `JSON.stringify(context.graphScent).length <= PRE_TURN_BOUNDS.graphScentChars`. |
| AC12 | `pre-turn-context > the graph scent never displaces memory or archive excerpts` (in `pre-turn-context.test.ts`) | **Two fixtures**: (a) every lane filled but under `finalChars`; (b) a lane set sized so that attaching the scent tips the context *over* `finalChars`. In both, memory-excerpt and archive-excerpt counts equal the no-scent baseline. Fixture (b) is the case the pre-review eviction order would have failed. |
| AC13 | `pre-turn-context > sheds the graph scent before any other lane` (in `pre-turn-context.test.ts`) | Fixture pushed over `finalChars`: `graphScent` is `undefined` while every conversation and memory excerpt from the no-scent baseline survives. |
| AC14 | `formatter > renders graphScent when present` (in `container/agent-runner/src/formatter.test.ts`, `bun:test`) | A `recall_context` payload carrying `graphScent` renders its terms and pointer paths inside the untrusted-evidence envelope. |
| AC15 | `formatter > a recall row without graphScent still renders complete` (same file) | A payload with only the three legacy evidence keys renders the normal complete output — **not** the `malformed structured payload` branch. This is the in-flight-row regression guard for §5.8(1). |

## 8. Implementation path

Each step is one ownership boundary and ends with a runnable check.

1. **`graph-scent.ts` — terms + query + degradation.** Exports `graphScentTerms`,
   `readGraphScent`, and the bounds. Satisfies AC1–AC7.
   Check: `pnpm exec vitest run src/modules/memory/graph-scent.test.ts`
2. **Warm-gating.** `probeGraphScentWarmth`, the warm set, and the cold refusal in
   `readGraphScent`. Injected opener and clock; no ambient globals in the test path.
   Satisfies AC8–AC10. Same check.
3. **Round-robin probe in `src/host-sweep.ts`.** One workgroup per 60 s sweep. Per
   `CLAUDE.md`, the sweep is where timer-driven work belongs, so this adds a call, not a
   scheduler. Check: `pnpm exec vitest run src/host-sweep.test.ts`
4. **Wire into `pre-turn-context.ts`.** Add `graphScentChars` to `PRE_TURN_BOUNDS`, `'graph'`
   to `ContextNotice['source']`, `graphScent` to `PreTurnContext`, the call site in
   `buildPreTurnContext`, and the **first** eviction step in `enforceFinalBound`.
   Satisfies AC11–AC13. Check: `pnpm exec vitest run src/modules/memory/`
5. **Container rendering** without touching `RECALL_EVIDENCE_KEYS` (§5.8). Satisfies
   AC14–AC15. Check: `cd container/agent-runner && bun test` plus
   `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
6. **Live latency verification** against the largest real graph before deploy: replay a
   sample of recent real queries through the warm path and record p50/p95/max, plus the
   observed cold probe cost per workgroup.
   Gate: **warm p95 ≤ 300 ms** and no query on the message-write path exceeds
   `GRAPH_SCENT_BUDGET_MS`, or the design returns for revision.
   Check: a throwaway script under the scratchpad, output pasted into `run.md`.
7. **Full suite + build.** `pnpm test` and `pnpm run build`.

## 9. Pillars 2–4 — sequenced, deliberately not designed here

Recorded scope: `project_workgroup_cerebro_plan.md`. This plan builds pillars 0 and 1.
Pillars 2–4 get their own `/team-plan` when their entry criteria are met. Designing them
now would be speculative: pillar 2's shape depends on whether pillar 1 changes agent
behavior, and pillar 4 was explicitly ordered last "after consolidation shows which
entities matter."

**Pillar 0 changes pillar 2's entry criteria.** Consolidation distils the episodic
ledger, so it concentrates whatever the ledger holds. Run against today's 11.9% domain
share it would produce a well-organised process manual. Pillar 2 should not start until
pillar 0 has visibly moved that share.

**Pillar 2 — semantic consolidation.** Curator-maintained topic files
(`memory/people/`, `memory/domain/`, `memory/systems/`) distilled from the episodic
ledger. There is a ready-made hook: `MemoryCuratorWorker.runMaintenance`
(`src/modules/memory/curator-worker.ts:493`) already claims a lease, reads the generated
store, and completes — the body is a deliberate no-op returning `maintenance_noop`.
Consolidation fills that body, reusing the existing lease, CAS writer, and per-file recall
lane. A human-authored client-liaison roster file already in one workgroup tree proved the
file shape, and §4.3 shows it already ranks top for people queries.
*Entry criteria:* pillar 0 deployed and the domain share measurably above its 11.9%
baseline; pillar 1 deployed two weeks with evidence that pointers are being followed.

**Pillar 3 — structured-source ingestion.** Snowflake schema, dbt lineage, Linear, feed
schedules into the same topic files on a schedule.
*Entry criteria:* pillar 2's topic-file shape stable.

**Pillar 4 — entity layer in Graphify.** Person/system/concept node types. The graph has
none today — only chunks, files, and symbols (§4.3 sample), which is why a person query
returns zero *nodes* while FTS matches exist. This is a Graphify schema and extractor
change, the largest of the four.
*Entry criteria:* pillar 2 has shown which entities actually recur.

## 10. Risks and open items

| Risk | Assessment |
|---|---|
| A cold graph costs ~800 ms | Measured. Resolved by construction: the cold cost is paid by the sweep probe, never on the message-write path (§5.4). The residual is up to ~800 ms added to one 60 s sweep, for one workgroup, once per cycle. |
| `better-sqlite3` cannot be interrupted | Accepted ceiling, stated in code. It is why warm-gating replaces a breaker: an uninterruptible query must be prevented from starting, not stopped once running. |
| Warmth is a proxy, not a guarantee | A fixed probe term measures page-cache residency, not the cost of the actual turn's terms. A pathological real query on a "warm" graph can still overrun. Bounded by the same `LIMIT 24` + canonical-prefix shape that produced the §4.4 envelope; step 6 measures the real distribution before deploy. |
| Warmth converges at one workgroup per minute after restart | The lane is silent for the first minutes on a multi-workgroup host. Accepted for an advisory lane; the alternative is probing every workgroup per sweep, which is the ~8 s stall this design exists to avoid. |
| Pointers are noise for conversational turns | Every warm turn runs the lane, including "thanks". Mitigated by the ≥2-term floor and bm25 ranking; if it proves noisy in practice the fix is a relevance floor on `rank`, not more machinery. Not pre-built. |
| Agent ignores the scent entirely | The real failure mode, and unmeasurable from the host. §11 defines what would count as evidence. |
| Basename dedupe hides genuinely distinct files | Two different `index.ts` files collapse to one pointer. Accepted: the pointer is a lead, not an answer. |
| `workgroup/%` prefix assumed universal | Verified present on all four sampled graphs (§4.4). A workgroup with no `workgroup/` sources yields an empty scent and a `no-match` notice — degrades correctly. |

**Unresolved user decisions**

1. **Scope.** Builds pillars 0 and 1, sequences 2–4. Confirm or redirect.
2. **No numeric success gate on pillar 0.** P0.6 step 4 measures the domain share after
   7 days but sets no threshold, deliberately: any number picked now would be invented,
   and a gate that fires on an invented number would drive prompt-tuning toward the
   metric rather than toward useful facts. The judgment stays human. Say so if you want
   a hard target instead.
3. **No efficacy eval still exists.** Neither pillar proves recall changes an answer; the
   outstanding A/B (context suppressed, judge-scored) remains unbuilt and out of scope.
4. **No backfill.** Months of archive predate the curator and stay undistilled. Pillar 0
   only changes capture going forward.

## 11. Observability

- One `log.info` per populated scent: workgroup, term count, pointer count, elapsed ms.
  Enough to compute a live latency distribution without a new metrics surface.
- One `log.info` per sweep probe: workgroup, elapsed ms, resulting warm state. This is
  the series that shows whether warm-gating is actually holding, and it is the first
  thing to read if the lane is silently empty.
- Notice codes (§5.6) are visible in the recall row itself, so a session DB inspection
  shows why a lane was empty.

**What would count as evidence the lane works** (not built here, recorded so it is not
re-invented): a repeat of that class of question where the transcript shows the agent
opening a pointed-to file before answering. Absent that, the lane is unproven regardless
of how clean the latency numbers are.

## 12. Verification commands

```bash
pnpm exec vitest run src/modules/memory/
pnpm test
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
```

## 13. Rollback

**Pillar 1.** `graphScent` is additive and optional on `PreTurnContext`. Rollback is
reverting the commit; no migration, no persisted state, no schema change. The graph is
read-only throughout — this plan cannot corrupt Graphify. In-flight consumers that do not
know the field ignore it.

**Pillar 0 is the asymmetric one and deserves the honest statement.** The prompt and
reason-code changes revert cleanly, but **facts already written do not.** Reverting stops
new domain captures; it does not remove the ones captured in the meantime, and per the
operator's standing rule memories are never deleted. Reverting the marker change is also
one-way in practice: facts written with `reason=` keep it, and since the parser's group is
optional they continue to parse either way — which is exactly why the group is optional
rather than required.

So the pillar-0 rollback question is not "can we revert the code" but "are we willing to
keep what it wrote." At the level of one prompt category producing one class of fact, the
answer is yes. That is the reason pillar 0 is safe to ship first despite touching the
durable store: it can add wrong facts, and superseding is the existing remedy for that,
but it cannot corrupt or lose a fact that already exists.
