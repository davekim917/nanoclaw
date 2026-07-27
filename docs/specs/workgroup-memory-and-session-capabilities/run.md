# Run: Workgroup Memory and Session Capabilities

## 2026-07-26 — team-auto resumed

- Approved plan:
  `docs/specs/workgroup-memory-and-session-capabilities/plan.md`.
- Operator-approved refinement recorded in the plan: once-per-provider-context
  capability bootstrap, bounded per-turn evidence deltas, context-epoch
  deduplication, and required-on-relevance Graphify usage.
- Existing worktree changes are the active approved merge and memory build.
  They must be preserved; no stash, reset, checkout, or broad rewrite is
  permitted.
- Build ownership is cohesive across host recall construction, session
  lifecycle state, and runner formatting, so the lead is implementing directly.
- Initial measured production recall evidence before this correction: 25
  completed rows from 2026-07-25 through 2026-07-26 had median 36,686
  characters, p95 46,751, and maximum 47,880. This exceeds the approved
  bounded-delta contract and is the regression baseline.
- Next stage: add focused failing tests for bootstrap/delta behavior,
  context-epoch reset behavior, exact-link/correction bypass, and serialized
  size ceilings.

## 2026-07-26 — implementation and verification

- Added one workgroup-scoped pre-turn context builder. A fresh provider context
  receives the bounded capability snapshot and canonical `memory/index.md`;
  warm turns receive only relevant Markdown/archive deltas.
- Added provenance-and-content fingerprints scoped to the provider context
  epoch. Unchanged evidence is suppressed, while exact pasted links and
  explicit corrections bypass suppression.
- Kept trusted lifecycle guidance separate from untrusted recalled bytes.
  Normal serialized recall is capped at 12,000 characters and exact-link
  recall at 16,000.
- Added provider-context epoch handling for cold starts, `/clear`, compaction,
  context exhaustion, stale continuation recovery, and provider system errors.
  The runner fallback uses only the host-mounted capability snapshot and
  canonical `index.md`, and no-ops when host admission already supplied them.
- Preserved the earliest pending bootstrap recall pair when a cold queue
  exceeds the ten-logical-message batch limit.
- Kept `get_capabilities` available mid-turn and made Graphify required when a
  question depends on code/knowledge lineage, without making Graphify a second
  memory authority.
- Corrected the migration contract to preserve each imported source as a
  coherent Markdown tree. The old row-based `src/db/memories.ts` API is
  intentionally retired; migration 013 and its historical table remain
  untouched for schema compatibility.

### Verification

- Host TypeScript, container TypeScript, `pnpm run build`, and
  `git diff --check`: PASS.
- Full host suite: 225 files; 3,038 passed, 1 skipped, 1 todo.
- Full container suite: 933 passed, 4 intentional skips, 0 failed.
- Focused memory/provider suite: 174/174.
- Focused migration/context/session/workgroup/task suite: 122/122.
- Provider contract/evaluator/verifier suite: 65/65.
- Customization integration suite across delivery, routing, permissions,
  approvals, self-modification, capabilities, group initialization,
  container spawn, tasks, and skill replay: 14 files; 423 passed, 1 todo.
- Discord customized adapter/registry suite: 2 files; 85/85.
- Real provider behavior: Codex 3/3 and OpenCode 3/3, with no unauthorized
  action, workspace mutation, or credential exposure.
- Live read-only runtime verifier:
  8 workgroups, 21 members, 2,557 sessions, 0 failures at
  `2026-07-26T15:59:48.439Z`. The two warnings are a historical missing inbound
  DB in `example-labs` and the intentionally empty `example-demo-builder` workgroup;
  neither blocks activation.
- Container image build: PASS. Expected image
  `nanoclaw-agent-v2-2a38bd3e:latest` exists. Agent-runner source is mounted
  read-only at runtime rather than baked into the image.

### Update/customization audit

- Baseline `a30547fb`; rollback tag
  `pre-update-6c889556-20260724-162840`; upstream
  `641963c1`; merge commit `ceb3fcd1`.
- Upstream is the exact second parent of the merge commit, and the merge is an
  ancestor of the current HEAD.
- Inventory: 982 pre-merge customized files, 268 upstream-changed files,
  64 dual-touched files, 54 functional dual-touched files.
