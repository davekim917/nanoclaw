# Bucket-3 behavioral baseline (pre-change)

Measured 2026-07-30, before any bucket-3 softening. Corpus: **2,753 session
`outbound.db` files, 13,730 agent chat messages**, all providers. Read-only scan.

This exists so "no measurable loss" can be *checked* after softening rather than
asserted — the post's own claim was "no measurable loss on our coding
evaluations", and the measurement is the load-bearing part.

## Concision baseline

| p50 | p90 | p99 | mean |
|---|---|---|---|
| 684 chars | 2,291 | 4,634 | 989 |

## Directive fingerprints

| Probe | Directive | Msgs | Rate |
|---|---|---|---|
| `verified_recitation` | Completion Protocol's 3-part form | 258 | **1.88%** |
| `cannot_verify_hedge` | Completion Protocol escape clause | 108 | 0.79% |
| `humanizer_mention` | Prose gate ("applies every turn") | 110 | **0.80%** |
| `overachieve` | Owner-mode "default to overachieving" | 102 | 0.74% |
| `plan_first` | "Communicate your plan before starting work" | 25 | 0.18% |
| `ponytail_restraint` | ponytail ladder / YAGNI | 10 | **0.07%** |
| `meta_response` | meta-response ban (system prompt) | 1 | 0.01% |

## What this actually shows

**The Completion Protocol is earning its place — do not cut the form blindly.**
This was the surprise. I expected 1.88% to be ritual boilerplate; reading the
samples, it is substantive. Representative shapes (paraphrased — the originals
name real people and production schemas): *"What I verified in <prod database>
just now:"* followed by concrete table and row-count evidence; *"what I verified
before changing anything — every one of the eight review findings traced to
source rather than taken on the reviewer's word."* The mandated form is
producing specific, checkable evidence, not filler. **Revised recommendation: keep the invariant AND
the form; at most relax "MUST" to proportionality for trivial turns.**

**The humanizer gate is the weakest-supported rule in the tree.** It claims to
apply *every turn* to anything sendable — yet appears in 0.80% of agent output.
Caveat: this probe counts *mentions*, so an agent invoking the skill silently
would not register. That limit cuts both ways — it means the rule's real
compliance is unmeasured from here, which is itself the finding. A rule this
broad, this emphatic ("STOP", "does not narrow this rule"), with this little
observable trace, is either dead letter or ambiguous. Either way it is the
strongest bucket-3 candidate, and the honest next probe is tool-invocation logs,
not output text.

**C1 resolves ~10:1 toward overachieve.** `overachieve` 102 vs
`ponytail_restraint` 10. The two directives are both always-on in every group,
and one is winning by an order of magnitude. That is what an unresolved conflict
looks like in production — not paralysis, but a silent, arbitrary winner. Worth
deciding deliberately rather than leaving to whichever phrasing is more forceful.

**`plan_first` at 0.18% is close to inert.** It conflicts with "outcomes over
play-by-play" and loses. Cheap to resolve: keep one, delete the other.

**The meta-response ban works.** 1 hit in 13,730, and reading it, that hit is a
false positive (an email digest header). This is a
well-scoped, effective rule — a useful counterexample to "all rules are
overconstraint."

## Limits of this baseline — read before citing it

These are **lexical fingerprints of output**, not measurements of reasoning
cost. They show whether a directive *manifests*, not whether it degraded
quality, and not the deliberation the post describes ("Claude must think more
carefully about these overlapping and conflicting messages"). Specifically:

- Silent compliance is invisible (humanizer caveat above).
- Regex probes over-match; `meta_response`'s single hit is a false positive, and
  `ponytail_restraint`'s hits include unrelated uses of "plan".
- No per-provider stratification yet — Codex/OpenCode siblings did not receive
  `CLAUDE.local.md` rules at all (see the reach defect), so any cross-provider
  comparison on those directives is confounded.
- Nothing here measures user corrections, latency, or token cost.

Re-run `baseline-miner.mjs` after each bucket-3 change and compare these rates
and the length percentiles.
