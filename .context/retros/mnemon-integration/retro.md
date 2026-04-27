# Retro: mnemon-integration

**Date:** 2026-04-27
**Feature:** mnemon-integration (per-group LLM-supervised memory + Ollama embeddings, Illysium-first rollout)
**Branch:** `feat/mnemon-integration` → merged as commit `681b143` on `davekim917/nanoclaw#main`
**Artifacts location:** `.context/specs/mnemon-integration/`

## Stage-by-Stage Findings

| Stage | Worked Well | Missed / Wrong | Root Cause |
|-------|-------------|----------------|------------|
| /team-brief | 19 HARD + 3 SOFT constraints captured upfront. 6 explicit success-criteria gates for Phase 2 graduation. Phase 1 shadow + Phase 2 live framing — the killswitch / kill-radius story was correct from the start (brief.md:11-30). | Nothing critical. | Brief was thorough; problems were in interpretation downstream. |
| /team-design | 33 decisions logged with rationale + rejected alternatives (decisions.yaml). 3 review cycles ran to convergence. Module split (host Node / container Bun) explicitly enforced. Wrapper-flock approach selected over hook-callback flock (cycle 2 MF8). | (1) Cross-tenant store isolation — design specced "mount ~/.mnemon RW" without considering the cross-store reach (caught only in QA as Codex CRITICAL). (2) Phase2 ↔ collector telemetry contract was vague ("reads `data/mnemon-metrics/turns/`, `stores/`" without specifying JSONL vs aggregate JSON). (3) flock.ts left in module list after MF8 superseded it (B3 drift ack). (4) mnemon project sustainability not surfaced as a design risk. | (1, 2) Implementation details deferred without naming the operational invariant being protected; once "deferred to builder," builders C and D filled the gap incompatibly. (3) Mechanical drift in design after a cycle-2 fix. (4) /best-practice-check focused on pattern conformance (Karpathy LLM Wiki concept — review.md:6) but not adopted-dependency durability. |
| /team-review | 3 cycles converged. Cycle 1 caught 6 MUST-FIX (binary version pinning, hook delivery via SDK programmatic chain, ContainerConfig zod gap, schema-migration verification, etc.). Cycle 2 caught 5 more MUST-FIX (PreCompact handler doesn't exist in v0.1.2 binary; rollout JSON write path; flock location moved into wrapper). Cycle 3 caught 6 issues including F1 (hooks must not write rollout JSON), F3 (wrapper fail-closed default), F5 (PreToolUse Bash deny matcher for direct mnemon-real). | Cross-tenant mount scope (S9/A6 in QA). Telemetry pipeline mismatch (PB2). Both later caught at QA. | Reviewers (architecture-advisor + best-practice-check + Codex adversarial) operated against the design doc, not against an operational threat-model checklist. "What if the LLM passes `--store other-group`?" was not a question any reviewer was prompted to ask. |
| /team-plan | File ownership map covered all 30 files. Constraint-traceability table mapped every HARD constraint to a task. ASSERT lines and named tests in every task. Pre-build drift caught real gaps: B1 (SessionStart schema-mismatch caching missing from plan despite being in design), B2 (wiki/SKILL.md modification missing from File Ownership Map). | (1) Wrapper jq path: spec said "see design.md `Mnemon CLI wrapper` section" without inlining canonical jq filter — builder-A defaulted to top-level keyed `.phase` instead of per-store `.[STORE].phase`. (2) Dockerfile `COPY` path inherited the spec error (`COPY container/mnemon-wrapper.sh` instead of `COPY mnemon-wrapper.sh` for the `container/` build context) — surfaced only when builder-D ran `./container/build.sh`. (3) scheduleTask UPDATE missing status filter — builder followed the literal pattern; status-filter contract wasn't specified. | (1, 3) "See design" or "follow pattern" deferral: the plan wins on detail when a wrong literal interpretation silently fails. (2) Multi-stage spec error: design + plan both wrong, two builders inherited it cleanly. |
| /team-build | 4 groups, parallel where possible. Group A required 1 fix cycle (wrapper jq path bug). Groups B, C, D first-attempt clear. Stage 1 (spec compliance) + Stage 2 (code quality) review per group caught the wrapper jq bug before group completion. Build-state checkpoint discipline survived all the context compactions (build-state.md updated after each group). Image rebuild verified at 2026-04-27T01:24:02Z. | (1) builder-A scope creep: spawned phantom builder-B/builder-C via TaskUpdate on tasks they didn't own; sent peer DMs to non-existent agents. (2) Dockerfile COPY error caught only at D1 smoke (Group D's build.sh invocation), 1 day into the build. (3) Pre-existing main CI break inherited — not surfaced until PR opened. | (1) Builder prompt did not explicitly forbid TaskUpdate on tasks they don't own or messaging non-existent peers. (2) D1 was the first run-the-build smoke step — earlier groups never invoked image build. (3) /team-ship's pre-merge gate doesn't include "what's main's CI baseline." |
| /team-qa | Caught 9 MUST-FIX (cross-tenant isolation, guide.md prompt injection, scheduleTask status filter, phase2 fail-open, deny-regex bypass, turn metrics path mismatch, hardcoded host path, STORE validation, mount-scope as architectural root cause). Caught 8 SHOULD-FIX (flock no timeout, atomic rollout writes, cp restore, process.cwd, unhealthy-phase-as-live, prime-injects-on-mismatch, printf format injection, backup flock). 5-reviewer swarm + Codex adversarial converged on the cross-tenant/guide.md root cause from multiple angles — strong signal. | Pre-existing main CI failure not flagged by any QA validator (out of QA scope, but it ambushed /team-ship). One real bug missed by /team-qa — phase2 fail-open behavior was acked from pre-build drift as PB2 PARTIAL (planned-defer to follow-up); Codex correctly rejected the defer in post-build, forcing the fix. | QA scoped to changed files; couldn't see CI infrastructure debt. Pre-build drift acks were applied without re-evaluation when the post-build picture arrived. |
| /team-drift | Pre-build caught B1, B2 — real gaps that would have shipped if not caught. Post-build caught PB1 (disable-mnemon `'completed'` vs `'cancelled'`). 2-agent (Claude + Codex) convergence pattern produced agreed-upon findings vs Claude-alone bias risk. | PB2 (phase2 ↔ collector format) was acked at pre-build with "Phase 2 is one week out, defer" — but post-build reframing (Codex correctly insisting on fail-closed) showed the defer was wrong. The ack was driven by feature-completion pressure rather than operator-graduation safety. | Drift acks should be re-evaluated when the same finding reappears at a later stage. The acks file is per-feature but per-stage acks are flattened. |

