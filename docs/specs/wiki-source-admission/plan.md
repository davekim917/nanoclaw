# Wiki source admission before publication

Status: user-approved revised identity design; local implementation only, no activation.
Current source baseline: `96ce72e8e2caac007fb1521040f237d07d3cb8ad`.
Original reviewed baseline: `7ba62ab5741c7bc788b191600dfe107738394d7f`.

## Outcome and boundary

The enrolled weekly synthesis may publish a proposed domain fact only after a fresh,
independent verifier has received the actual primary artifact and accepted the exact
candidate. Missing evidence is a successful, quiet zero-edit result. Preserve the
existing series identity, cadence, model/effort pin, isolation and quiet reporting.

Use two dedicated maintenance groups, without GitHub credentials, and one host-owned
candidate/promotion module. The writer submits Markdown replacements, not executable
scripts, a Git repository, or a self-certified evidence manifest. The host constructs
the immutable candidate and fetches evidence. The verifier returns a semantic verdict
on that frozen input. Only the host possesses publication capability in this flow.

This protects the enrolled maintenance pipeline. Other authorized repository writers,
including ordinary workgroup agents and the operator, retain their existing authority.
It is not repository-wide write protection and does not repair all possible agent
collusion or host compromise. Reader-mirror refresh remains downstream of publication.

## Grounded current behavior

- The synthesis prompt already rejects agent summaries as sources, but instructs an
  ordinary default-branch push. The incident was missing evidence, not a finding that
  the reported measurements were false. The private incident and prompt remain private
  installation records; no private repository URL goes into shipped source or fixtures.
- `src/github-token.ts:9-24` resolves a configured token, scoped token, then the global
  token; there is no explicit disabled state. Spawn delivers that token independently
  of OneCLI (`src/container-runner.ts:6396-6429`). An MCP-only gate cannot own publication.
- Common Git objects/refs are writable, but config, hooks, canonical HEAD/index and
  object-alternate controls are read-only overlays (`src/container-runner.ts:4548-4584`).
  This plan does not allege writable hooks or reuse those shared objects as immutable
  promotion evidence.
- `repository_publish` is local clone registration with an explicit no-network/no-
  ambient-credentials contract (`src/modules/repository-workspaces/index.ts:2108-2115`).
  Add a separate narrowly guarded action; do not silently extend that contract.
- Guarded delivery dispatch and replay enter the registered wrapper
  (`src/delivery.ts:1658-1729`). `runRepositoryActionDetached` already keeps long work
  off delivery polling, using undelivered outbound rows for durable retry and per-lane
  in-flight exclusion (`src/modules/repository-workspaces/job-runner.ts:1-44`).
- `readOriginPin` rejects symlinks and validates a credential-free GitHub HTTPS identity
  (`src/repository-workspaces.ts:636-659`). `withHostRepositoryLock` supplies the existing
  repository lock (`:172-220`). Neither substitutes for a remote compare-and-swap.
- `safeGitArgs` disables hooks and `safeGitEnv` defaults to file-only transport
  (`src/safe-git.ts:8-64`). Reuse them for local object inspection only. Remote promotion
  must retain the host-managed wiki secret-scan hook, validate its installed integrity,
  and refuse when it is unavailable (`src/managed-git-hooks.ts:1-38`). No `--no-verify`.
- Task movement already preserves series ID, recurrence, scheduled occurrence,
  quietStatus and flagIntent (`src/dashboard/api/scheduled-move.ts:360-380`), stages
  paused rows and compensates failures (`:604-742`). Reuse that flow rather than invent
  a second scheduler. Verify isolation/chat fields explicitly during the move: the
  listed copy alone is not proof that every private prompt flag survives.
- Archive rows contain identity/text but not a sufficient universal human-origin
  attestation: the router writes `role: user` for inbound chat, and the archive schema
  lacks raw bot-origin metadata (`src/router.ts:1178-1204`,
  `src/message-archive.ts:113-131`). Repo-owned humans.json and sender display names
  cannot become an authority boundary.

## Smallest implementation

### 1. Host-private enrollment and maintenance execution

One host-only publication policy file under the existing private wiki operations directory names
the target workgroup/repository/default ref, writer group, verifier group, existing
series, notification destination and permitted primary-document origins/path prefixes.
Its digest, together with the identity-record digest, versions each candidate. A missing
or invalid policy never means unrestricted publication. Enrollment and group IDs are
installation state, not public constants.

The separately user-approved durable `actors.json` record in the same host-only
directory contains `{version:1, actorGroupIds:[...]}`. This is a restriction roster,
not a publication grant: it is read before publication policy at the common enrollment
primitive. Unlisted ordinary groups never parse publication policy. Listed actors stay
blocked when policy is missing/invalid or their restricted-profile marker is missing.
Both publisher actor IDs must appear in this record. The publisher revalidates both
records and their combined digest before using existing host GitHub capability.

