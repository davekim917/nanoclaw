#!/bin/bash
# Self-check for the two properties health-sentinel.sh gets wrong when nobody
# is looking. Runs the REAL script against a throwaway NANOCLAW_DIR with
# stubbed systemctl / tsx, so the assertions are about the shipped code path
# and not a re-implementation of it.
#
#   1. A failed DM leaves `last_alert` UNTOUCHED (the 6h cooldown is a receipt
#      of delivery, not of intent) — while log offsets still advance.
#   2. A delivered DM stamps `last_alert`.
#   3. WATCHED_TIMERS fails CLOSED: a timer that is inactive, uninstalled, or
#      whose LastTriggerUSec is empty/garbage BREACHES rather than reading OK.
#
#   bash scripts/health-sentinel-selfcheck.sh

set -uo pipefail

SENTINEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/health-sentinel.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
FAILED=0

mkdir -p "$ROOT/data" "$ROOT/logs" "$ROOT/node_modules/.bin" "$ROOT/bin" "$ROOT/scripts"
printf 'line\n%.0s' {1..50} > "$ROOT/logs/nanoclaw.log"
: > "$ROOT/logs/nanoclaw.error.log"
: > "$ROOT/scripts/notify-owner.ts"
# The archived-series vital (#602) only queries `data/v2.db` when the file
# exists — a real "not provisioned yet" host skips it rather than erroring.
# This fixture's tsx stub never actually reads the file's content (it answers
# from STUB_ARCHIVED_SESSION_IDS), so an empty placeholder is enough to clear
# that existence gate.
: > "$ROOT/data/v2.db"

# tsx stub: real script calls `node_modules/.bin/tsx scripts/notify-owner.ts
# --title ... --body ...` to deliver the owner DM. This fixture has no real
# data/v2.db and no Slack token, so the real notify-owner.ts would fail to
# even resolve an owner row — this stub mirrors exactly that outcome (exit 2,
# "cannot even try") without needing a real DB. Every case below therefore
# exercises the outbox FALLBACK, which is real, unstubbed code — asserting on
# the queued file is what makes this check honest, unlike the old cli.sock
# fixture, which accepted a connect and proved nothing about whether the
# router would have dropped the payload (exactly how the real delivery
# failure went unnoticed for three days).
cat > "$ROOT/node_modules/.bin/tsx" <<'EOS'
#!/bin/bash
case "$1" in
  *print-storage-admission-policy.ts)
    echo "${STUB_STORAGE_ADMISSION_POLICY:-enabled 90}"
    exit 0 ;;
  *q.ts)
    # Real script calls `q.ts <db-path> "SELECT id FROM sessions WHERE
    # archived_at IS NOT NULL"` for the archived-series vital (#602). No real
    # data/v2.db exists in this fixture, so this stub answers the query
    # directly from an env var instead — one id per line, matching q.ts's real
    # "list" output format (sqlite3-CLI-compatible, pipe-separated for
    # multi-column rows; this query is single-column so it's just the ids).
    printf '%s\n' ${STUB_ARCHIVED_SESSION_IDS:-}
    exit 0 ;;
esac
echo "notify-owner-stub: no fixture DB/token configured — cannot deliver" >&2
exit 2
EOS
chmod +x "$ROOT/node_modules/.bin/tsx"

# systemctl stub: nanoclaw-v2 is healthy; timer answers come from env so each
# case can drive one branch. STUB_LOADSTATE/STUB_ACTIVE/STUB_LASTTRIGGER.
cat > "$ROOT/bin/systemctl" <<'EOS'
#!/bin/bash
case "$*" in
  "is-active nanoclaw-v2") echo active ;;
  "show nanoclaw-v2 -p NRestarts --value") echo 0 ;;
  *"-p LoadState --value") echo "${STUB_LOADSTATE:-loaded}" ;;
  *"-p LastTriggerUSec --value") echo "${STUB_LASTTRIGGER:-}" ;;
  is-active*) echo "${STUB_ACTIVE:-active}" ;;
  *) exit 1 ;;
esac
EOS
chmod +x "$ROOT/bin/systemctl"

