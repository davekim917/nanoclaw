---
name: clone-as-provider-template
description: Reference template for adding a `/clone-as-<newprovider>` sibling skill. NOT an installer — do not run it as-is. Defines the generalized guard-parity contract any new agent provider's adapter MUST satisfy before a sibling on that provider is considered shipped, and the machine-checked conformance/dispatch gate that is the definition of "done". Read alongside clone-as-codex and clone-as-opencode, which are the two concrete instances of this template.
---

# Clone Group As <New Provider> Sibling — TEMPLATE

> **This is a template / reference, not an installer.** Do not run the steps here against a live install — there are none. When a new agent provider lands (a fourth runtime alongside Claude / Codex / OpenCode), copy the structure of `.claude/skills/clone-as-codex/SKILL.md` or `.claude/skills/clone-as-opencode/SKILL.md` — whichever is the closer fit — and adapt it. Those two are the concrete, runnable instances of this template; this file captures only the parts that MUST generalize: the **guard-parity contract** and the **machine-checked gate** that together define when a new provider's sibling is "done."

The mechanical scaffold (resolve source group → install a second bot app → add scoped env vars → create the symlink/shared-FS group dir → write `container.json` minus sibling-bound fields → insert the `agent_groups` row with `workgroup_id` → restart → wire channels → verify) is **identical** across providers and is fully documented in the two existing skills. Generalizing the scaffold itself (`/clone-agent-as-provider <source> <provider>`) is captured as future work in `clone-as-codex`; do not duplicate it here. What does NOT come for free — and what this template exists to pin down — is the guard wiring.

## The parity mandate

The agent providers are **one team that must be at command-guard parity by construction** — same guards, same fail-closed behavior, enforced by a **shared guard core** plus a **machine-checked conformance/dispatch test suite**. A provider's runtime differs (how it fires hooks, how it represents a tool call, how it aborts one); its *policy* must not. The shared cores own the policy; each provider ships only a thin adapter over them.

The shared cores today (the source of truth every adapter imports):

- `block-destructive-core.ts` — `evaluateBashCommand`, `evaluateGitCloneDestination`, `evaluateSelfApproval`, `evaluateSnowflakeConnector`, `consumeGateApproval`, `runNanoclawGate`, `IS_NANOCLAW`.
- `email-gate-core.ts` — the email-gate verdict.
- `file-protection-core.ts` — `EDIT_TOOLS`, `checkEditProtection`.

A new provider adapter writes **no** policy of its own. It reads the tool call in the provider's shape, calls the cores, and translates the core's verdict into the provider's deny mechanism (exit code, thrown Error, stdout-JSON `permissionDecision: 'deny'`, decision object — whatever that runtime understands).

## The generalized contract — what "done" means for ANY new provider

A new provider's sibling is **not** shipped when the bot replies. It is shipped only when its adapter satisfies all five of these:

1. **Route EVERY command guard through the shared core — no inline policy copies.** The guard set is: self-approval, snowflake-connector, email-gate, git-clone destination, destructive bash/SQL, and file-protection (edits to `.env` / lockfiles / `.git` / terraform). Each guard's verdict comes from the shared cores above. The adapter may own a fail-closed *inline fallback* (e.g. "if I can't reach the core, deny") but never an inline *policy duplicate* (a second copy of the rules that can drift). If the provider has more than one hook surface (host vs. container, interactive vs. exec), **each** surface that fires must route to the same cores.

2. **Fail closed when the guard core is absent OR malformed.** Validate that the imported module actually exposes the expected exports — do not bare-cast a dynamic `import()` to the core type and trust it. Wrap each evaluator call so an exception maps to **deny**, not a thrown-through error that an outer try/catch silently turns into an allow. "Core missing" and "core present but wrong shape / throwing" must both deny. The model is the *no-approval-surface* case, `IS_NANOCLAW === false → deny`; extend that same posture to the absent/malformed-core case.

3. **Env / secret parity — the provider's shell tools must not see the auth env vars.** A sibling is at parity only when its bash/exec surface cannot `printenv` the OAuth tokens / API keys handed to the container. The robust form is to strip the auth env vars from the child process before launch — note that per-command `unset`-prefix sanitization only works on runtimes that apply hook `updatedInput`, so it is not a portable substitute. Defense-in-depth holds alongside the env strip for every provider — host-side `scrubSecrets` on outbound, OneCLI proxy egress gating, single-tenant containers — but those are mitigations, not the parity requirement itself.

4. **Pass the core-conformance + per-adapter dispatch-coverage suite — this machine-checked gate IS the definition of "done."** Two layers, both must be green:
   - **Cross-surface conformance** — `conformance.test.ts` is the single readable manifest of expected verdicts for the canonical destructive / git-clone / file-protection set. If it holds, every surface that imports the same cores agrees *by construction*. A new provider does not add rows here unless it introduces a genuinely new canonical case.
   - **Per-adapter dispatch coverage** — the proof that THIS adapter maps the core verdict faithfully to its own I/O. Conformance proves the policy; dispatch coverage proves the wiring. Both are required; neither substitutes for the other.

5. **Add the new adapter's dispatch-coverage test, co-located with the adapter.** Mirror the existing instances: `opencode-guard.test.ts` next to `opencode-guard.ts`; `runner.test.ts` next to the codex container `runner.ts`; `block-destructive.test.ts` for the Claude adapter. The new provider's test asserts the adapter blocks/denies the canonical block + gate set, allows the safe set, fails closed where the contract requires it (absent/malformed core, no-approval-surface), and passes non-gated tools through. Without this co-located test there is no dispatch-coverage gate, so by item 4 the sibling is not done.

## Runtime caveats are documented, not waved away

Some runtimes have hook surfaces that provably do not fire — e.g. Codex's `codex exec` sub-delegation fires no PreToolUse hooks at all, so the guard set is instruction-only on that path (no hook-parity claim is made there; the rule is stated in `container/CLAUDE.md` and followed by convention). When a new provider has an un-hookable path, **document it explicitly** in that provider's skill as a named caveat — what is hook-enforced, what is convention-only, and why it's a property of the runtime rather than a wiring bug. A documented, understood gap is acceptable; a silent one is not. Do not file a runtime's un-hookable path as "drift."

## Checklist before announcing a new provider's sibling

- [ ] Adapter imports verdicts from `block-destructive-core.ts` + `file-protection-core.ts`; zero inline policy copies.
- [ ] Every hook surface the runtime actually fires routes to the shared cores.
- [ ] Absent core → deny. Malformed core (missing/wrong-typed exports) → deny. Evaluator exception → deny.
- [ ] Child-process env stripped of auth vars (or the gap documented as a named caveat with the layered mitigations stated).
- [ ] `conformance.test.ts` green.
- [ ] New per-adapter dispatch-coverage test added, co-located, green.
- [ ] Any un-hookable runtime path documented as a named caveat in the provider's skill.

Only when every box is checked is the new provider's sibling "done."