- No unresolved exported API loss was found. The only deleted functional
  customized files have proven replacements:
  `setup/channels/discord.ts` moved to the skill-installed
  `src/channels/discord.ts` adapter and passes the live registry tests;
  `src/db/memories.ts` was replaced by the one-canon filesystem contract and
  is guarded by migration/runtime/provider tests.
- All 43 currently defined central migrations are already present in the live
  DB. No pending live migration or destructive preflight remains.
- No new required environment variable is missing. `DEFAULT_AGENT_PROVIDER`
  has a `claude` fallback and `NANOCLAW_WORKGROUP_ID` is supplied by the host
  spawn path.
- No release-age policy or build-script allowlist entry was added.
- The host service remains running from 2026-07-26 12:33:36 UTC. It has not
  been restarted for this uncommitted implementation.

### Cross-model implementation review

- The primary Claude account returned HTTP 429 before reading input. The
  configured secondary OAuth account was then loaded through NanoClaw's
  protected `.env` resolver into an isolated temporary Claude profile; no
  credential value was printed or persisted.
- The first Opus 5/high-effort structured review returned `REQUEST_CHANGES`.
  Five findings were accepted and fixed with red/green tests: bootstrap-pair
  eviction, full-table bootstrap discovery, passage-sensitive Markdown
  fingerprints, explicit capability truncation notices, and inert nullable
  scheduled recall. Two findings were rejected after source tracing: ordinary
  memory read errors already degrade explicitly, and `/clear` matching is
  normalized identically on both sides of the pair contract.
- The next review returned `APPROVE` and surfaced two concrete retry/task races.
  Both were reproduced with failing tests and fixed: general task ingress now
  waits for due-time recall admission, and stale acknowledgements from an
  earlier retry generation no longer hide rebuilt pairs.
- The full-filesystem review returned `APPROVE` and three LOW hypotheses. The
  archive-passage asymmetry was fixed; queued `/clear` and compaction boundaries
  were hardened; and the migration-required wake-loop hypothesis was rejected
  because container spawn already fails closed.
- A final targeted Opus 5/high-effort follow-up read the current source and
  regression tests and returned `APPROVE` with no findings. It confirmed
  passage-sensitive archive fingerprints retain full-content invalidation,
  the pending-clear scan remains correct beyond 256 rows, compaction
  immediately re-bootstraps bounded canon/capabilities, and migration-required
  workgroups cannot spawn.
- No external review gate remains. The implementation is ready for pre-ship;
  commit, push, and service activation remain separate operator-authorized
  steps.

## 2026-07-26 — automatic semantic capture revision

- The operator identified a missing guarantee in the prior contract: canonical
  storage and automatic recall existed, but durable memory generation still
  depended on the active provider voluntarily calling `write_memory_file`
  during the foreground turn.
- Source tracing confirmed that foreground writes use the active agent's
  model/effort and add a tool cycle to the user-facing path. There was no
  dedicated background semantic curator.
- The revised plan keeps foreground selective capture for explicit/urgent
  memory and adds a debounced, durable, host-side episode curator. The model
  call is never awaited by routing or delivery.
- Background authority is intentionally narrower than foreground authority:
  it may replace only `memory/generated/memory.md`. Imported, user-authored,
  and foreground-agent memory are protected from automatic rewrites.
- The archive DB is the planned queue/cursor authority because it already
  contains the source rows and self-bootstraps independently of the central DB.
  The existing host sweep is the planned fire-and-forget execution seam.
- The existing Bun memory writer remains the cross-process serialization
  authority. The host will invoke it through a bounded stdin helper so host and
  sibling-container writes share one kernel lock and SHA compare-and-swap
  contract.

### Model bake-off

- Four requested candidates were evaluated with tools disabled, fresh state,
  structured output, no persistence, and no fallback:
  Sonnet 5/high, Sonnet 5/medium, GPT-5.6 Terra/high, and GPT-5.6 Luna/xhigh.
- Round 1: 10 cases, three trials each. All candidates scored 30/30 on every
  trial.
- Round 2: 16 cases, three trials each. Added latest-correction-wins, weak
  inference, secret material, context-only preference, durable direct-publish
  preference, and an unverified third-party claim.