# `env` and not a bare assignment prefix: "$@" expands after the shell has
# already decided what the command word is.
# LOAD15_MAX is pinned out of reach because this harness stubs systemctl, tsx
# and ncl but CANNOT stub /proc/loadavg — the sentinel's load vital reads the
# real host. On a loaded box (15-min load >= 2*nproc) that vital breaches on
# every invocation, so the three cases that assert "all vitals OK" failed for
# a reason that has nothing to do with what they test. A caller that wants to
# exercise the load vital itself can still pass its own LOAD15_MAX in "$@",
# which lands after this and wins.
run_sentinel() { # -> exit code; stdout+stderr in $OUT
  OUT="$(env PATH="$ROOT/bin:$PATH" NANOCLAW_DIR="$ROOT" LOAD15_MAX=999999 "$@" bash "$SENTINEL" 2>&1)"
}
state() { python3 -c "
import json,sys
try: s=json.load(open(sys.argv[1]))
except Exception: s={}
print(s.get(sys.argv[2],0))" "$ROOT/data/health-sentinel-state.json" "$1"; }
last_alert() { python3 -c "
import json,sys
try: s=json.load(open(sys.argv[1]))
except Exception: s={}
print(s.get('last_alert',{}).get(sys.argv[2],''))" "$ROOT/data/health-sentinel-state.json" "$1"; }
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n     %s\n' "$1" "$2"; FAILED=1; }

# ── 1. delivery fails (no owner DB/token) → cooldown NOT burned, offsets advance ──
run_sentinel TEST_ALERT=1
RC=$?
[ "$RC" -ne 0 ] || bad "failed delivery must exit non-zero" "rc=$RC out=$OUT"
[ -z "$(last_alert test)" ] && ok "failed delivery left last_alert.test unset" \
  || bad "failed delivery burned the cooldown" "last_alert.test=$(last_alert test)"
[ "$(state log_off)" -gt 0 ] && ok "offsets advanced despite failed delivery ($(state log_off))" \
  || bad "offsets did not advance" "log_off=$(state log_off)"

# The point of (1): the very next run must still alert, not go quiet for 6h.
run_sentinel TEST_ALERT=1
case "$OUT" in
  *"within alert cooldown"*) bad "second run went quiet after an undelivered alert" "$OUT" ;;
  *) ok "second run still tries to alert" ;;
esac

