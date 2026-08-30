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
: > "$ROOT/scripts/q.ts"

# tsx stub: the owner-DM lookup. Real script calls node_modules/.bin/tsx.
cat > "$ROOT/node_modules/.bin/tsx" <<'EOS'
#!/bin/bash
echo "UOWNER|slack"
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
run_sentinel() { # -> exit code; stdout+stderr in $OUT
  OUT="$(env PATH="$ROOT/bin:$PATH" NANOCLAW_DIR="$ROOT" "$@" bash "$SENTINEL" 2>&1)"
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

# ── 1. delivery fails (no socket) → cooldown NOT burned, offsets DO advance ──
rm -f "$ROOT/data/cli.sock"
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
python3 - "$ROOT/data/cli.sock" <<'EOS' &
import os, socket, sys
p = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(p); s.listen(1)
s.settimeout(30)
try:
    c, _ = s.accept(); c.recv(65536); c.close()
except Exception: pass
s.close(); os.unlink(p)
EOS
SRV=$!
for _ in $(seq 50); do [ -S "$ROOT/data/cli.sock" ] && break; sleep 0.1; done
run_sentinel TEST_ALERT=1
RC=$?
wait $SRV 2>/dev/null
[ "$RC" -eq 0 ] || bad "successful delivery should exit 0" "rc=$RC out=$OUT"
[ -n "$(last_alert test)" ] && ok "successful delivery stamped last_alert.test" \
  || bad "successful delivery did not stamp the cooldown" "$OUT"
[ "$(state log_off)" -gt 0 ] && ok "offsets advanced on the success path" \
  || bad "offsets did not advance" "log_off=$(state log_off)"

# ── 3. WATCHED_TIMERS fails closed ──────────────────────────────────────────
# Live socket sink for this section: the breach text only exists in the DM
# payload, so asserting on stdout alone would pass on a connect failure.
SENT="$ROOT/data/sent.log"
: > "$SENT"
python3 - "$ROOT/data/cli.sock" "$SENT" <<'EOS' &
import os, socket, sys
p, out = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(p); s.listen(8)
s.settimeout(60)
try:
    while True:
        c, _ = s.accept()
        with open(out, "ab") as f: f.write(c.recv(65536))
        c.close()
except Exception: pass
s.close()
EOS
SINK=$!
trap 'kill $SINK 2>/dev/null; rm -rf "$ROOT"' EXIT
for _ in $(seq 50); do [ -S "$ROOT/data/cli.sock" ] && break; sleep 0.1; done

breaches_on() { # label, env...
  local label="$1"; shift
  rm -f "$ROOT/data/health-sentinel-state.json"
  : > "$SENT"
  run_sentinel "$@" WATCHED_TIMERS="probe.timer:300"
  case "$OUT" in *"all vitals OK"*) bad "$label read as healthy" "$OUT"; return ;; esac
  if grep -q 'probe.timer' "$SENT"; then ok "$label breached"
  else bad "$label sent no probe.timer breach" "out=$OUT sent=$(cat "$SENT")"; fi
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
kill $SINK 2>/dev/null

[ "$FAILED" -eq 0 ] && echo "health-sentinel-selfcheck: all checks passed" || echo "health-sentinel-selfcheck: FAILURES"
exit "$FAILED"
