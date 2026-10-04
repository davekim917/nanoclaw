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

### Codex: skipping an account that is already spent

A Codex container can only learn that an account is at its quota by starting an
app-server on it, so every fresh container used to start on the primary, read
the wall, and start a second app-server on the next account. Rung 1 now reports
the spent account to the host (`codex_account_exhausted`), and for the next hour
the host starts every Codex container that mounts that account on the next one
instead (`CODEX_START_HOME`).

The mark is keyed by the host Codex home, so groups that share an account share
the mark. It carries no reset date: a quota can be reset early, so after an hour
containers start on the account again, until one of them finds it still spent
and renews the mark.
It lives in host memory (`src/codex-accounts.ts`); a host restart forgets
it, which costs one extra app-server start. With every account marked, the
container starts on the primary and the ladder above runs as usual.

An app-server that does not answer `initialize` within 30 seconds is replaced
once before the turn fails, because that failure reaches rung 3 and moves the
whole group to its fallback provider for 15 minutes.

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

A container already running on the fallback does not wait for its next spawn.
A busy thread can keep one container alive for a day, long past the window, so
the host sweep restarts it once the primary has no availability window (the
`provider-fallback-return` duty, `src/modules/sweep-provider-return/`). It acts
only between turns — nothing due, no claim, no provider call and no
continuation turn in flight, re-read in the same mailbox window as the restart's
wake row. As with every sweep kill, a turn that starts in the moment between
that read and the kill is cut off; its claimed message is reset and retried on
the fresh container. It runs after provider self-heal in the same
exclusive chain, so a container self-heal restarts is not restarted twice. The
thread gets one line:

> ⚙️ claude is available again — this thread is moving back from codex.

The fresh container wakes on an `on_wake` row telling the agent it is back on
the primary and that its conversation memory does not cover the fallback
period. The sweep tells a fallback container from a primary one by the
`NANOCLAW_PROVIDER_FALLBACK_APPLIED` marker in the container's own env, so an
adopted container started by an earlier host is judged the same way. If the
primary is still failing, that turn re-records the outage and the session goes
back to the fallback under the escalated cooldown.

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

| Piece                             | File                                             |
| --------------------------------- | ------------------------------------------------ |
| Rungs 1–3, the chat lines         | `container/agent-runner/src/poll-loop.ts`        |
| Availability windows, backoff     | `src/db/provider-health.ts`                      |
| Spawn-time routing decision       | `src/provider-fallback.ts`                       |
| Return of a live fallback session | `src/modules/sweep-provider-return/index.ts`     |
| `provider_unavailable` handler    | `src/modules/provider-fallback/handler.ts`       |
| `provider_retry_primary` handler  | `src/modules/provider-fallback/retry-primary.ts` |
| `codex_account_exhausted` handler | `src/modules/provider-fallback/codex-account.ts` |
| Spent Codex accounts, start pick  | `src/codex-accounts.ts`                          |

The two provider actions are session-scoped and act only on the reporting
session's own agent group: one records a window, the other clears one.
`codex_account_exhausted` accepts only a Codex home mounted into the reporting
group, and its mark reaches every group that mounts the same host account.
