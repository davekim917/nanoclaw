# QA Report — cross-provider-guard-parity

> `/team-qa` under `/team-auto` — 2026-06-19 · prod security-guard code, two repos
> Validators: Denoise (inline) · A Style + B Docs (folded into swarm domain-reviewer) · CD review-swarm (3 reviewers: adversarial, security, domain — nanoclaw adapters) · E codex adversarial (cross-model, BOTH repos, run read-only)
> Scope file: present (agentic-systems + llm-engineering). Excluded from review: `src/providers/codex.ts` + `codex.container-config.test.ts` (pre-existing, not this feature).

## Gate

```
Denoise:        clean (no debris in changed source)
Style/Docs:     folded into swarm domain-reviewer — no violations (conventions clean, factory sigs unchanged, docs consistent with code)
Code review (swarm, nanoclaw): 1 BUG (→ MUST-FIX, FIXED), 1 SUGGESTION
Codex (cross-model, both repos): 5 findings — 1 MUST-FIX (FIXED, converges w/ swarm BUG), 1 HIGH pre-existing (escalate), 2 SHOULD-FIX, (0 advisory)

MUST-FIX total: 1 → FIXED + regression-tested → 0 remaining
```

## MUST-FIX (1) — FIXED this cycle

### M-QA1 — Codex guard chain failed OPEN on a thrown/malformed-verdict guard
**Found by:** codex E (#1 malformed verdict, HIGH 0.9; #3 email-DB throw, HIGH 0.88) **+ rev-adversarial [BUG]** — two independent reviewers, converged. rev-adversarial verified against codex-rs `hooks/src/engine/output_parser.rs`: Codex blocks a PreToolUse tool ONLY on `permissionDecision:'deny'` or exit 2; `{continue:true}`+exit 0 = the tool RUNS.

**Root cause (verified at source by lead):**
- `cli.ts:41-45` caught any runtime error from the guard chain and emitted `{continue:true}`+exit 0 → **fail-OPEN**. A thrown guard exception let a gated destructive/email action run unguarded.
- `runner.ts` runDestructiveGuard wrapped the `evaluateBashCommand` *call* in try/catch, but the `verdict.action` *access* sat OUTSIDE it — a malformed-but-importable core returning `undefined`/`{}`/unknown-action threw there, escaping to cli.ts's fail-open path. `validateGuardCore` only proves the export is a function, not that it returns a real verdict.
- The chain loop (`runner.ts` runPreToolUseChain) had no try/catch around `await hook(...)` — the email gate's session-DB round-trip (writeMessageOut/awaitDeliveryAck) throwing would escape to cli.ts.

This **defeated the feature's central fail-closed-parity claim** for the throw/malformed case → violates HARD constraint **C4** ("fail-closed everywhere incl. guard errors").

**Fix (defense-in-depth, all grounded in C4; security-strengthening, not a product change → applied per /team-auto Stage D):**
1. `cli.ts` — PreToolUse runtime error now emits a `permissionDecision:'deny'` (fail-CLOSED); PostToolUse stays soft (advisory).
2. `runner.ts` runDestructiveGuard — verdict-SHAPE validation: deny on null/undefined/unknown-action verdict.
3. `runner.ts` runPreToolUseChain — chain-loop `await hook(...)` wrapped in try/catch → deny (a throwing hook denies at the source with a clear reason).

**Verification:** new regression tests `test_codex_destructive_fail_closed_malformed_verdict` + `..._unknown_action` (+ new `__test-fixtures__/malformed-verdict/` core) → runner.test.ts **34/0** in isolation; container typecheck **0 errors**; full suite unchanged except the documented 10±1 parallel-DB-race flakes (none in cli.ts/runner.ts).

## ESCALATE — flag for ship decision (HIGH, pre-existing, NOT auto-fixed)

### codex #2 — email gate bypass via `--dry-run`/`-h`/`--draft` inside quoted email content (HIGH 0.95)
`gws gmail +send --to victim@x --body "please --dry-run this"` matches `EMAIL_BYPASS_RE` (applied to the raw segment before token-parsing) → returns allow, bypassing the human approval gate. **rev-domain confirmed `evaluateEmailSendInline` is a line-for-line verbatim port of the SoT** (`workflow/email-gate-core.ts:129-190`) — i.e. this bypass **exists in the current Claude prod code today** and was faithfully preserved per HARD constraint **C3** ("preserve the email-gate flow EXACTLY"). It is **NOT a regression**, affects all 3 adapters identically (so parity HOLDS), and does **not block the feature's acceptance path** (cross-provider parity).
**Why not auto-fixed:** the fix (shell-token-aware bypass detection) changes the email-gate verdict for a class of inputs — an observable behavior change that **C3 forbids** and /team-auto requires escalating rather than autonomously changing. **Your call** at ship: ship parity now + fix the bypass as a fast-follow (recommended — it's a real HIGH hole), or hold. codex's fix: parse the gws command into shell tokens; treat `--dry-run/--draft/--help/-h` as bypasses only when they are actual argv tokens, not substrings inside quoted flag values.

## SHOULD-FIX (2) — listed for ship review (not touched in Stage D per MUST-FIX-only rule)

- **S-QA1 — clone_repo reuses a clone when origin is MISSING** (codex #4 MEDIUM 0.86 + rev-adversarial SUGGESTION). `git-worktrees.ts` origin-match only rejects when `origin !== null && !originsMatch`. A `.git` dir with no origin remote is returned as "already present" for any requested URL (not data loss — caller just gets a repo that can't fetch/push the requested URL). Fix: on null-origin, warn loudly (or error) before reuse. (In-scope of G3's origin-match; conservative warn won't break legit local-only repos.)
- **S-QA2 — OpenCode email approval card drops the structured summary** (codex #5 MEDIUM 0.78). `opencode-guard.ts` collapses the verdict to `reason = verdict.label` before `runEmailGate`, so label==summary on the card — the structured from/to/cc/bcc/body preview built by `email-gate-core` isn't shown. The gate still GATES (security holds); the card is just less informative → a parity degradation vs Claude's card (design S5 "shared card content"). Fix: thread label+summary through runEmailGate→runGateRequest→writeGateRequest (writeGateRequest already takes label+summary separately).

## ADVISORY (noted, no change)

- rev-security: `runFileProtection` fallback `FALLBACK_EDIT_TOOLS` could fail-open for a NEW Codex edit-tool alias during a core outage (LOW — destructive-gate behind it is unconditionally fail-closed). Suggest a sync comment.
- rev-domain NIT: `runner.test.ts:405` comment cites stale `runner.ts:222` (preToolUseHook is at :330).
- rev-domain SUGGESTION: `claude.ts` `emailActionVerb` re-parses the command (3-line dup for deny wording only).
- rev-domain NIT: `opencode-tool-enumeration.test.ts` is a static snapshot (human-re-capture, not auto-live) — faithful to the design's chosen mechanism (C7/D13 rejected a CI-spawned server as too heavy).
- rev-adversarial heads-up: guard-plugin-path divergence (Claude/Codex load `workflow-agents/`, OpenCode loads `workflow/`) — intentional, but a bootstrap rename would break them independently.

## What the swarm verified CLEAN (not just absence of findings)

secret-env single-source + SDK-free + correct var set (GH tokens deliberately excluded, documented); OpenCode child env-strip genuinely removes auth vars; self-approval regex anchored (only runtime-string-reconstruction evades — same advisory residual as all regex guards, consistent across adapters); SDK_DISALLOWED_TOOLS single-source + enumeration fails on unknown/denied tool; clone path-traversal rejected by validateRepoName + no shell injection (execFileSync array args); no credential logging; **the no-drift guarantee** (workflow-agents/ byte-identical to workflow/ modulo banner, `--check` CI-gated); all 3 adapters share the same chain order; factory signatures unchanged; email polarity faithful-to-source (scheduled bypass / interactive gate); runner.test.ts:160 contract correctly inverted to fail-closed.

---

## QA RE-PASS (codex cycles 2–9) — email-gate bypass FIXED (codex #2 resolved; C3 superseded by explicit user authorization)

**Trigger:** the user reviewed the ship gate and directed: *"do a qa repass and fix the email bypass."* This explicitly **authorizes changing the email-gate verdict behavior** — i.e. it supersedes HARD constraint **C3** ("preserve the email-gate flow EXACTLY") for the bypass-detection path. The earlier escalation (codex #2, "NOT auto-fixed") is therefore now resolved by fixing it.

**Method:** iterative cross-model adversarial loop — each codex `exec -s read-only` cycle attacks the bypass detector; every real finding is traced to the source, fixed in the SoT (`email-gate-core.ts`) + mirrored in the nanoclaw inline fail-closed fallback (`claude.ts`), re-vendored (`vendor-guards --check` byte-equality), regression-tested in BOTH repos, then re-attacked. Continued **until codex returned `approve`** (the user's standing bar).

**The bypass-evasion arc (each a real, source-verified hole; all fixed fail-closed):**

| Cycle | Finding (CRITICAL unless noted) | Fix |
|---|---|---|
| 4 | `--dry-run` substring inside quoted `--body`; first-matching-segment only (decoy `: gws +send --dry-run; <real send>`) | bypass flag must be a real argv token (strip quoted spans); check every send segment |
| 5 | obfuscated-verb decoy (`+se''nd` evades the regex while a decoy `--dry-run` satisfies the check); quoted-separator over-block | move bypass to the WHOLE command; any separator (`;`/`&&`/`\|`) ⇒ gate |
| 6 | backslash-escaped whitespace (`--body \ --dry-run`); non-IFS whitespace (form-feed/`\v`) | reject any unquoted `\`; split on bash IFS `[ \t\n]`, not JS `\s`; add `\n\r` to metachar set |
| 7 | adjacent-quote concatenation (`--body 'x'--dry-run` → bash word `x--dry-run`, sends) | replace quoted spans with a **non-IFS NUL sentinel**, not a space (preserves bash word-concatenation; fail-closed-monotone — can only make a token differ from a flag, never manufacture one) |
| 8 | wrapper prefix (`exec -a --dry-run gws …` makes `--dry-run` argv0); value-of-option (`--subject --dry-run` feeds the flag to `--subject`) | bind to a **direct gws invocation** (skip `VAR=value`, require first word `== gws`); honor a flag only in option position (preceding token not a bare value-consuming option) |
| 9 | **APPROVE** — no in-scope bypass. 1 LOW over-block only (absolute-path `gws` gates) | documented as intentional (matching bare `gws` avoids a path-spoofing vector); locked with a test |

**Final recognizer invariant (fail-closed by construction):** quote-spans → NUL sentinel; reject any surviving quote / unquoted backslash / shell metacharacter (incl. `;&|<>$\`(){}#\n\r`); IFS-split; skip `VAR=value`; require first word `gws`; honor a bypass flag only in genuine option position. Every step can only make the recognizer MORE reluctant to bypass — so it reports a bypass flag **iff bash passes that exact flag to gws as a standalone option**. Verified by 7 direct behavioral probes + paired SoT/inline regression tests.

**SCOPE — DETECTION vs BYPASS (documented in `email-gate-core.ts` header):** this layer reliably gates email sends an agent constructs normally and lets no decoy/quoting/wrapper trick slip a *detected* send past the gate. It CANNOT *detect* a send whose verb an adversary deliberately obfuscates so the regex never matches (`gws gmail +se''nd …`, `+s$(true)end`, `eval`, base64-decode pipes, direct REST/SMTP/SDK). That detection-evasion class is the documented egress-proxy boundary — unchanged, and out of scope for a shell-text gate (no regex can replay bash quote-removal/expansion statically).

**Accepted fail-closed over-blocks (rare; locked as intentional tests):** quote-spliced flags (`--dry'-'run`), fully-quoted `'--dry-run'`, a bypass flag immediately after a boolean option, non-consuming wrappers (`command gws … --dry-run`), and absolute-path `gws`. All GATE (safe) rather than risk a heavier shell lexer that could fail OPEN or a path-spoofing vector.

**Verification (final):** bootstrap guards suite **393/0**; `vendor-guards --check` ✓ (SoT↔workflow-agents byte-identical); parity-lint 17 skills ✓; bootstrap hooks tsc 0 errors. Nanoclaw guard surface (claude.guards + email-gate + runner) **77/0** in isolation; container tsc 0 errors; full container suite **558 pass / 10 fail** — the 10 are the documented spawn_*/send_message/poll-loop parallel-DB-race flakes (identical set, pass in isolation, none touch the guard surface). SoT↔inline-fallback parity confirmed by codex each cycle (no fallback drift more-open than SoT).

---

**Status:** Stage D + QA re-pass complete. MUST-FIX: 0. codex #2 (email bypass) **FIXED** (user-authorized, codex cycle-9 APPROVE). 2 SHOULD-FIX (S-QA1 clone null-origin reuse, S-QA2 OpenCode card summary) remain listed for ship review (not in the email-bypass scope). → Stage E (ship gate).