## Key Learnings

1. **Verify host prerequisites at /team-build start, not at rollout.** The brief listed `[HARD] Ollama runs on host as systemd service with nomic-embed-text pulled` (brief.md:12, 47), but build never checked the host state. Discovered post-ship when Dave asked about embeddings — required a 5-min install he had to do. Pattern: every `[HARD]` constraint that names a host-side service or binary should produce a verification step in the build's Day-1 acceptance, not in operator-followup.

2. **When the plan says "see design.md" for a structurally-critical literal, inline the literal.** The wrapper's per-store jq path was the only thing protecting Phase 2 graduation from breaking in any multi-store environment. Builder-A's reasonable but wrong interpretation took 1 fix cycle to reach. Same root cause produced the Dockerfile `COPY` context bug. The mechanical fix: `/team-plan` should never say "see design" for a code pattern; if the pattern is structurally critical, inline it verbatim.

3. **Builder prompt template needs an explicit no-cross-task-modification clause.** Builder-A claimed Tasks #2 and #3 with phantom owner names ("builder-B", "builder-C") and sent DMs to those non-existent agents. Lead had to reset twice. The prompt forbade reading other groups' files but not modifying other groups' tasks. Fix: add to `team-build/references/builder-prompt-template.md` an explicit "do not invoke TaskUpdate on tasks not assigned to you; do not SendMessage to agents not in your team-config members list."

4. **`/best-practice-check` should include adopted-dependency durability, not just pattern conformance.** It correctly verified the Karpathy LLM Wiki layering pattern (review.md:6) but didn't surface that mnemon's repo (89 stars, 2 months no commits, single-author) was atypically risky for a "core feature" adoption. Dave caught this post-ship and asked us to fork as defense. The check passed pattern conformance but missed sustainability.

5. **`/team-ship` Step 1 (test-suite verification) should include a CI-baseline check.** main had been failing CI for 5 days (since 2026-04-22 v2-promotion PR) before mnemon. Every PR since had failed; PRs were merged via `--admin`. /team-ship's gate ran `pnpm test` locally (passed) but didn't check that main's CI was healthy. The PR's CI failed for a pre-existing reason that surprised us mid-merge. Fix: add a "CI on main has passed within the last N runs" check to ship Step 1.

## Recommended Updates

### CLAUDE.md

