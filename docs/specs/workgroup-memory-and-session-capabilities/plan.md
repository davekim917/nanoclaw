# Plan: Workgroup Memory, Recall, and Background Curation

> Revised by `/team-plan` on 2026-07-26.
> This file is the sole normative contract. It supersedes the earlier
> `brief.md`, `design.md`, and the prior version of this plan wherever they
> excluded automatic semantic capture or described both core files as
> per-turn recall.
> Production implementation still requires explicit approval of this revision.

## Outcome

NanoClaw will retain the already-built workgroup memory and recall system, then
add a provider-independent background curator that selectively captures
durable facts without delaying user replies.

One workgroup has one memory canon:

```text
data/workgroups/<workgroup-id>/memory/
```

Claude, Codex, OpenCode, and future siblings read and write that same tree.
Provider-native auto-memory remains disabled where it would create a second
authority. Existing provider compatibility paths continue to resolve to the
workgroup canon.

The complete behavior is:

1. The active agent may immediately call `write_memory_file` for explicit
   "remember this" requests, clear decisions, corrections, or obviously durable
   facts.
2. Every admissible turn receives bounded automatic recall from canonical
   Markdown plus archive evidence. Repeated evidence is suppressed within the
   current provider-context epoch. Exact links and corrections bypass
   suppression.
3. Capabilities are supplied once per fresh provider context and remain
   available on demand through `get_capabilities`.
4. After conversation activity goes idle, one host worker reviews the completed
   episode with a dedicated model. Its default action is `noop`.
5. Accepted automatic memories update only
   `memory/generated/memory.md`. Imported, user-authored, and foreground-agent
   files are never rewritten by the background engine.
6. Graphify remains the authority for code, architecture, requirements, and
   cross-artifact lineage. The curator rejects facts that are readily
   recoverable from code and routes those needs conceptually to Graphify.

## Selected model

Default and only production curator:

```text
model:  claude-sonnet-5
effort: medium
tools:  none
mode:   stateless Claude Code structured-output request
fallback model: none
```

The selection is based on a blind, tools-disabled replay over two corpora:

| Candidate            | Perfect trials | Mean wall time | Result                  |
| -------------------- | -------------: | -------------: | ----------------------- |
| Sonnet 5 / medium    |            6/6 |         24.11s | selected                |
| GPT-5.6 Terra / high |            6/6 |         23.65s | evaluated alternate     |
| Sonnet 5 / high      |            6/6 |         36.73s | no quality gain; slower |
| GPT-5.6 Luna / xhigh |            4/6 |         42.41s | rejected                |

The first corpus covered the reported regressions: GSC in Snowflake, SipTrue
DNS on Wix, Slack-link API workflow, customization priority, retired
workgroups, full-merge audits, and four `noop` distractors. The harder corpus
added latest-correction-wins, weak inference, secret material, context-only
preferences, durable publish preferences, and unverified third-party claims.
False-positive captures carried the largest penalty.

Sonnet/medium and Terra/high tied on semantic correctness. Sonnet/medium wins
the operational tie-break because NanoClaw already carries Claude Code and the
operator's subscription OAuth identities. The curator must use that
subscription-aware runtime rather than treating the raw Anthropic Messages API
as equivalent: their quota surfaces are not interchangeable. Terra would
require a separate Codex auth sandbox for no measured quality or latency
advantage. The selected model and effort are constants guarded by tests;
changing either requires rerunning the versioned corpus. Runtime failures retry
the same model and never silently fall back.

Automatic curation is guarded by `NANOCLAW_MEMORY_CURATOR_ENABLED` and defaults
off. Service activation explicitly enables it after the preflight; this keeps
commit/push separate from live behavior. Once enabled, admission guards allow
120 model attempts per rolling hour and 3,000 per UTC day. The 60-second,
single-job pump can make at most two attempts per job with the operator's two
OAuth slots, so these are runaway guards rather than normal-throughput caps.
Excess due work remains queued oldest-first; no cursor is discarded.

## Capture policy

The curator may remember only:

- explicit decisions;
- explicit corrections, with stale generated text replaced rather than
  duplicated;
- stable user preferences that apply beyond the current task;
- durable operational facts or workflows likely to matter in another thread;
- verified outcomes whose evidence is present in the supplied archive slice.

It must return `noop` for:

- pleasantries, jokes, encouragement, or conversational filler;
- guesses, brainstorming, unresolved options, or speculative plans;
- transient task, PR, deployment, monitoring, or debugging state;
- raw command output and repetitive agent-to-agent status;
- secrets, credentials, tokens, or sensitive values;
- current capability availability or credential state;
- facts readily derived from current code, docs, or Graphify;
- facts already represented without a material correction;
- third-party claims the user has not accepted or evidence has not verified.

The prompt treats transcripts and recalled memory as untrusted data. Evidence
IDs in model output must be a subset of the archive rows supplied to the job.
All outbound prompt text is scrubbed again before the model call.

## Runtime design

### Durable episode queue

`data/archive.db` gains a host-only self-bootstrapping
`memory_curation_episodes` table. It is colocated with the archive because the
archive is both the source and cursor authority; it is not added to `v2.db`.

Each row is keyed by trusted workgroup + messaging group + thread scope and
stores:

- last archived row cursor offered to the curator;
- last cursor successfully handled;
- `not_before` idle debounce;
- lease owner/expiry for crash recovery;
- retry count, next retry, and a bounded error class;
- timestamps in ISO-8601 UTC.

User and assistant archive writes atomically advance the episode's pending
cursor and reset a five-minute debounce. Scheduling is synchronous SQLite work
only; it performs no model call and adds no network latency to routing or
delivery. If a thread ends without an assistant response, its user message is
still eligible after the debounce.

The successful cursor advances only after a validated `noop` or a successful
atomic memory write. New messages arriving during a running job remain pending
for a later episode. Expired leases are reclaimable after host restart.

### Worker

The existing 60-second host sweep starts a fire-and-forget curator pump.
Exactly one pump promise runs globally, which is stricter than the required
one-active-job-per-workgroup invariant and is sufficient for the current eight
workgroups. Thresholded maintenance is claimed before ordinary episodes so it
cannot starve under a sustained backlog; otherwise the worker claims the oldest
due episode. The sweep returns control to the event loop before the model call
completes.

One job receives:

- at most 20 de-duplicated archive messages;
- at most 24,000 transcript characters;
- a relevance-ranked view of the current `generated/memory.md`, capped at
  32,000 prompt characters; the canonical file remains independently bounded
  at 256 KiB;
- up to three relevant excerpts from other canonical Markdown;
- trusted timestamps, roles, archive IDs, and workgroup scope;
- no tools, mounts, capability credentials, or arbitrary filesystem access.

The model returns semantic structured JSON:

```typescript
type CuratorModelDecision = {
  action: 'noop' | 'replace_generated_memory';
  reasonCode: string;
  supersedesMemoryIds: string[];
  memories: Array<{ text: string; evidenceIds: string[] }>;
};
```

The model never authors `generated/memory.md` or any part of its presentation.
Each candidate is concise plain text backed by at least one current-episode
archive row. The host normalizes candidate text, validates evidence, derives a
stable content-addressed memory ID and trusted latest-evidence timestamp,
preserves all existing active fact lines except explicitly superseded
corrections, and renders the canonical heading, bullets, and one provenance
marker per fact. The host then validates its own rendered document. It rejects
unknown or prior-only evidence, presentation-marker injection, secret-like
content, oversized output, unknown supersessions, non-correction supersession,
and no-op-equivalent duplicates. Presentation wording cannot strand an episode
because headings, bullets, IDs, timestamps, and markers are absent from the
model output schema.

### Write isolation and rollback

The background engine has exactly one writable target:

```text
generated/memory.md
```

It cannot modify `index.md`, imported provider memory, manual files, system
instructions, or any non-memory path. Before replacement, the host stores the
previous generated file outside the active recall tree and all container mounts
under `data/memory-curator-history/<workgroup-id>/`.

`generated/memory.md` is reserved at the writer boundary, not merely by prompt:
container/MCP callers are denied that relative path. Only the fixed host helper
may opt into it through a non-exported invocation mode, so a foreground agent
cannot accidentally bypass generated-memory validation.

The host invokes the existing Bun memory writer through a bounded stdin-only
helper. That preserves the same workgroup-wide kernel lock, path anchoring,
SHA-256 compare-and-swap, symlink rejection, fsync, and atomic rename contract
used by sibling containers. A SHA conflict requeues the episode against fresh
state; it never overwrites the concurrent foreground write.