- Combined six-trial results:
  - Sonnet 5/medium: 6/6 perfect; mean 24.11s.
  - Terra/high: 6/6 perfect; mean 23.65s.
  - Sonnet 5/high: 6/6 perfect; mean 36.73s.
  - Luna/xhigh: 4/6 perfect; mean 42.41s. One run classified a correction as
    a new memory; another incompletely represented the retired-groups
    correction.
- Selected: `claude-sonnet-5` / `medium`.
  Terra/high was statistically tied on this corpus, but its 0.46s mean latency
  edge does not justify a persistent Codex CLI/auth subprocess. Sonnet/medium
  can use the host's existing proxy-aware Anthropic Messages path with native
  structured output.
- Official API checks recorded during planning:
  - Sonnet 5 model ID and behavior:
    https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5
  - effort request shape:
    https://platform.claude.com/docs/en/build-with-claude/effort
  - structured output:
    https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  - GPT-5.6 availability/pricing:
    https://openai.com/index/gpt-5-6/

### Current gate

- `plan.md` has been rewritten as the sole normative contract and explicitly
  supersedes the earlier exclusion of automatic semantic capture.
- No production source was edited during this planning stage.
- Next: required independent Claude/Opus plan review, one bounded correction
  batch if needed, then explicit operator approval before `/team-build`.

### Cross-model plan review

- Stage: `/team-plan`; primary runtime/model family: Codex/OpenAI.
- Required target: Claude CLI 2.1.220, requested `claude-opus-5`, high effort,
  safe mode, no session persistence, plan permissions, no tools, strict empty
  MCP config, JSON output.
- Timeout: fixed 600 seconds.
- Primary credential attempt: `nonzero-exit`; HTTP 429 weekly quota before any
  input tokens were read.
- The one configured isolated alternate credential was then used without
  printing or persisting its value. Process metadata confirmed effective
  `claude-opus-5`; high effort was enforced by the explicit CLI argument.
- Alternate result: `invalid-output`. The model returned prose saying it wanted
  to inspect the repository and produced neither the required verdict nor
  findings JSON. Tools were intentionally disabled by the mandatory transport.
- Per the shared review contract, no automatic retry was made. Independent
  cross-model coverage is therefore `degraded`.
- Lead audit added three bounded protections before approval:
  1. curation defaults off until explicit service activation and is limited to
     12 model calls per rolling hour / 100 per UTC day without dropping queued
     work;
  2. `generated/memory.md` is reserved at the writer boundary so foreground
     MCP callers cannot bypass curator validation;
  3. each job selects one Anthropic credential slot at start and cannot switch
     credentials after an error.
- No reviewer finding was accepted or rejected because no valid finding was
  returned.
- Manual workflow gate: explicit operator approval of the current revised plan
  is required before `/team-build`.

## 2026-07-26 — background curator implementation

- The operator approved the revised plan and selected
  `claude-sonnet-5` / `medium` as the only production curator.
- Added an atomic archive-backed episode queue with five-minute debounce,
  reclaimable leases, bounded retry, cursor snapshots, 120/hour and 3,000/day
  admission, and two-day call-accounting retention.
- Inbound user messages and successfully delivered assistant replies now
  archive and advance the episode cursor in one SQLite transaction. Router and
  delivery import only this synchronous scheduler; model work starts only from
  the fire-and-forget host-sweep pump.
- Added the stateless structured-output backend with exact returned-model
  enforcement, persisted OAuth round robin, immediate sibling-key failover on
  401/403/429, no tools, no model fallback, medium effort, timeout, refusal
  handling, and secret-scrubbed untrusted prompt boundaries.
- Added evidence-bound semantic decision validation, host-derived stable
  generated-memory IDs/timestamps, correction-only supersession, automatic
  active-ID preservation, secret and size rejection, and deterministic no-op
  normalization.
- Reserved `generated/memory.md` at the writer boundary. The fixed host helper
  alone can opt into that path, and only beneath a canonical
  `data/workgroups/<id>/memory` root. Host and sibling writes share the same
  kernel lock, SHA compare-and-swap, inode/path checks, fsync, and atomic
  rename.
- Added bounded history (20 versions) and maintenance-first threshold
  retirement so sustained episode traffic cannot starve ordinary curation.
