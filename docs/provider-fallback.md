# Provider fallback

What happens when a group's provider account stops answering, and how it comes back.

A group declares its fallback in `container.json`:

```json
"providerFallback": { "provider": "codex", "effort": "medium" }
```

Without that declaration nothing below happens — the outage stays loud, which is
the right answer for a group that never opted in.

## The recovery ladder

A failing turn walks these in order, inside the container, and stops at the first
one that works. Each rung is a different claim about what is broken.

| Rung                   | Claim                                           | What it does                                                                                       |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Credential rotation | _this account_ is spent                         | Replays the same batch on the next OAuth slot / API key, around the whole ring                     |
| 2. Model drop          | this _model tier_ is spent, the account is fine | Replays once on the group's configured model, with the pin dropped                                 |
| 3. Provider fallback   | the provider is spent                           | Reports `provider_unavailable`; the host records a window and respawns the session on the fallback |

Rung 2 exists because a provider account's quota is not one pool. Measured
2026-09-21 22:35Z: a group pinned to `claude-fable-5-1[1m]` was rejected on
window `seven_day_overage_included` across all four OAuth slots, and the session
was rerouted to Codex — while two sibling sessions of the same agent group ran
`claude-opus-5[1m]` to completion seconds later on the ordinary `seven_day`
window. The account was never out; only the pinned tier was.

Rung 1 replays the _same_ model on every credential, so a model-scoped window
rejects the entire ring and is indistinguishable from a dead account. Rung 2 is
what tells them apart, and it needs no table of window names: it simply asks the
provider a second question.

The drop is one attempt on one credential, not a second ring pass. If the
group's own configured model is rejected too, the account really is spent and
rung 3 is correct.

**None of this is Claude-specific.** A Codex group pinned to a rate-limited
`gpt-*` model drops to its configured Codex model by the same path before
falling back to Claude.

### What the user sees

When rung 2 succeeds, one line says so — the turn was answered by a different
model than the one pinned, and nothing else in the transcript reveals that:

> ⚙️ claude-fable-5-1[1m] is out of quota — ran this turn on the group's default
> model instead. Its window resets Sep 24, 12:00 PM. The pin is cleared; re-pin
> with `-m claude-fable-5-1[1m]` when you want it back.

A **sticky** pin is cleared, so the rest of the session stops paying that
recovery on every message. A one-off `-m` is not (there is nothing stored to
clear, and the line says nothing about re-pinning).

## Coming back

Normally: nothing. The window in `provider_health` ages out and the next spawn
returns to the primary — no cron, no probe, no operator action. Cooldowns
escalate on the failure streak (15m → 30m → 1h → … → 6h cap), and a completed
turn on the primary clears the streak.

**The operator override.** Typing `-m <a primary-provider model>` while the
session is serving from the fallback now asks for the primary back. The
container cannot route itself — the provider is chosen at spawn, from
`provider_health`, which only the host writes — so the request travels as a
`provider_retry_primary` row; the host clears that group's window, resets the
failure streak, and respawns the session.

Only a **freshly typed** `-m` does this. The same pin read out of
`session_state` on every later turn is not a request for anything, and would
otherwise hold the group in a re-probe loop for the whole window.

If the primary really is still spent, the cost is one failing turn: the outage is
re-recorded from 15m and the session goes straight back to the fallback.

## Where it lives

| Piece                            | File                                             |
| -------------------------------- | ------------------------------------------------ |
| Rungs 1–3, the chat lines        | `container/agent-runner/src/poll-loop.ts`        |
| Availability windows, backoff    | `src/db/provider-health.ts`                      |
| Spawn-time routing decision      | `src/provider-fallback.ts`                       |
| `provider_unavailable` handler   | `src/modules/provider-fallback/handler.ts`       |
| `provider_retry_primary` handler | `src/modules/provider-fallback/retry-primary.ts` |

Both delivery actions are session-scoped and act only on the reporting session's
own agent group: one records a window, the other clears one.
