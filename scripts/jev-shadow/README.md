# jev-shadow — replaying fleet history through TypeSafe's Jev

Operator-run experiments that ask one question: would a cheap, calibrated Jev
judgment (docs.typesafe.ai) have made a better decision than the one the fleet
made? Everything is **replay**: the scripts read what the host already persists
(`turn_usage`, each session's `messages_in`/`messages_out`, GitHub PRs) and change
nothing in the router, sweep or runner.

| Script | What it does | Sends to TypeSafe |
|---|---|---|
| `jev.ts` | Client pinned to `jev-1.13.0`, 429/529 backoff, cost, `pool()` | — |
| `turns.ts` | Rebuilds each billed turn: inputs, chat replies, other writes, ledger notes | — |
| `size.ts` | Spend by trigger × outcome and by model × effort | nothing |
| `silent.ts` | Scheduled turns that delivered no chat reply, by series | nothing |
| `watcher.ts` | Would a judgment on *what changed* have skipped or down-routed a PR-watcher wake? | change lists, ledger notes |
| `routing.ts` | Does Jev's difficulty rating track how much work a turn took on the same model? | request text |
| `prs.ts` | ~11 typed checks per merged PR diff vs whether Codex raised a P1 | PR title, body, diff |

```bash
JEV_SHADOW_FOCUS=<workgroup,…> pnpm exec tsx scripts/jev-shadow/routing.ts --since 2026-09-10
```

The key is read from `TYPESAFE_API_KEY`, else this checkout's `.env`. Raw results
land in `$JEV_SHADOW_OUT` (default `~/jev-shadow-out`). `JEV_SHADOW_FOCUS` picks
the workgroups to replay; it is a scope choice, not a data restriction.

## Results, 2026-09-18 (8 days of history, jev-1.13.0)

Total TypeSafe spend for everything below: about $0.12.

| Question | Result | Verdict |
|---|---|---|
| Classify a review-notes lesson into the 40-class registry | 59% top-1, 81% top-3; confidence ≥ 0.9 covers 42% at 86% | Works; the problem is too small to ship |
| Reproduce `risk:high` from a file's path and header | AUC 0.56 | No |
| Skip a PR-watcher wake from the snapshot diff | AUC 0.61 (0.75 on high-confidence labels); every threshold skips more acting wakes than idle ones | No |
| Route human requests off Opus-high by difficulty | Spearman 0.22 with steps; only ~5% of that spend rated confidently easy | No — the ceiling is too low |
| Predict a Codex P1 from ~11 diff checks | worst-critical-check AUC 0.55 | No |

What held up: Jev classifies **text by meaning** well. What did not: predicting
what an agent will do or find. Those outcomes depend on state and multi-hop
reasoning that is not in the text Jev sees, which is Jev 1.13's documented weak
spot (docs.typesafe.ai/model-jaggedness/jev-1.13).

## Traps these scripts already fixed — keep them fixed

- **Scheduled rows are written about a day before they fire.** Attribute on
  `COALESCE(process_after, timestamp)`, never `timestamp`.
- **A row is consumed by the next turn that STARTS after it is due.** Windowing
  on the previous turn's end misfiled ~$860 of scheduled turns.
- **"No chat reply" is not "idle".** A task can have chat disabled by design and
  work through decision cards, an outbox and a ledger; read `task_log`.
- **Age counters are not events.** Key claims and stalls by identity, or every
  hourly tick looks like a change.
- **Page, don't `--limit`.** A capped PR list silently dropped half the window.
- **"Reviewed" ≠ "has a Codex-connector review".** Substitute reviewers leave
  receipts, not connector reviews; `prs.ts` undercounts review for that reason.
