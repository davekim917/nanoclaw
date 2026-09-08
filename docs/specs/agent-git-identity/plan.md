# Per-agent Git identity

Status: implemented; shipping verification in progress.

## Contract

An agent group may set an optional `gitIdentity` block in its own
`container.json`:

```json
{
  "gitIdentity": {
    "name": "Example Build Agent",
    "email": "example-build-agent@example.invalid"
  }
}
```

The block is all-or-nothing. A supplied value must be an object with a
non-empty name and an email that has one non-empty local part and domain. Names
with angle brackets or control characters, and emails with angle brackets,
whitespace, control characters, or more than one `@`, are rejected.

At container spawn, a configured identity supplies all four Git variables:
`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and
`GIT_COMMITTER_EMAIL`. It replaces only those four values. `credentialFolder`
continues to resolve every other scoped credential unchanged.

When no identity is configured, the established `credentialFolder`-scoped Git
variables remain the source of author and committer attribution. The built-in
NanoClaw MCP forwards any present Git attribution variables through providers
that sanitize child-process environments, so managed `git_commit` has the same
identity as ordinary Git.

The feature is opt-in per agent file. An operator scopes initial use by adding
the field only to agents in the selected workgroup. It does not write global
Git configuration, repository configuration, or a default agent identity.
Git signing is a separate concern.

Source changes take effect after the host refreshes its runner-source snapshot;
each affected container then needs a fresh spawn to receive its environment.

## Acceptance cases

1. A valid identity survives container-config read and write.
2. Missing identity leaves the prior scoped Git lookup untouched.
3. Partial, malformed, or control-character identities fail before spawn.
4. A configured identity becomes both author and committer values and wins over
   inherited scoped Git values.
5. Without opt-in, inherited scoped Git values pass through the built-in MCP.
6. Two configured agents using linked worktrees of one canonical repository
   create commits with distinct author and committer identities through both
   plain Git and `git_commit`.

## Regression coverage

The focused tests assert the contract directly:

- `gitIdentity config` in `src/container-config.test.ts`:
  `round-trips an explicit per-agent author and committer identity` expects the
  normalized `{ name, email }` object; `leaves the established scoped-credential
  behavior available when absent` expects `undefined`; the parameterized
  `rejects malformed all-or-nothing identity declarations` case expects a
  read-time `gitIdentity` error, including C1 `U+009B` in a name and `U+0085`
  in an email; and `validates direct writes as well as hand-edited config
  files` expects the direct writer to reject an empty email.
- `gitIdentityEnv` in `src/container-runner.test.ts`:
  `projects one configured agent to all Git author and committer variables`
  expects all four exact values; `adds nothing when an agent has not opted in`
  expects an empty result; `overrides only Git attribution instead of the
  credentialFolder-scoped human identity` expects the configured four values
  and no scoped lookup for them; and `retains the credentialFolder-scoped human
  identity without opt-in` expects the inherited four values and calls their
  scoped lookup.
- `builtInNanoclawMcpEnv` in
  `container/agent-runner/src/nanoclaw-mcp-env.test.ts`:
  `forwards configured author and committer identity through the Codex MCP
  boundary` expects `NANOCLAW_SESSION_ID` plus all four identity variables;
  `preserves an inherited human identity from existing scoped credentials`
  expects those four values alone; and `keeps the existing MCP environment when
  no Git identity is present` expects only the pre-existing NanoClaw variable.
- `configured agents retain distinct identities for plain Git and the managed
  git_commit tool` in
  `container/agent-runner/src/mcp-tools/git-worktrees.test.ts` creates real
  linked-worktree commits through plain Git and managed `git_commit`, then
  expects each commit's author name/email and committer name/email to equal its
  configured identity.
