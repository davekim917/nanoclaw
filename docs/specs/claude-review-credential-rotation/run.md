# Execution evidence

- 2026-09-06: User authorized the diagnosed fix, then required worktree-only PR
  preparation to protect ongoing main-branch work.
- Worktree: `/home/ubuntu/nanoclaw-worktrees/claude-review-credential-rotation`.
  Branch: `fix/claude-review-credential-rotation`; base: `cf7955cf7`.
- Incident: standalone `claude -p` returned a JSON `result` with `is_error: true`,
  HTTP 429, zero input/output tokens, and a session-limit reset message. The caller
  exited after one attempt. Native provider rotation lives outside this CLI path.
- Read-only live inspection found four distinct OAuth credentials in a current
  affected-group container and a stock pnpm Claude CLI shim. Whether Codex applies
  the hook's rewritten `updatedInput` is not yet proven; the implementation must
  preserve the sanitizer and never recover stripped credentials.
- Searched open upstream/fork PRs and issues. PR #519 concerns provenance on native
  provider retries; it is separate and its poll-loop changes are outside this fix.
- Dependencies are symlinked from the existing install for checks; no dependency
  manifests or shared dependency trees will be modified.
- Design refinement before implementation: a wrapper inheriting Bash credentials
  would fail under working sanitization. Use a runner-owned local Unix-socket review
  service with a fixed argument grammar instead. Its client has no credential need;
  no sanitizer change or secret file is introduced.
- Independent plan review completed with Claude Fable 5.1, high effort, safe mode,
  no tools, nonpersistent JSON output, 3600s foreground timeout. Requested model
  matches `modelUsage.claude-fable-5-1`; raw response is held outside the PR at
  `/tmp/claude-review-rotation-plan-result.json`. Raw verdict: `must_fix`.
  Lead adjudication:
  - Cwd can load credential-stealing hooks: already prevented by mandatory
    `--safe-mode`. Verified the pinned container CLI 2.1.257 help explicitly
    disables hooks, plugins, CLAUDE.md and MCP customizations under this flag;
    an offline behavioral check follows.
  - Same-UID Bash can request inference: intended use, not unauthorized token
    access. Clarified the caller model, private directory and socket permissions.
  - Unknown flags may silently disappear: already excluded by exact CLI grammar;
    require a passthrough regression.
  - Remove nonselected auth-family/ring variables: accepted and made explicit.
  - Preserve child stderr, status and cancellation: existing contract; require
    subprocess-level assertions.
  - Specify memory caps/overflow: accepted, 32 MiB input and 16 MiB output with
    explicit failure.
  - Reuse quota recognition and handle stale socket paths: reuse requested;
    a unique private temporary socket directory avoids singleton stale-path
    takeover/cleanup logic.
- Offline hostile-hook A/B check passed in the existing pinned image, without
  networking or mounted production state and with a fake API key. A project-local
  `SessionStart` hook created its marker with ordinary review flags; the identical
  invocation with mandatory `--safe-mode` did not execute the hook. Both calls
  were time-bounded; no real model request or credential was used.
- Public-repository boundary scan passed for the worktree's initial plan/run
  artifacts; it used the existing main-checkout identifier inventory read-only.

- Implementation checks: 36 Bun tests passed across the new review suite and the
  native Claude rotation/quota suites; runner TypeScript check passed. The tests
  exercise real fake-CLI subprocesses, Unix sockets, a token-free client, exact
  incident output, deduplication, numeric slot order, family isolation, explicit
  exhaustion, invalid requests, large input, output overflow, missing executable,
  caller death after upload, and a TERM-resistant grandchild.
- New persistent offline image check:
  `bash container/claude-review-wrapper.test.sh <candidate-image>` passed against
  a disposable candidate derived from the existing pinned image plus the wrapper.
  It verifies `/pnpm/claude`, `/usr/local/bin/claude`, and the original shim retain
  the same version; a login-shell client without Claude tokens completes a review
  after the fake primary returns the incident quota failure. Networking was off.
  This was an image-layer smoke build, not a full dependency/image rebuild.
- Corrected two pre-integration failures: half-closing the client socket prevented
  reliable disconnect detection (and closed early under Bun); explicit newline
  framing now keeps the connection open until response. A grouped base64 regex
  rejected a valid 4 MiB prompt; canonical decode/re-encode validation replaces it.
- A retry remains one external review invocation: only pre-inference account-limit
  failures advance to another configured credential. No completed review is replayed
  and no approval state is changed.
- Ratchet regeneration accepted only the Docker wrapper installation and runner
  service lifecycle wiring growth. Shared classifier extraction shrank the native
  provider divergence; native classification expressions are unchanged.
- Main advanced independently while this branch was being built. No writes, merges,
  image retags, restarts, or runtime activation were performed in production.

- Independent implementation review completed with requested Claude Fable 5.1/high
  and matching primary model metadata. Raw output is outside the PR at
  `/tmp/claude-review-rotation-implementation-result.json`. It returned `degraded`
  with four SHOULD-FIX findings and no MUST-FIX findings. Lead adjudication:
  - Image/launcher coverage was added while review ran and now passes. Accepted
    fail-closed launcher loading: nonmatching argv has a dedicated status 64;
    runtime/load errors cannot be mistaken for normal passthrough.
  - Accepted optional service startup isolation: startup failure logs service
    unavailability while normal agent startup continues; the review CLI fails
    explicitly without the service. Failed socket setup cleans its temporary dir.
  - Accepted explicit asynchronous spawn diagnostics; regression checks exit 127
    and the diagnostic text.
  - Rejected the proposed placeholder/API-key precedence change: native
    `ClaudeProvider.rotateApiKey` uses API-key truthiness too. Changing precedence
    here would diverge from the current provider contract. No authentication
    configuration or OneCLI policy change belongs in this fix.
- Fresh correction checks: 36 tests passed, 112 assertions; runner typecheck and
  changed-file ESLint passed. Offline candidate-image check passed both CLI/rotation
  behavior and fail-closed behavior with missing runner source. Public-boundary
  scan passed. Lead review coverage is clear for this scoped change.
- Limitations: no real account quotas were deliberately exhausted, no blocked
  production review was retriggered, and no full image dependency rebuild was run.
  Live activation remains a separate post-merge image/snapshot deployment step.
- Rebased the isolated branch onto main commit `6ac980dbf` after its independent
  work landed. Only the generated ratchet manifest conflicted; regenerated from
  the new base to retain both changes. No implementation file conflicted.