- **Section:** § Development → at end of section, before § Service management
- **Change:** Add subsection "Host-prerequisite verification": "Every `[HARD]` constraint in `.context/specs/<feature>/brief.md` that names a host-side service, daemon, or binary must produce a Day-1 verification step in the build's acceptance criteria. Do not defer host prereq verification to rollout."
- **Reason:** Learning #1 — Ollama-on-host slipped from `[HARD]` constraint at brief.md:47 to post-ship operator surprise.

### Workflow Skills

- **Skill:** `bootstrap-workflow:team-plan` § Task spec format
- **Change:** Replace "Code pattern: See [design section]" with explicit rule: "If the pattern is structurally critical (a wrong literal would silently fail under realistic operating conditions), inline the verbatim pattern. The plan is the builder's only spec — design is not in their context window."
- **Reason:** Learning #2 — wrapper jq path bug + Dockerfile COPY context bug both inherited from "see design" deferral.

- **Skill:** `bootstrap-workflow:team-build/references/builder-prompt-template.md` § Anti-Patterns
- **Change:** Add a bullet: "DO NOT invoke `TaskUpdate` on tasks not assigned to you. DO NOT `SendMessage` to agents not currently listed in `~/.claude/teams/<team>/config.json` `members[]`. Spawning, coordinating, and routing across builders is the lead's responsibility, not yours."
- **Reason:** Learning #3 — builder-A claimed phantom tasks #2 and #3, sent DMs to non-existent peers. The prompt forbade file overreach but not task/messaging overreach.

- **Skill:** `bootstrap-workflow:best-practice-check`
- **Change:** Add a "dependency durability" sub-check when the implementation introduces an external project as a core dependency. Surface: stars, last commit/release date, open-issue activity, single-author risk, fork count, archived flag. Tag findings as DURABILITY (separate from PATTERN-CONFORMANCE).
- **Reason:** Learning #4 — best-practice-check passed mnemon on pattern conformance but missed the 89-star / 2-months-no-commits / single-maintainer signal that Dave caught post-ship.

- **Skill:** `bootstrap-workflow:team-ship` § Step 1 (Verify Test Suite)
- **Change:** Extend the gate to also run `gh run list --workflow=ci.yml --branch main --status success --limit 1` and check that the most recent main CI run is < N days old (suggested 7). If main CI has been red, surface this **before** opening the PR so the merge isn't blindsided. Allow user override via `--admin-known` flag.
- **Reason:** Learning #5 — pre-existing main CI break (latest green: 12 days old; failures: 5 days running) ambushed the mnemon merge and required `--admin` bypass.

- **Skill:** `bootstrap-workflow:team-drift` § DIVERGED Acknowledgments
- **Change:** When the same finding reappears at a later drift stage (pre-build → post-build), the existing ack must be re-evaluated, not auto-honored. Specifically: a `drift-acks.json` entry from pre-build should be flagged as "re-evaluate" if the same id or text reappears in post-build. The post-build run can override the pre-build ack with a stronger MUST-FIX classification.
- **Reason:** PB2 was acked at pre-build with "Phase 2 is one week out, defer" — Codex correctly rejected the defer in post-build, but the auto-honor would have shipped the fail-open behavior. Lead had to manually intervene.

### Project Skills

- **Skill:** None new needed. The existing `/add-karpathy-llm-wiki` and `/add-mnemon-companion` (implicit, ships with this PR via the container skill) cover the project-side surface.
- **Change:** None.
- **Reason:** No project-skill gap surfaced; the gaps were all in workflow skills.

---

## Notable signals (not learnings, just observations)

- **Phase 1 shadow architecture earned its keep.** During the QA fix pass we found a CRITICAL cross-tenant isolation bug in production code that would have leaked memory across agent groups. Phase 1 shadow + the kill-switch (`disable-mnemon.ts`) meant a real hit during shadow week would be containable. Worth keeping the pattern for future LLM-coupled features.

- **The wrapper-script architecture worked as advertised.** Mnemon's CLI is the only contract between NanoClaw and the binary. When Dave raised legitimate concern about mnemon's project sustainability, the answer was "swap the binary, the wrapper is yours" — and that's literally true. The architectural decoupling was the right call even though we didn't appreciate how load-bearing it'd become for the survivability conversation.

- **Multi-agent QA convergence is high-signal.** Five reviewers (adversarial, domain, security, concurrency, arch) plus Codex independently surfaced the cross-tenant mount issue from different angles in the QA pass. When 3+ reviewers converge on the same root cause from different prompts, that's a much stronger MUST-FIX than 1 reviewer flagging it.

- **Pre-build drift was net-positive.** B1 + B2 caught real gaps before code was written. Cost: ~30 min of agent time. Saved: at minimum 1 build cycle for builder-D, possibly more if SessionStart schema-mismatch-caching had escaped to QA.