Create this record before enabling actors. Retain actor IDs when pausing/deleting
publication policy or changing actors; do not automatically delete or rebuild this
record from group markers. Its parent directory and file remain outside container
mounts. An unreadable/invalid identity record is an authority failure and fails closed,
including ordinary dispatch: without trustworthy identity, safe classification is
impossible. An absent identity record with an existing publication policy also fails
closed. With neither record present, the feature is unconfigured and ordinary groups
retain baseline behavior. Deleting both records is not a supported disable operation.
No group tool or new general-purpose identity-management service is introduced.

Create clean dedicated writer/verifier groups in the target workgroup, without copying
old provider state or general-purpose group symlinks. Host enrollment selects a restricted
maintenance spawn profile. The profile is enforced by the spawn primitive, independently
of agent-editable prompts or config updates:

- Resolve no GitHub token, including global/App fallback and legacy token-in-env mode.
- Mount no canonical Git store, other group's directory, writable shared memory or
  writable workgroup tree. The agents need their private session scratch space and
  read-only workgroup archive/wiki discovery data, not repository write mounts.
- Permit only existing model authentication and provider runtime inputs. Reject extra
  credential mounts, scoped application credentials, added MCP servers, additional
  mounts, credentialFolder aliases, provider fallback or workgroup-secret inheritance
  that would add application access. No new secrets are requested or assigned.
- Use fresh verifier session/provider history for each candidate. Do not expose the
  writer's mutable memory, instructions or evidence files as verifier authority.
- Disable ncl and self-modification for these actors. At host delivery dispatch, allow
  only the new wiki protocol plus required task-log/lifecycle acknowledgements; reject
  repository registration/transfer, task creation, a2a and generic messaging from these
  maintenance actors. Publication notices are emitted by the host after success.

This is a scoped profile for the two enrolled actors, not a default tightening of other
groups. Its final mount/env/delivery-action assertions are acceptance requirements;
merely omitting a GH_TOKEN variable is insufficient. Fail the maintenance spawn if the
profile cannot be honored; do not start an ordinary privileged container as fallback.

### 2. Host creates the candidate

The writer requests a base snapshot. The host derives target identity from enrollment,
validates the origin pin, fetches the pinned default ref into a host-only ordinary
checkout under `data/wiki-admission/`, and returns the complete current domain pages
and exact base SHA. No caller-supplied URL, path or command is accepted.

The writer submits a bounded list of `{path, replacementMarkdown, sourceLocators}`
against that base. Only regular UTF-8 Markdown files under `domain/` are editable;
reject traversal, duplicates, symlinks, executables, gitlinks, deletions and non-domain
paths. No candidate body is executed. One candidate per proposed fact/correction keeps
the existing editorial rule and avoids an all-or-nothing multi-fact batch. Supporting
frontmatter may change, but the verifier reviews all changed text.

The host applies the exact replacements in its private checkout, constructs one commit
with the existing synthesis trailer and a deterministic log entry derived from the
proposal, then records base/head/tree/diff digest and policy digest before verification.
The log entry is part of the reviewed tree. Unknown or extra changes reject the candidate.
Use bounded payloads (1 MiB submission, 256 KiB per changed page, 16 pages maximum);
oversize candidates fail closed, never truncate into a passing review.

The candidate store and its SQLite state are host-only, outside all container mounts.
Use existing SQLite dependency with transaction-protected state transitions. States:
`pending`, `verifying`, `accepted`, `publishing`, `published`, `rejected`, `stale`,
`uncertain`. A unique writer-session/request key makes submission retries idempotent.
Preserve one frozen tree; do not reuse container-owned Git config, refs or alternates.

### 3. Retrieve sources and verify independently

V1 admits directly retrieved public primary documents. The site's own product material
is eligible evidence for what its operator represents about its product; third-party
agent reports, generated summaries and arbitrary uploaded “query results” are not.
The private policy initially enrolls the product's established official website.
Archive messages remain discovery leads unless independently corroborated; do not
pretend current archive sender labels prove a human authored a message. Private query,
email and meeting artifacts without an existing independently verifiable read path
remain quiet no-source outcomes. This is deliberately a supported source subset, not
a claim that private analytics now work.

The host fetches the submitted locator itself, with HTTPS-only exact policy matching,
no credentials/cookies, no redirects, bounded time and bytes, and rejection of nonpublic
addresses at the actual connection (including DNS rebinding). No general URL-fetch
proxy is exposed. HTML is returned as inert source text; neither scripts nor repository
parsers are executed. Accept supported text content only; binary, truncated, dynamically
empty or unreadable sources yield no-source. Store digest, retrieval time and final URL.

The host starts one fresh verifier task with the exact candidate diff, complete old/new
affected pages, relevant existing-page context for duplicate checks, and full retrieved
source bodies. It records the delivered immutable input digest and exact verifier
session. Source bodies are bounded; if full input cannot fit the reviewed model context,
reject rather than silently omit it. The verifier sees candidate prose as untrusted data.

