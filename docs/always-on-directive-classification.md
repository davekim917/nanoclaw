# Always-on directive classification

Read-only audit artifact. Every directive loaded into an agent's context on
**every turn**, classified against the filter from
[the Claude 5 context-engineering post](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models):

> "Avoid making them overconstrained, **except in highly important areas**."

The post's target is rules that override context-sensitive judgment on matters
of **taste and approach**. Its one worked example relaxes a comment/docstring
style rule. It never advocates relaxing trust-boundary enforcement, and it
*keeps* constraints that define requested behavior (the Todo tool's
"one item in_progress").

| Bucket | Meaning | Action |
|---|---|---|
| **1 — invariant** | Trust boundary, data loss, anti-fabrication, external-facing commitment | **Keep.** Prefer enforcement in code over prose. Never relax. |
| **2 — default** | Right most of the time, wrong sometimes | Soften to judgment where the exception is real; move tool routing into tool descriptions |
| **3 — style** | Taste or format stated as law | Delete, or convert to a rubric/reference |
| **fact** | Operational context, not a directive | Out of scope |

Sources: `container/agent-runner/src/destinations.ts` (runtime system prompt),
`container/CLAUDE.md`, the six `mcp-tools/*.instructions.md` fragments,
`~/plugins/ponytail/.nanoclaw-always-on.md`, and per-group `CLAUDE.local.md`
(Claude siblings only — see the reach note at the bottom).

---

## Bucket 1 — invariants. Keep; strengthen where prose is the only enforcement.

| Directive | Location | Note |
|---|---|---|
| Never ask a user to paste API keys/tokens/passwords | `destinations.ts:152` + `container/CLAUDE.md:77` | Stated twice. Both survive the cap now; the system-prompt copy is the durable one |
| Don't fabricate credential setup; use `onecli-managed` | `self-mod.instructions.md:25` | Third statement of the credential theme, but a distinct rule |
| Never permanently delete an email — Trash only | a group's `CLAUDE.local.md` | **Prose-only, and Claude-sibling-only.** Belongs in the bootstrap email gate |
| Never add Co-Authored-By / Generated-with footers | `container/CLAUDE.md:154-159` | External-facing; commits are public |
| Never name sibling agents / AI tooling in a client org's repos | a group's `CLAUDE.local.md` | **Does not reach the agents it names** — see reach note |
| Container dies at ~30min; checkpoint to durable paths, never `/tmp` | `container/CLAUDE.md:3, 17-31` | Data-loss prevention |
| Never announce a next step and end the turn; use `continue_work` | `container/CLAUDE.md:25` | Prevents silently dropped work |
| Post done/lost/next after a ceiling kill | `container/CLAUDE.md:30` | Accountability |
| Truth-grounding; training data never assumed; no guessing | `container/CLAUDE.md:36-38` | Anti-fabrication |
| Read referenced content end-to-end | `container/CLAUDE.md:40` | Anti-fabrication. **Conflict C4** — clarify, don't cut |
| Read source before answering about own infrastructure | `container/CLAUDE.md:46-48` | Anti-fabrication |
| Graphify is advisory — open cited provenance before acting | `container/CLAUDE.md:103` | Anti-fabrication |
| An existing test is the current contract | `container/CLAUDE.md:62` | Prevents silently rewriting contracts |
| Don't claim completion without verification | `container/CLAUDE.md:44` (intent) | **Intent only.** The mandated 3-part form is bucket 3 |
| Never lazy about validation at trust boundaries, data-loss error handling, security, accessibility | ponytail `:25-27` | Ponytail already carves out its own invariants |

## Bucket 3 — style mandates. The actual target.