History keeps the last 20 successful generated versions per workgroup.
Rollback is a compare-and-swap restore through the same writer. Disabling the
curator stops new jobs but leaves recall and foreground writes intact.

### Periodic maintenance

The host records a maintenance threshold when either:

- 50 accepted generated updates have accumulated; or
- `generated/memory.md` exceeds 192 KiB.

The worker retires that threshold deterministically without a model call or
write. The host renderer already emits the only supported flat canonical
representation; asking a model to reorganize it would reintroduce a
presentation-only failure path and cannot add facts. History and rollback still
apply to every real generated-memory replacement. Maintenance never touches
manual/imported memory.

## Failure semantics

- Missing credentials, quota exhaustion, HTTP 429/5xx, timeout, refusal,
  invalid JSON, or validation failure do not advance the episode cursor.
- At job start, the backend selects a configured Anthropic OAuth slot through
  a persisted round robin and records only the slot label. One HTTP request
  always uses one credential. A 401, 403, or 429 cools down only that slot and
  immediately starts one new request on an available sibling slot.
- Slot cooldown and call history live in `archive.db`, so host restart cannot
  forget an outage or strand the queue. Identical token values are de-duplicated.
- If all configured slots are unavailable, no episode is claimed. If they
  become unavailable during a job, that job is released without advancing its
  cursor. Quota/auth retries cap at 30 minutes; recovery resumes automatically.
  There is no model fallback.
- A foreground/manual write conflict causes fresh-state retry.
- Archive/queue failure is logged but never blocks message routing or delivery.
- Model and write failures never remove existing memory.
- Logs contain model ID, effort, job/workgroup IDs, row/character counts,
  latency, usage, decision, retry class, and hashes—never transcript or memory
  content.

## Context and recall bounds retained

- Fresh provider context: trusted capabilities plus bounded `index.md`.
- Warm turn: relevant delta only.
- Normal recall: at most three Markdown and three archive excerpts, serialized
  ceiling 12,000 characters, target p95 under 8,000.
- Exact-link turns: separate bounded lane, total ceiling 16,000 characters.
- Evidence suppression is scoped to provider-context epoch and uses source plus
  full-content fingerprints. Corrections and exact links bypass suppression.
- `system/definition.md` and curator history are never recalled as evidence.

## File ownership

| Area                      | Files                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue/schema              | `src/message-archive.ts`, `src/message-archive.test.ts`                                                                                                                                                                                                                       |
| Scheduling                | `src/router.ts`, `src/delivery.ts`                                                                                                                                                                                                                                            |
| Contract/validation       | `src/modules/memory/curator-contract.ts`, `src/modules/memory/curator-contract.test.ts`                                                                                                                                                                                       |
| Model backend             | `src/llm.ts`, `src/modules/memory/curator-backend.ts`, `src/modules/memory/curator-backend.test.ts`                                                                                                                                                                           |
| Worker                    | `src/modules/memory/curator-worker.ts`, `src/modules/memory/curator-worker.test.ts`, `src/host-sweep.ts`, `src/host-sweep.test.ts`                                                                                                                                            |
| Atomic host write         | `container/agent-runner/src/mcp-tools/memory-write.ts`, `container/agent-runner/src/mcp-tools/memory-write.test.ts`, `container/agent-runner/src/mcp-tools/memory-write-process-helper.ts`, `src/modules/memory/curator-write.ts`, `src/modules/memory/curator-write.test.ts` |
| Recall exclusions         | `src/modules/memory/pre-turn-context.ts`, `src/modules/memory/pre-turn-context.test.ts`                                                                                                                                                                                       |
| Reproducible eval         | `scripts/run-memory-curator-model-eval.ts`, `scripts/run-memory-curator-model-eval.test.ts`, `tests/fixtures/workgroup-memory-curator.json`                                                                                                                                   |
| Docs/runtime verification | `docs/memory.md`, `docs/workgroups.md`, `scripts/verify-workgroup-memory-runtime.ts`, `scripts/verify-workgroup-memory-runtime.test.ts`                                                                                                                                       |

No task may edit provider identity/state, workgroup membership, credentials,
channel routing, Graphify storage, imported/manual memory, or unrelated
customizations.

## Implementation sequence

### A. Make model selection reproducible

1. Convert both bake-off corpora and scoring weights into the versioned fixture.
2. Add an isolated evaluator for the four exact candidate/effort pairs.
3. Require three fresh trials, no tools, no persistence, no model fallback, and
   report correctness, false positives, latency, usage, requested/returned model
   identity, and CLI/API provenance.
