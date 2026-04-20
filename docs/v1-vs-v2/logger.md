# logger: v1 vs v2

## Scope
- v1: `src/v1/logger.ts` (70 LOC) — export `logger`
- v2 counterpart: `src/log.ts` (65 LOC) — export `log`

## Capability map

| v1 behavior | v2 location | Status | Notes |
|---|---|---|---|
| Levels (debug=20, info=30, warn=40, error=50, fatal=60) | `src/log.ts:1` | kept | Identical numeric map |
| `debug/info/warn/error/fatal` methods | `src/log.ts:50-54` | renamed | `logger.X(...)` → `log.X(...)` |
| Data-first signature `(data, msg)` | `src/log.ts:42-58` | **changed** | v2 requires message-first `(msg, data?)` — breaking for every callsite |
| Color codes (per-level + KEY_COLOR=magenta, MSG_COLOR=cyan) | `src/log.ts:4-14` | kept | Identical |
| LOG_LEVEL env threshold | `src/log.ts:16` | kept | `'info'` default |
| Timestamp `HH:MM:SS.mmm` | `src/log.ts:33-40` | kept | Refactored, same output |
| Error formatting | `src/log.ts:18-23` | **changed** | v1 pretty multi-line JSON; v2 single-line |
| Data formatting | `src/log.ts:25-31` | **changed** | v1 per-line indented; v2 inline `key=value` |
| Process ID in output | — | **removed** | v1 emitted `(${process.pid})`; v2 drops it |
| info/debug → stdout, warn/error/fatal → stderr | `src/log.ts:45` | kept | Identical routing |
| `uncaughtException` → fatal + exit(1) | `src/log.ts:57-60` | kept | Arg order swapped |
| `unhandledRejection` → error | `src/log.ts:62-64` | kept | Arg order swapped |

## Missing from v2
1. **Process ID in log output** — lost visibility into emitting process in multi-container scenarios
2. **Data-first overload** — v1 `logger.warn({err, path}, 'msg')` is a breaking API change in v2
3. **Multi-line error formatting** — condensed single-line form is harder to read for stack traces

## Behavioral discrepancies
1. **Argument order**: `logger.error({err}, 'failed')` must become `log.error('failed', {err})` at every callsite
2. **Error output**: v1 pretty-prints JSON over 3 lines; v2 collapses to one line
3. **Data output**: v1 newline+indent per key; v2 space-separated inline

## Not in either
File rotation, redaction rules, on-disk logging — both stream to stdout/stderr only.

## Worth preserving?
Restoring PID to v2 output is cheap and helps multi-process debugging. Multi-line error format is worth a verbose-mode flag for `error`/`fatal`. Signature swap is stylistic; not worth reverting but every v1 `logger` → `log` migration must swap `(data, msg)` → `(msg, data)`.