| Directive | Location | Bytes | Why |
|---|---|---|---|
| **Prose Drafting Pipeline** — humanizer hard gate "applies every turn", incl. *"The humanizer skill description does not narrow this rule"* | `container/CLAUDE.md:67-75` | ~1,430 | A directive written **specifically to overrule a skill's own scope judgment**. The purest instance in the tree. Scope is ambiguous enough to arguably capture every chat reply |
| **"Default to overachieving, then trim"** | `container/CLAUDE.md:54` | ~90 | Disposition stated as law. **Conflict C1** |
| **Completion Protocol's mandated 3-part recitation** | `container/CLAUDE.md:44` | ~180 | Keep the invariant, drop the fixed form. **Conflict C2** |
| **"Be concise… outcomes over play-by-play… not a transcript"** | `container/CLAUDE.md:15` | ~300 | Format mandate. **Conflicts C2, C3** |
| **"Communicate your plan before starting work"** | per-group `CLAUDE.local.md` | ~200 | **Conflict C3** — direct opposite of the above |
| **Ponytail ladder + Rules + Output** | ponytail `:5-31` | ~1,900 | Disposition stated as law. **Conflicts C1, C2** |
| **"Engage, don't mirror"** | `container/CLAUDE.md:11` | ~60 | Pure style |
| `cli.instructions.md` — CLI manual for a self-documenting CLI | fragment | 5,739 | `ncl help` is richer and current. Not a rule at all — redundancy |
| `interactive.instructions.md` — schema restated in prose | fragment | ~1,400 of 1,642 | Already in `interactive.ts` |
| `core.instructions.md` — `send_file`/`add_reaction` params restated | fragment | ~700 of 1,181 | Already in the schema |

**Bucket 3 total: ~13.4 KB** of ~32.7 KB always-on — roughly 41%.
Of that, ~7.8 KB is pure redundancy (self-documenting surfaces + schema
restatement) removable with **zero behavioral risk**, and ~5.6 KB is genuine
style-mandate-and-conflict work that needs the baseline.

## Bucket 2 — contextual defaults (abridged)

Be honest / challenge / investigate first (`:7-13`); stay silent between updates
(`:15`); `wait` vs `ncl tasks` routing (`:28`); hours-long jobs → durable infra
(`:29`); peer handoff and the 3–4 exchange drop rule (`:105-121`); image-file
timeout gotcha (`:127-133`); HTML-artifact delivery (`:135-137`); repo workflow
(`:143-152`); Feature Work Routing (`:161+`); `agents`/`self-mod`/
`orchestrator-workers` capability docs. Much of the tool routing belongs in tool
descriptions rather than always-on prose, but none of it is overconstraint.

---

## Conflicts

Two rules pulling opposite ways on the same decision. This is the post's core
harm — *"Claude must think more carefully about these overlapping and
conflicting messages before deciding what to do."*

**C1 — scope disposition.** `container/CLAUDE.md:50-54` "fix it in the same
session… **default to overachieving**" vs ponytail `:5-21` "**does this need to
exist at all?** … deletion over addition … shortest working diff". Opposed
answers to *do I widen or minimize scope?*, both always-on, all 21 groups. This
is the post's own example with the nouns changed.

**C2 — what a final message looks like.** Three specs: `:15` "be concise,
outcomes not a transcript" vs `:44` "you MUST (1) state what you verified
(2) list cases checked beyond the happy path (3)…" vs ponytail `:29` "code
first, then at most three short lines."

**C3 — narrate first or report after.** `:15` "prefer outcomes over
play-by-play" vs a group's `CLAUDE.local.md` "communicate your plan **before**
starting work."

**C4 — who reads.** `:40` "read referenced content end-to-end… page through
until every line is read" vs `orchestrator-workers:12` "**don't read large
files** in the main loop when a worker can do it." Anti-fabrication guard vs
delegation efficiency. **Clarify — delegated reading counts when complete.**

**C5 — cadence vs concision.** The humanizer gate fires "every turn" on
anything sendable, against `:15` "be concise" and ponytail's "if the explanation
is longer than the code, delete the explanation."

---

## Reach defect (separate from classification)

`CLAUDE.local.md` is **not** imported into `CLAUDE.md` and **not** flattened into
`AGENTS.md`. Claude Code auto-discovers it; Codex and OpenCode read `AGENTS.md`
only. So every bucket-1 rule living there reaches **one of three siblings**:

- A group's "never name the sibling agents in this client's repos" rule —
  verified 1 hit in `CLAUDE.local.md`, **0 in all three `AGENTS.md`**. The rule
  naming the codex sibling does not reach the codex sibling.
- The never-hard-delete-email rule — same hole.

Fix is to flatten these in, which costs 1.1–1.9 KB against 11 bytes of current
headroom. Sequenced after the redundancy cuts.
