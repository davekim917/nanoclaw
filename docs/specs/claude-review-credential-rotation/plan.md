# Claude review credential rotation

Approved scope: the operator requested implementation of the diagnosed standalone
Claude review rotation gap, then explicitly required an isolated worktree for PR
preparation. Main, production images, running agents, and review approval state
must remain untouched.

## Behavior and boundary

Install a NanoClaw-owned launcher at the container's existing `claude` command.
The original pinned CLI stays available at a fixed internal path. Only the
foreground, nonpersistent, tool-disabled JSON review transport is eligible for
credential retries. Other invocations pass through. Preserve all arguments,
stdin bytes, cwd, model, effort, permissions, and final CLI output/exit status.

For eligible reviews, select the existing primary credential and distinct numbered
fallbacks in numeric order, within the active authentication family. Retry only a
recognized quota/access-limit error before inference, once per distinct slot.
Do not retry successful reviews, malformed output, server overload, cancellation,
or failures after inference. Emit slot labels, never credential values, on stderr;
emit only the final CLI result on stdout. Exhaustion remains an error, not approval.

Credential selection runs in a small runner-owned service on a private Unix socket
inside the same container. The CLI wrapper sends only a validated review request
(prompt, cwd, model, effort, optional JSON schema); the runner reconstructs the
fixed read-only CLI flags and injects one of its already inherited credentials
into the child. This works even when Bash's environment is sanitized. The socket
is not a host/container transport; host/container IO remains the session DBs.

The authorized caller is any same-UID process in this session container; agent
Bash is intentionally allowed to request read-only review inference. A private
0700 temporary directory and 0600 socket exclude other UIDs. This is a review
execution capability, never an endpoint that returns credentials. The child gets
only the selected canonical auth variable, with other auth-family/ring variables
removed. Fixed `--safe-mode` disables hooks, plugins and project customizations,
including those present in a caller-selected cwd.

Reject unknown options, caller-provided environment/executable paths, tool/MCP/
plugin/settings overrides, and malformed requests at the service boundary. A
disconnected/cancelled client must cancel the child and prevent further attempts.
The service owns its socket cleanup and running child cleanup on shutdown. Bound
input/output memory. Requests and outputs stay in memory; tokens are never returned.
Limit review input to 32 MiB and child output to 16 MiB; overflow fails explicitly
without truncating into a purported review or falling back to an unsafe invocation.

Do not retrieve secrets from `/proc`, create credential files, widen OneCLI scope,
modify Bash sanitization, or introduce another credential store. If no credential
ring is available, retain the CLI's normal authentication behavior within the
trusted runner. A review launcher without its runner service fails explicitly.

## Executable acceptance criteria

Add focused Bun tests under `container/agent-runner/src/cli/`:

- `retries the incident session-limit result with the next credential`: the
  exact zero-token HTTP 429 envelope followed by success yields two attempts and
  only the successful final result.
- `preserves review input and arguments`: each attempt receives identical stdin,
  argv, cwd, and settings; only the selected auth credential changes.
- `bounds and deduplicates the credential ring`: numeric slot order, each distinct
  credential tried at most once, final exhausted response and failure preserved.
- `keeps authentication families separate`: API-key precedence matches the native
  provider; OAuth and API-key slots do not mix.
- `does not replay successful or unsafe failures`: success mentioning quotas,
  malformed JSON, overload, non-quota errors, and nonzero inference usage do not
  rotate.
- `passes other CLI invocations through`: interactive/version/non-review modes and
  absent fallback rings preserve ordinary CLI behavior.
- `cancels the foreground child`: cancellation prevents another credential attempt
  and terminates the child without orphaning it.
- `never emits credentials`: retry diagnostics expose only variable names; no
  credential files are created and parent environment remains unchanged.
- `works with a sanitized client environment`: the CLI client has no Claude tokens;
  the runner-owned service still cycles its configured slots and returns a review.
- `rejects unsafe service requests`: arbitrary executable/env, duplicate or unknown
  options, tool/MCP/settings overrides, and invalid request shapes cannot launch
  a credentialed process.

Add an image/launcher wiring check that exercises PATH resolution and the original
CLI shim's relative-path behavior with fake credentials and a fake CLI. Run the
container typecheck and the existing native rotation/quota tests if shared quota
recognition is extracted. Regenerate the upstream ratchet for owned files touched.

## Delivery

Prepare source, tests, and review evidence in this worktree. Do not deploy or modify
the production checkout. Deployment after PR approval requires an agent image with
the launcher plus a matching runner source snapshot. Rolling back both restores
the previous direct CLI path. The live blocked plans remain unapproved until an
actual Claude review completes; this change does not approve them.