The verifier returns `{candidateId, inputDigest, verdict, reasons, support}`. Support
references host-minted source IDs and the relevant changed passages. This is a small
coverage record, not a typed fact language or proof supplied by the synthesizer. It must
judge every factual addition/correction against the actual source, including population,
time, units, scope and causal overreach, and apply New/Durable/Domain/Material. Uncertain
support means reject. A valid source body delivered to an independent model establishes
inspection input, not a mechanical proof of comprehension or truth; semantic accuracy
still needs the negative and positive behavioral controls below.

Only the host-assigned verifier session may answer for that candidate. The writer,
another verifier session, an old task result or a model-supplied source digest cannot
mint acceptance. Missing/invalid/partial output, provider failure or timeout never
becomes accept. Store concise reasons and source digests privately, not full source
bodies or secrets in the wiki. Keep public source bodies only for the candidate's
verification lifetime; durable receipts retain locators/digests and bounded excerpts.

### 4. Promote exactly the accepted tree

The guarded promoter owns the only remote write in the enrolled pipeline. On the
repository lane it reloads private policy/origin, matches the frozen artifact and
accepted input digest, and atomically claims `accepted -> publishing`. It checks the
candidate descends from base and that the remote default remains base. Then one explicit
head-to-pinned-ref push uses an exact base lease; the managed secret-scan hook runs on
that push and must pass. No auto-rebase, force overwrite, arbitrary ref or branch creation.

Successful remote head equality records `published`; only then emit one bounded
existing-destination notice. A moved base records `stale`, quietly awaiting the next
weekly synthesis. Network errors with uncertain outcome record `uncertain`; on replay
read remote: exact candidate head proves completion, unchanged base permits one bounded
retry of the identical operation, anything else stops without overwriting. Do not claim
exactly-once network invocation; require at-most-one logical ref transition for this
candidate. A host restart may leave accepted work for replay, but can never generate a
new candidate or reuse acceptance for a new base. Verifier expiration is terminal
no-source/error for that candidate, not a timer-driven unbounded regeneration loop.

Reuse the delivery job runner for detached IO and existing sweep hooks only for bounded
expiration/recovery; never await model execution inside the global host-script sweep.
No new daemon, scheduler, generic approval service, credential or dependency is needed.

## Acceptance, rollout and rollback

All mutation controls initially use temporary local remotes and synthetic policy.

1. With a fake global/App GitHub credential configured, inspect both final spawn specs
   and run ordinary push, no-verify push, alternate-hooks push, MCP push, gh/API update
   and direct HTTPS update attempts. None can write. Config/self-mod, a2a, shared paths
   and forbidden host actions cannot recover publication capability. Ordinary agents
   retain previous behavior. This includes real container mount checks, not only mocks.
2. Replay the historical unsupported analytics-report proposal. No primary retrieval
   exists: zero host push calls, zero wiki commits published and zero human messages.
   A verifier saying “accept” without a host source record still cannot publish.
3. Feed a real fetched official-source body and one supported candidate to a fresh
   actual verifier. It accepts that exact candidate; a disposable remote advances to
   the exact reviewed tree. This can correct an already-present fact on a fixture; do
   not invent a new production fact just to obtain a green test.
4. Change the candidate after submission, add unsupported prose beside a supported
   quote, edit repo-owned humans.json, forge/replay a verifier result, use another
   session, or change policy/origin. Assert no remote update. Include real-model semantic
   rejection of misleading population/time/causality and agent-summary citations.
5. Exercise source timeout/redirect/private-address/rebinding/oversize and incomplete
   review context. All fail closed; normal no-source/no-candidate runs stay silent.
6. Advance the remote between verification and push; reject the exact lease with no
   overwrite. Crash before/after each durable state and after remote success before
   receipt; replay preserves one candidate and never publishes a different head.
7. Secret-bearing candidate and absent/broken scan hook block promotion. Confirm no
   host credential in arguments, candidate content, persisted receipts or tool output.
8. After independent implementation review and exact-head checks, create/enroll the
   clean maintenance groups, move the paused existing series with the established
   move path, verify one live paused occurrence and every cadence/pin/isolation/quiet
   field, run both real controls, then resume only that series. Preserve the lint and
   reader refresh jobs. Missing sources do not trigger per-fact human approval.

Before activation preserve task/policy/identity snapshots. Rollback is pause the moved
synthesis series with cron intact and disable its publication policy while retaining
the actor restriction record; keep the read copy and lint.
Do not restore direct-push synthesis as an automatic rollback. A proven bad publication
requires an exact reviewed revert, not resetting repository history.

## Authority decision

The implementation is consequential and requires fresh independent plan review. The
user has already authorized finishing source-admission hardening; ordinary code/tests
within that result need no ceremonial approval. The genuinely new trust boundary is
granting this narrowly pinned host action use of the existing host GitHub publication
credential, coupled to two constrained maintenance actors and movement of the existing
series. The user has explicitly approved the revised durable identity record and the
restricted publisher using existing GitHub capability, enabled only after review and
testing. This implementation turn still excludes production enrollment, task moves,
credential assignments, publication and restart. No new secret,
broader repository permission, protected-hook bypass or per-fact gate is proposed.
