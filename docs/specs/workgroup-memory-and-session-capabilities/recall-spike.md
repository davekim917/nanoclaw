# Recall Spike

Measured 2026-07-25 before canonical-memory cutover. All production inspection
was read-only; no service, container, session, or migration state was changed.

## Evaluation gate

Fixture revision: `2026-07-25.1`

| Measure                             | Direct lexical | Final |
| ----------------------------------- | -------------: | ----: |
| Exact current-thread recall         |           100% |  100% |
| Explicit correction recall          |           100% |  100% |
| Exact pasted-link recall            |           100% |  100% |
| Paraphrase plus cross-thread recall |         88.89% |  100% |
| Distractor false-positive injection |             0% |    0% |
| Honest no-match                     |           100% |  100% |

The unchanged lexical pass missed one of nine paraphrase/cross-thread cases, so
bounded ephemeral expansion was necessary. Expansion is limited to eight terms
derived from the current query, feeds the same direct authoritative lookup, and
is neither rendered nor persisted. The approved thresholds were not lowered.

The production-shaped SipTrue regression also passes: for “Where is
siptrue.com DNS hosted?”, the first ranked current-thread archive row says the
domain/DNS is handled through Wix, ahead of newer Cloudflare app-hosting
distractors and the later mistaken question. Ranking removes
high-frequency/TLD noise and compares one bounded passage per candidate by
unique query-term coverage, passage density, and minimal term span. It uses
question-like wording only as a final tie signal, then preserves archive BM25
order; recency does not win a relevance tie.

## Live inventory

| Source                               | Inventory                                                             |
| ------------------------------------ | --------------------------------------------------------------------- |
| Legacy `groups/*/memory`             | 9 roots, 180 Markdown files, 572,481 bytes; largest file 42,354 bytes |
| Canonical `data/workgroups/*/memory` | 0 roots before cutover                                                |
| Recognized Claude-native memory      | 24 project memory directories, all empty; 0 files and 0 bytes         |
| `data/archive.db`                    | 116,772,864 bytes; 60,840 rows; 42,025,782 text characters            |
| `data/v2.db`                         | 5,009,408 bytes; 2,483 sessions                                       |

The largest live Markdown file fits under the selected 65,536-byte per-file
limit, and the entire substantive legacy corpus fits under the 1,048,576-byte
per-turn scan ceiling. The number-drinks incident workgroup currently has three
Markdown files totaling 5,682 bytes; its legacy tree is the projected canonical
source until migration performs the path cutover.

## Incident-turn benchmark

The read-only benchmark used the real SipTrue thread, trusted number-drinks
workgroup member IDs from `v2.db`, the bounded archive FTS query, and the same
deterministic lexical/proximity ranking as the producer.

| Source read                       | First open | Warm median, 7 runs | Result                                                          |
| --------------------------------- | ---------: | ------------------: | --------------------------------------------------------------- |
| Archive scope + FTS + ranking     | 144.112 ms |           61.710 ms | 96 bounded candidates; first row is current-thread Wix evidence |
| Projected canonical Markdown scan |  12.066 ms |            0.289 ms | 3 files; 5,682 bytes                                            |

“First open” means the first connection/read in a new benchmark process; kernel
page caches were not forcibly dropped. The results support direct bounded reads
without adding a persistent semantic index or another memory authority.

## Selected bounds

| Bound                                       |             Value |
| ------------------------------------------- | ----------------: |
| Sorted filesystem entries examined          |               256 |
| Total Markdown bytes scanned                |         1,048,576 |
| Bytes read per Markdown file                |            65,536 |
| Bootstrap `index.md` characters             |             2,500 |
| Headings per file / characters per heading  |          24 / 240 |
| Relevant Markdown candidates / excerpts     |            48 / 3 |
| Characters per Markdown excerpt             |               900 |
| Archive FTS candidates / lexical excerpts   |            96 / 3 |
| Characters per archive excerpt              |               900 |
| Exact-link candidates / excerpts            |            32 / 8 |
| Capability services / characters per detail |          32 / 600 |
| Normal serialized context                   | 12,000 characters |
| Exact-link serialized context               | 16,000 characters |

Every source has independent exception handling and named truncation/no-match
notices. Exact links are resolved first, current-thread archive evidence
outranks workgroup-wide evidence, and `index.md` is present in the first
provider-context bootstrap. `system/definition.md` is standing protocol
guidance and is not recalled as evidence.

## Context-size regression baseline

Before the bounded-delta correction, 25 completed production recall rows from
2026-07-25 through 2026-07-26 had a median serialized size of 36,686
characters, p95 of 46,751, and maximum of 47,880. The corrected contract has a
normal hard ceiling of 12,000, an exact-link hard ceiling of 16,000, and a live
normal-turn p95 target below 8,000. Unchanged evidence is fingerprinted and
suppressed within the provider context epoch so repeated turns do not rebuild
the old state dump.