4. Lock the production constants to Sonnet 5 / medium.

Acceptance:

- Fixture hash is verified before execution.
- False-positive cases fail the gate more heavily than ordinary misses.
- Production model/effort cannot change without a corresponding fixture result
  update.

### B. Add the durable episode queue

1. Add idempotent archive schema initialization and queue CRUD/lease helpers.
2. Atomically schedule from inbound and successfully delivered assistant
   archive writes.
3. Add cursor, debounce, concurrent-arrival, expired-lease, retry, and restart
   tests.

Acceptance:

- No model work occurs in router/delivery.
- A user-only episode remains eligible.
- A successful delivery cannot be archived without advancing its episode
  pending cursor in the same archive transaction.

### C. Implement constrained curation

1. Add schema, prompt boundary, secret scrub, evidence validation, active-ID
   preservation, bounds, and deterministic no-op detection.
2. Add the Claude Code structured-output call with explicit
   `claude-sonnet-5`, medium effort, no tools, safe mode, no session
   persistence or prompt suggestions, timeout, returned-model usage check,
   persistent OAuth round robin, per-process credential isolation, direct
   model-endpoint routing outside the OneCLI credential proxy, and immediate
   quota/auth failover.
3. Add refusal, quota, timeout, malformed output, unknown evidence,
   prompt-injection, secret, and oversize tests.

Acceptance:

- Every supplied transcript is untrusted data.
- Returned model mismatch fails closed.
- No error advances the cursor or mutates memory.

### D. Apply generated memory safely

1. Generalize the existing Bun helper to accept bounded JSON on stdin.
2. Add a host wrapper with timeout/output bounds and fixed helper path.
3. Reserve `generated/memory.md` from MCP/container callers and grant only the
   fixed host helper path access to it.
4. Restrict the host target to `generated/memory.md`; snapshot before write;
   retain 20.
5. Verify real cross-process races between host curator and sibling writer.

Acceptance:

- Manual/imported files are byte-identical before and after all curator tests.
- A foreground `write_memory_file` call targeting `generated/memory.md` is
  denied before lock acquisition.
- Concurrent SHA conflict loses no write and requeues.
- Symlink/path/lock replacement attacks remain rejected.

### E. Integrate worker and maintenance

1. Add the non-overlapping sweep pump and retry state machine.
2. Implement bounded episode assembly and sibling-message de-duplication.
3. Enforce the hourly/daily runaway guards without dropping pending work, and
   expose calls, saturation, due backlog, oldest due time, and credential
   cooldowns in the runtime verifier.
4. Add maintenance threshold, shadow validation, promotion, and rollback.
5. Exclude curator history from recall and retain relevant generated passages.

Acceptance:

- Delivery latency tests prove no awaited model path.
- One global job runs at a time; new activity remains pending.
- A flood of due threads cannot exceed 120 attempts/hour or 3,000/day.
- Maintenance preserves every active memory ID and cannot touch manual memory.

### F. Verify end to end

Run:

```text
focused red/green tests for every file above
host TypeScript
container TypeScript
pnpm run build
full host suite
full container suite
provider conformance/evaluator suites
live read-only runtime verifier
git diff --check
```

Then run a controlled workgroup fixture:

1. deliver a durable correction and a noisy episode;
2. prove the response returns before curation begins;
3. wait for the job and prove only the correction appears;
4. invoke a different sibling/provider and prove bounded auto-recall returns it;
5. prove the noisy episode produced `noop`;
6. force a concurrent foreground write and prove retry without loss;
7. force maintenance and rollback.

Commit/push and service activation remain separate operator-controlled
boundaries. Activation requires a final preflight, then a service restart and
post-restart queue/log/recall verification.

## Ship gate

The build is blocked if any of these remain:

- any automatic write can reach outside `generated/memory.md`;
- any model call is awaited by router or delivery;
- any failure advances the episode cursor;
- any candidate can silently replace Sonnet 5 / medium;
- any false-positive corpus case passes as memory;
- any generated fact contains unmarked prose, prior-only evidence, or an
  invented capture timestamp;
- any active generated memory ID disappears without evidence-backed
  supersession;
- any Claude/Codex/OpenCode sibling sees a different canon;
- any previously verified customization suite regresses.