- Promoted both bake-off corpora, scoring weights, exact candidates, and
  recorded selection into a hash-checked fixture. The rerunnable evaluator
  requires at least three fresh stateless trials, rejects tool use, records
  runtime/API provenance, and weights false-positive capture five times an
  ordinary miss. A test binds production model/effort constants to the selected
  fixture result.
- Extended the read-only runtime verifier with generated-memory validation,
  pending/due/oldest/retry queue health, global admission utilization,
  per-credential cooldown state, and an explicit `--require-curator-ready`
  activation gate.

### Hardening audit and final verification

- Lead audit rejected any generated document with unmarked prose, multiple
  provenance markers per bullet, prior-only evidence for a new fact, an
  invented capture timestamp, or a silent rewrite of an active fact line.
  Validation errors no longer echo model-supplied evidence IDs.
- Curator rollback history moved out of the sibling-visible workgroup tree to
  host-only `data/memory-curator-history/<workgroup-id>/`. Reads pin a no-follow
  file descriptor, revalidate inode and containment, and rollback goes through
  the same compare-and-swap writer.
- The first-write audit found and fixed a real activation blocker: a fresh canon
  had no `generated/` directory, while the safe writer correctly rejected a
  missing parent. The host now creates only that ordinary canonical directory,
  rejects a symlinked replacement, and has first-write and escape regressions.
- Historical brief/design/decision/review artifacts are now unmistakably
  superseded by `plan.md`, preventing the old "automatic capture is out"
  contract from being revived by a later agent.
- Focused curator contract/worker/writer/evaluator/verifier suite: 55/55
  passing after hardening. The writer-only first-capture/symlink/rollback suite
  passes 7/7.
- Full host suite: 231 files, 3,080 passed, one intentional skip, one todo;
  exit 0.
- Full container suite: 938 tests, 2,700 assertions, zero failures, four
  intentional skips; 9.92 seconds.
- `pnpm run build`, host TypeScript, container TypeScript, and
  `git diff --check`: passing.
- Real cross-process host/sibling writer test: passing; generated, manual,
  imported, and sibling foreground files retained their expected bytes.
- Live read-only verifier: eight workgroups, 21 members, 2,558 sessions, zero
  failures, two pre-existing non-blocking warnings, and
  `activationBlocking: false`.
- Curator readiness is intentionally absent in the running pre-deployment
  service: all queue schemas report `not-initialized`, all generated files are
  missing, `.env` has no curator flag, and `.env.example` defaults it to
  `false`. The service remains active on PID 1144527 from 12:33:36 UTC and was
  not restarted.

### Review and external limitations

- Required implementation review targeted Claude Opus 5/high with tools,
  persistence, and MCP disabled. The primary credential returned HTTP 429
  before reading input; the one authorized isolated alternate returned no
  usable review result. The review contract prohibited an automatic retry, so
  independent cross-model coverage is degraded.
- The lead audit accepted and repaired the activation, provenance, rollback,
  symlink, error-redaction, and stale-contract findings above. No unproven
  reviewer finding was implemented.
- A direct live `claude-sonnet-5`/medium structured-output smoke request also
  returned HTTP 429. The selected model's versioned bake-off remains six of six
  perfect trials, but current provider connectivity cannot be re-proven until
  quota is available. This blocks activation preflight, not commit/push.
- Qodo repository rules could not be loaded because
  `/home/ubuntu/.qodo/config.json` is absent. Checked-in repository rules were
  applied; no Qodo-specific rule is claimed.

## 2026-07-26 — dual-OAuth resilience and admission correction

- A seven-day read-only archive simulation found approximately 308–695
  episode calls on each full day. The original 100/day limit would therefore
  have processed only 14–32% of observed demand and grown the backlog
  indefinitely.
- Replaced single-slot preference with persisted round-robin selection across
  distinct configured OAuth tokens. A 401, 403, or 429 cools down only the
  failed slot and immediately retries the same job on an available sibling.
  The cooldown honors `Retry-After` when present and otherwise probes again
  after 15–30 minutes.
- When all slots are unavailable, no work is claimed. When both become
  unavailable during a job, its episode cursor remains unchanged and is
  released for bounded retry. Credential cooldowns, call history, leases, and
  cursors all live in `archive.db`, so host restart cannot lose the backlog.