# ── 2. delivery succeeds → cooldown stamped ─────────────────────────────────
# Delivery is a written file in the outbox, not a stubbed DM: outbox-ship.sh
# POSTs it to Slack with its own token and no host process, which is the only
# path that survives nanoclaw-v2 being down. The notify-owner.ts stub always
# fails here (no fixture DB/token), so this exercises the outbox FALLBACK —
# the same "delivery succeeded -> cooldown stamped" contract.
OUTBOX="$ROOT/data/outbox"
mkdir -p "$OUTBOX"
export HEALTH_SENTINEL_OUTBOX="$OUTBOX"
run_sentinel TEST_ALERT=1
RC=$?
[ "$RC" -eq 0 ] || bad "successful delivery should exit 0" "rc=$RC out=$OUT"
QUEUED=$(ls "$OUTBOX"/*health-sentinel*.md 2>/dev/null | wc -l)
[ "$QUEUED" -gt 0 ] && ok "successful delivery queued an alert file" \
  || bad "successful delivery queued nothing into the outbox" "$OUT"
[ -s "$(ls -t "$OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)" ] \
  && ok "queued alert is non-empty" \
  || bad "queued alert was empty" "$OUT"
[ -n "$(last_alert test)" ] && ok "successful delivery stamped last_alert.test" \
  || bad "successful delivery did not stamp the cooldown" "$OUT"
[ "$(state log_off)" -gt 0 ] && ok "offsets advanced on the success path" \
  || bad "offsets did not advance" "log_off=$(state log_off)"

# ── storage-admission policy ─────────────────────────────────────────────────
# The sentinel is a separate process, so it asks the shared TypeScript resolver
# instead of silently hardcoding 90 when `.env` says 93. This stub keeps the
# sentinel check hermetic; storage-manager.test.ts covers resolver validation.
disk_alert_contains() { # policy expected-text
  rm -f "$ROOT/data/health-sentinel-state.json"
  rm -f "$OUTBOX"/*health-sentinel*.md 2>/dev/null || true
  run_sentinel DISK_MAX_PCT=0 STUB_STORAGE_ADMISSION_POLICY="$1"
  local alert
  alert=$(ls -t "$OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)
  if [ -n "$alert" ] && grep -q "$2" "$alert"; then ok "disk alert $2"
  else bad "disk alert did not report $2" "out=$OUT alert=${alert:-<none>}"; fi
}
disk_alert_contains "enabled 93" "container admission refusal at 93%"
disk_alert_contains "disabled 93" "storage-manager admission is disabled"
disk_alert_contains "unreadable" "configured container-admission threshold unavailable"

# ── 3. WATCHED_TIMERS fails closed ──────────────────────────────────────────
# notify-owner.ts always fails in this fixture (see the stub above), so every
# breach here lands in the outbox — the breach text only exists in the queued
# file, so asserting on stdout alone would pass even when nothing breached.
trap 'rm -rf "$ROOT"' EXIT

breaches_on() { # label, env...
  local label="$1"; shift
  rm -f "$ROOT/data/health-sentinel-state.json"
  rm -f "$OUTBOX"/*health-sentinel*.md 2>/dev/null || true
  run_sentinel "$@" WATCHED_TIMERS="probe.timer:300"
  case "$OUT" in *"all vitals OK"*) bad "$label read as healthy" "$OUT"; return ;; esac
  # The breach text lives only in the queued alert, so asserting on stdout alone
  # would pass even if nothing was written.
  if grep -qh 'probe.timer' "$OUTBOX"/*health-sentinel*.md 2>/dev/null; then ok "$label breached"
  else bad "$label queued no probe.timer breach" "out=$OUT queued=$(ls "$OUTBOX" 2>/dev/null)"; fi
}
breaches_on "empty LastTriggerUSec"       STUB_LASTTRIGGER=""
breaches_on "unparseable LastTriggerUSec" STUB_LASTTRIGGER="n/a"
breaches_on "inactive timer"              STUB_ACTIVE="inactive" STUB_LASTTRIGGER="$(date)"
# Fresh trigger supplied deliberately: LoadState must be the ONLY thing that
# can breach here, or this case passes for the wrong reason.
breaches_on "uninstalled unit"            STUB_LOADSTATE="not-found" STUB_LASTTRIGGER="$(date)"
breaches_on "stale last trigger"          STUB_LASTTRIGGER="$(date -d '2 hours ago')"

# A fresh trigger inside the bound must NOT breach — otherwise "fails closed"
# is indistinguishable from "always fires", which is its own dead alarm.
rm -f "$ROOT/data/health-sentinel-state.json"
run_sentinel STUB_LASTTRIGGER="$(date)" WATCHED_TIMERS="probe.timer:300"
case "$OUT" in
  *"all vitals OK"*) ok "fresh trigger inside the bound stays quiet" ;;
  *) bad "fresh trigger breached" "$OUT" ;;
esac
# ── paused-series vital ─────────────────────────────────────────────────────
# A pause is an absorbing state that only the 8-strike auto-pause reports. Every
# other pause was silent until this vital: a daily briefing sat paused 12 days.
mkdir -p "$ROOT/bin"
stub_ncl() { printf '#!/bin/bash\n%s\n' "$1" > "$ROOT/bin/ncl"; chmod +x "$ROOT/bin/ncl"; }
OLD_RUN="$(date -u -d '10 days ago' +%Y-%m-%dT%H:%M:%SZ)"
NEW_RUN="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"

rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "echo '{\"data\":[{\"series_id\":\"ghost-x\",\"status\":\"paused\",\"last_run\":\"$OLD_RUN\"}]}'"
run_sentinel
# Assert on the vital's dedup KEY in state, not on stdout: when delivery
# succeeds the breach text goes into the DM payload, not the terminal.
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"paused-ghost-x"'*) ok "a series paused past the bound breached" ;;
  *) bad "a series paused 10 days did not breach" "$OUT" ;;
esac

# Opt-OUT, not opt-in: a deliberately retired series is named explicitly.
rm -f "$ROOT/data/health-sentinel-state.json"
run_sentinel PAUSED_SERIES_IGNORE=ghost-x
case "$OUT" in
  *"all vitals OK"*) ok "an explicitly ignored paused series stays quiet" ;;
  *) bad "PAUSED_SERIES_IGNORE did not suppress" "$OUT" ;;
esac

# Must not always-fire: a recent pause is inside the bound.
rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "echo '{\"data\":[{\"series_id\":\"ghost-x\",\"status\":\"paused\",\"last_run\":\"$NEW_RUN\"}]}'"
run_sentinel
case "$OUT" in
  *"all vitals OK"*) ok "a pause inside the bound stays quiet" ;;
  *) bad "a 1h-old pause breached" "$OUT" ;;
esac

# FAIL CLOSED. "Cannot look" must never read as "nothing wrong" — that is the
# exact shape this vital exists to close.
rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "exit 1"
run_sentinel
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"paused-series"'*) ok "an unreadable task listing breached (fail-closed)" ;;
  *) bad "a failing ncl tasks list read as healthy" "$OUT" ;;
esac

rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "echo 'not json {'"
run_sentinel
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"paused-series"'*) ok "an unparseable task listing breached (fail-closed)" ;;
  *) bad "unparseable JSON read as healthy" "$OUT" ;;
esac

# ── archived-series vital (#602) ────────────────────────────────────────────
# `threads.close` archives a session but leaves any bound task series
# pending/paused; the sweep no longer retries or warns per-tick (that was
# #602's own problem), so this vital is the only thing that reports the
# strand at all.
rm -f "$ROOT/data/health-sentinel-state.json"
rm -f "$OUTBOX"/*health-sentinel*.md 2>/dev/null || true
stub_ncl "echo '{\"data\":[{\"series_id\":\"ghost-y\",\"status\":\"pending\",\"session_id\":\"sess-archived\"}]}'"
run_sentinel STUB_ARCHIVED_SESSION_IDS=sess-archived
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"archived-series-ghost-y"'*) ok "a pending series bound to an archived session breached" ;;
  *) bad "a pending series on an archived session did not breach" "$OUT" ;;
esac
# The remedy must be cancel-only. `ncl tasks pause` does not clear this
# breach (a paused series is exactly as stranded), so offering it sends the
# operator straight back into the same alert next cooldown.
ARCHIVED_ALERT=$(ls -t "$OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)
if [ -n "$ARCHIVED_ALERT" ] && grep -q 'ncl tasks cancel --id ghost-y' "$ARCHIVED_ALERT"; then
  ok "archived-series remedy names ncl tasks cancel"
else
  bad "archived-series remedy did not name ncl tasks cancel" "alert=${ARCHIVED_ALERT:-<none>}"
fi
if [ -n "$ARCHIVED_ALERT" ] && grep -q 'ncl tasks pause' "$ARCHIVED_ALERT"; then
  bad "archived-series remedy still suggests ncl tasks pause" "alert=$ARCHIVED_ALERT"
else
  ok "archived-series remedy does not suggest ncl tasks pause"
fi

# The strand shape #601 leaves behind (still pending/paused) must breach
# regardless of which of the two live statuses it is.
rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "echo '{\"data\":[{\"series_id\":\"ghost-z\",\"status\":\"paused\",\"session_id\":\"sess-archived\"}]}'"
run_sentinel STUB_ARCHIVED_SESSION_IDS=sess-archived
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"archived-series-ghost-z"'*) ok "a paused series bound to an archived session breached" ;;
  *) bad "a paused series on an archived session did not breach" "$OUT" ;;
esac
# Reported ONCE, as the archived-session strand — not also as an ordinary
# paused-series breach, whose remedy (`ncl tasks resume`) cannot fix this: the
# session it would resume onto is gone.
case "$(cat "$ROOT/data/health-sentinel-state.json")" in
  *'"paused-ghost-z"'*) bad "a paused+archived series ALSO breached as an ordinary pause" "$OUT" ;;
  *) ok "a paused+archived series is not double-reported" ;;
esac

# A live series whose session is NOT archived must not breach this vital —
# same fixture shape, no id in the archived set.
rm -f "$ROOT/data/health-sentinel-state.json"
stub_ncl "echo '{\"data\":[{\"series_id\":\"ghost-live\",\"status\":\"pending\",\"session_id\":\"sess-live\"}]}'"
run_sentinel STUB_ARCHIVED_SESSION_IDS=sess-archived
case "$OUT" in
  *"all vitals OK"*) ok "a live series on a non-archived session stays quiet" ;;
  *) bad "a live series on a live session breached" "$OUT" ;;
esac
rm -f "$ROOT/bin/ncl"


[ "$FAILED" -eq 0 ] && echo "health-sentinel-selfcheck: all checks passed" || echo "health-sentinel-selfcheck: FAILURES"
exit "$FAILED"
