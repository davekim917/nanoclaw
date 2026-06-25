# QA Report — design-artifact-loop (Stage D)

> `/team-qa` under `/team-auto` — 2026-06-25. Branch `feat/design-artifact-loop`.

## Gate: CLEAR — MUST-FIX = 0 (all found MUST-FIX fixed + verified)

## Validators

| Lane | Result |
|------|--------|
| Denoise | Clean — no debug/dead/TODO/temp in 523 LOC prod source (`trace.json.tmp.<pid>` is the legit atomic-write temp). |
| A — Style | Consistent with `render-diagram.ts` precedent (registerTools, ok/err, ESM `.js`, doc comments). No new dependency. ADVISORY: new skill not listed in CLAUDE.md (skill lists are curated; optional). |
| B — Docs | No stale docs — tool inputSchema + SKILL.md frontmatter present; no README/CHANGELOG in agent-runner. |
| CD — Code review | 2 BUG (→ MUST-FIX), 4 SUGGESTION (→ SHOULD-FIX). |
| E — Codex adversarial (cross-model) | cycle-1: 10 findings (≈6 MUST-FIX); cycle-2 re-review: 4 second-order evasions (MUST-FIX). |

## MUST-FIX — all fixed + verified

| # | Source | Issue | Fix | Verified by |
|---|--------|-------|-----|-------------|
| 1 | CD#1/E | Positional finding IDs broke stable-id carry-forward | content/host/kind-keyed IDs | `test_no_js_id_stable_when_earlier_script_removed` |
| 2 | CD#2/E#3,#4 | Egress/JS evasions (inline handlers, javascript:, stylesheet/@import/url()/srcset/protocol-relative, unquoted attrs) | expanded patterns, quote-optional, font-CDN allowlist | 9 evasion tests |
| 3 | E#1 | `id:".."` path traversal | reject dotted ids (`^[a-zA-Z0-9_-]+$`) | `test_rejects_dot_dot_id`, `_dotted_`, `_single_dot_` |
| 4 | E#2 | symlink escape (artifact + run-dir) | realpath guard: artifact under realRun, realRun under realRoot | standalone symlink probe (`reject:rundir-symlink`) |
| 5 | E#5 | token-trace allowed token-hex reuse + missed rgb/hsl/oklch/named | flag ALL colour literals outside `:root` (strip var()) + functions + named-in-colour-prop | `test_token_hex_reuse_*`, `_rgb_`, `_hsl_`, `_oklch_`, `_named_color_` |
| 6 | E#7 | read-merge-write race lost findings | transactional `recordRound()` under one lock | `test_recordRound_transactional_carry_forward` |
| 7 | E#8 | stale-lock reclaim TOCTTOU | owner-token + last-writer-wins steal + owned-release | code review + `test_concurrent_writes_do_not_corrupt` |
| 8 | E#10 | stale critic findings merged into wrong round | `reviewToken` (artifact hash) drops mismatched criticFindings | `criticReviewToken` guard + schema |

## SHOULD-FIX / ADVISORY — deferred (not blocking; for ship review)

- E#6: font denylist misses `font:` shorthand (`font:700 24px Inter`). Medium.
- E#9 / CD#3: lock busy-wait spins ~event-loop on the (near-zero) crash-recovery path. Use Bun.sleepSync/Atomics later.
- CD#4: mirror `render-diagram.ts` chromium flags (`--disable-dev-shm-usage`, `--disable-file-access-from-files`).
- **Best-effort limitation (#5 residual):** regex colour-detection can't catch every CSS named colour buried in shorthands/gradients. Documented in `linter.ts`; the **L1 vision critic + sandboxed chromium render + impeccable** are the backstop. A real CSS parser (postcss) is the future hardening — deferred (needs a supply-chain-approved dependency).
- ADVISORY: list the skill in CLAUDE.md.

## Verification evidence
- design-review suite: **63 tests pass / 0 fail** (was 37 at build; +26 across 2 QA fix-cycles).
- full agent-runner suite: **659 pass / 0 fail / 3 skip** — no regressions.
- `tsc -p container/agent-runner/tsconfig.json --noEmit`: clean.
- The fix to token-trace also caught a real flaw in the project's own `settings-good`/`pricing-good` fixtures (hardcoded `#fff` not token-routed) — corrected to use an `--on-accent` token.