- Raised the runaway guards to 120 attempts per rolling hour and 3,000 per UTC
  day. With one pump per minute and two OAuth slots, those bounds do not limit
  intended continuous processing, including immediate failover.
- Added verifier fields for pending/due/leased episodes, oldest due time,
  maximum attempt count, latest error class, hourly/daily utilization,
  saturation, and credential cooldown state. Admission saturation and total
  credential unavailability also emit throttled warnings.
- Verification: focused curator/backend/archive/verifier suite 59/59; full host
  suite 231 files and 3,087 passed with one intentional skip and one todo;
  build and host TypeScript passed; targeted lint exited zero with nine
  pre-existing catch-all warnings; `git diff --check` passed.
- Fresh-process recovery test proved that a second host process reclaims the
  exact failed cursor and original unprocessed message with `handled_rowid`
  still zero.
- Live read-only verification remained non-blocking: eight workgroups, 21
  members, 2,558 sessions, zero failures, and two existing warnings. The
  current service was not restarted, the curator flag remains absent, and the
  live queue schema is intentionally not initialized yet.

## 2026-07-27 — subscription-aware curator transport correction

- Live probes proved the second OAuth identity was distinct and healthy:
  `claude-sonnet-5` / medium succeeded through Claude Code while the same
  identity received HTTP 429 from a direct `/v1/messages` request. The raw API
  and Claude subscription quota surfaces are therefore not interchangeable.
- Replaced the curator's direct HTTP backend with the installed Claude Code
  non-interactive structured-output runtime. Each child receives exactly one
  selected OAuth identity, disables tools, customizations, persistence, and
  prompt suggestions, and receives the untrusted episode payload over stdin.
- Returned model usage must include the exact selected model, preserving the
  no-fallback contract. CLI 401/403/429 status remains available to the durable
  sibling-key failover logic.
- A live service probe exposed a second transport boundary: the service-wide
  OneCLI proxy replaced the child's selected OAuth identity with the host's
  primary Anthropic credential. The curator child now adds the configured
  Anthropic model host to both `NO_PROXY` forms. This matches the OneCLI
  contract that model traffic uses its own login while third-party tool traffic
  remains credential-gateway routed.
- Credential discovery overlays the matching `.env` values on the live process
  view and filters OneCLI's literal `placeholder` sentinel, using the same
  recovery rule already required by container-agent OAuth rotation. Both real
  operator OAuth identities therefore remain selectable inside the wrapped
  host service.
- Live activation then completed a queued episode through `oauth:2` with
  outcome `noop`, cleared that slot's failure state, and advanced the durable
  episode cursor from zero to archive row 6,094. The primary remained in its
  genuine quota cooldown, no failed attempt advanced a cursor, and newly
  arriving episodes remained queued.
- A subsequent non-authentication retry exposed Claude's nullable treatment of
  optional structured-output properties: one replacement returned a non-array
  `supersedesMemoryIds`. The schema now requires all decision fields, with
  empty replacement-only values on `noop`. A real `oauth:2`
  `claude-sonnet-5` / medium call returned the complete five-field shape, and
  the queued episode succeeded on its next pass without cursor loss.
- Live queue verification then exposed two representation-only write blockers:
  Claude first used the heading `# Generated Memory`, then emitted multiple
  provenance markers in one bullet after heading normalization. The contract
  now asks Claude only for semantic fact text and evidence IDs. NanoClaw
  deterministically owns preservation, headings, bullets, content-addressed
  IDs, trusted timestamps, and provenance markers, then validates its own
  rendered document. The old model-authored maintenance rewrite is retired for
  the same reason.
- Retained-queue replay exposed provider-namespaced Discord archive IDs such as
  `<platform-id>:<agent-group>` being cited by their raw platform ID. The host
  now canonicalizes that shorthand only when it resolves to exactly one allowed
  evidence row; ambiguous and invented IDs still fail closed. The prompt also
  states the enforced 1,000-character per-fact bound explicitly.
- Historical replay proved the original 64 KiB generated-store bound was a
  storage ceiling disguised as a context ceiling. The canonical store is now
  bounded at 256 KiB, while curator input is independently relevance-ranked and
  capped at 32,000 characters and automatic agent recall remains capped at
  12,000 final characters. No existing fact is evicted merely to make room.
