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
  "show nanoclaw-v2 -p ActiveEnterTimestamp --value") echo "${STUB_SVC_START:-}" ;;
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

# ── deploy-lag and deploy-restart ───────────────────────────────────────────
# The fixture becomes a git repo so the vital has something to measure. There
# is no remote: origin/main is set with update-ref, and the vital's fetch fails
# and falls back to that ref — the path a host takes when GitHub is down.
# Committer dates are explicit because the vital times the wait from them.
# Every case before this one ran with no repo, so the vital skipped cleanly.
git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email selfcheck@localhost
git -C "$ROOT" config user.name selfcheck
commit_at() { # <path> <age, e.g. '5 hours ago'> -> sha
  mkdir -p "$ROOT/$(dirname "$1")"
  echo "$RANDOM" >> "$ROOT/$1"
  git -C "$ROOT" add "$1"
  GIT_COMMITTER_DATE="$(date -d "$2" -R)" GIT_AUTHOR_DATE="$(date -d "$2" -R)" \
    git -C "$ROOT" commit -q -m "$1"
  git -C "$ROOT" rev-parse HEAD
}
build_info() { # <sha> <builtAt age>
  mkdir -p "$ROOT/dist"
  printf '{"sha":"%s","shortSha":"%s","builtAt":"%s"}\n' "$1" "${1:0:9}" \
    "$(date -u -d "$2" +%Y-%m-%dT%H:%M:%S.000Z)" > "$ROOT/dist/BUILD_INFO.json"
}
has_key() { case "$(cat "$ROOT/data/health-sentinel-state.json" 2>/dev/null)" in *"\"$1\""*) return 0 ;; esac; return 1; }
fresh() { rm -f "$ROOT/data/health-sentinel-state.json" "$OUTBOX"/*health-sentinel*.md 2>/dev/null || true; }

BASE=$(commit_at src/a.ts '10 hours ago')
build_info "$BASE" '10 hours ago'
DOCS=$(commit_at docs/notes.md '5 hours ago')
git -C "$ROOT" update-ref refs/remotes/origin/main "$DOCS"
fresh; run_sentinel
case "$OUT" in
  *"all vitals OK"*) ok "a docs-only merge past the bound stays quiet" ;;
  *) bad "a docs-only merge breached deploy-lag" "$OUT" ;;
esac

RUNTIME=$(commit_at src/b.ts '4 hours ago')
git -C "$ROOT" update-ref refs/remotes/origin/main "$RUNTIME"
fresh; run_sentinel
has_key deploy-lag && ok "a runtime merge past the bound breached deploy-lag" \
  || bad "a 4h-old runtime merge did not breach" "$OUT"
# The count must skip the docs merge in front of it.
if grep -qh '^- 1 merge(s) on origin/main change the host or its agent runner' "$OUTBOX"/*health-sentinel*.md 2>/dev/null; then
  ok "deploy-lag counts only the runtime merge"
else
  bad "deploy-lag miscounted merges" "$(cat "$OUTBOX"/*health-sentinel*.md 2>/dev/null)"
fi

# dist/ rebuilt 4h ago onto a service that has run for 5h: built, never restarted.
build_info "$RUNTIME" '4 hours ago'
YOUNG=$(commit_at src/c.ts '10 minutes ago')
git -C "$ROOT" update-ref refs/remotes/origin/main "$YOUNG"
fresh; run_sentinel STUB_SVC_START="$(date -d '5 hours ago')"
has_key deploy-restart && ok "a build the service never restarted onto breached" \
  || bad "built-not-restarted did not breach" "$OUT"
# Must not always-fire: the 10-minute-old runtime merge is inside the bound.
has_key deploy-lag && bad "a 10-minute-old runtime merge breached deploy-lag" "$OUT" \
  || ok "a runtime merge inside the bound stays quiet"

# Restarted after the build: the running process is the built one.
fresh; run_sentinel STUB_SVC_START="$(date -d '3 hours ago')"
case "$OUT" in
  *"all vitals OK"*) ok "a service restarted after its build stays quiet" ;;
  *) bad "a service restarted onto its build still breached" "$OUT" ;;
esac

# A scripts-only merge the checkout has not pulled, 5h old. It goes live with a
# pull and needs no restart, so the 3h restart bound must not fire on it.
build_info "$YOUNG" '2 hours ago'
SCRIPT=$(commit_at scripts/tool.sh '5 hours ago')
git -C "$ROOT" update-ref refs/remotes/origin/main "$SCRIPT"
git -C "$ROOT" update-ref refs/heads/main "$YOUNG"
fresh; run_sentinel STUB_SVC_START="$(date -d '1 hour ago')"
case "$OUT" in
  *"all vitals OK"*) ok "a 5h-old scripts-only merge stays inside the pull bound" ;;
  *) bad "a scripts-only merge breached on the restart bound" "$OUT" ;;
esac
fresh; run_sentinel STUB_SVC_START="$(date -d '1 hour ago')" DEPLOY_LAG_PULL_MAX_S=14400
if grep -qh '^- 1 merge(s) to scripts or skills have waited 5h' "$OUTBOX"/*health-sentinel*.md 2>/dev/null; then
  ok "a scripts-only merge past the pull bound breached, as a pull, not a restart"
else
  bad "a scripts-only merge past the pull bound did not breach as a pull" "$OUT"
fi
# Pulled but never built: the script is live and no host code is pending.
git -C "$ROOT" update-ref refs/heads/main "$SCRIPT"
fresh; run_sentinel STUB_SVC_START="$(date -d '1 hour ago')" DEPLOY_LAG_PULL_MAX_S=14400
case "$OUT" in
  *"all vitals OK"*) ok "a pulled scripts-only merge stays quiet with no rebuild" ;;
  *) bad "a pulled scripts-only merge still breached" "$OUT" ;;
esac

# ── pull-lag and restart-lag no longer share a dedup key (#716 P3) ─────────
# The two breaches used to both stamp `deploy-lag`, so a pull-lag alert (the
# 24h-bound half that needs no restart) could stamp the SAME cooldown a
# restart-lag breach (the 3h-bound, more serious half) relies on, hiding it
# for up to 6h behind an unrelated alert. Own fixture, not the shared $ROOT
# above (whose git history and refs are already committed to the scenarios
# tested there): a scripts-only commit (pull-lag) is built first, then a
# src/ commit (restart-lag) on top of it, so each vital's trigger condition
# can be turned on independently across two runs against the SAME persisted
# state.json — the only way to actually exercise a dedup collision between
# them, since a single sentinel run's if/elif only ever evaluates one.
DEDUP_ROOT="$(mktemp -d -p "$ROOT")"
mkdir -p "$DEDUP_ROOT/data" "$DEDUP_ROOT/logs" "$DEDUP_ROOT/node_modules/.bin" "$DEDUP_ROOT/bin" "$DEDUP_ROOT/dist" "$DEDUP_ROOT/scripts"
: > "$DEDUP_ROOT/logs/nanoclaw.log"
: > "$DEDUP_ROOT/logs/nanoclaw.error.log"
: > "$DEDUP_ROOT/scripts/notify-owner.ts"
cp "$ROOT/node_modules/.bin/tsx" "$DEDUP_ROOT/node_modules/.bin/tsx"
cp "$ROOT/bin/systemctl" "$DEDUP_ROOT/bin/systemctl"
DEDUP_OUTBOX="$DEDUP_ROOT/data/outbox"
mkdir -p "$DEDUP_OUTBOX"

git -C "$DEDUP_ROOT" init -q -b main
git -C "$DEDUP_ROOT" config user.email selfcheck@localhost
git -C "$DEDUP_ROOT" config user.name selfcheck
mkdir -p "$DEDUP_ROOT/src"
echo base >> "$DEDUP_ROOT/src/a.ts"
git -C "$DEDUP_ROOT" add src/a.ts
GIT_COMMITTER_DATE="$(date -d '20 hours ago' -R)" GIT_AUTHOR_DATE="$(date -d '20 hours ago' -R)" \
  git -C "$DEDUP_ROOT" commit -q -m base
DEDUP_BASE=$(git -C "$DEDUP_ROOT" rev-parse HEAD)
printf '{"sha":"%s","shortSha":"%s","builtAt":"%s"}\n' "$DEDUP_BASE" "${DEDUP_BASE:0:9}" \
  "$(date -u -d '20 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)" > "$DEDUP_ROOT/dist/BUILD_INFO.json"

# Both later commits are built on a side branch so the checked-out `main`
# (and therefore HEAD) stays at $DEDUP_BASE — origin/main is pointed at them
# explicitly below, the same "local HEAD stayed behind" shape as the
# SCRIPT/YOUNG rollback trick above, so PULL_BEHIND (measured from HEAD) is
# genuinely > 0 rather than trivially equal to origin/main.
git -C "$DEDUP_ROOT" checkout -q -b tmp-origin
echo tool >> "$DEDUP_ROOT/scripts/tool.sh"
git -C "$DEDUP_ROOT" add scripts/tool.sh
GIT_COMMITTER_DATE="$(date -d '5 hours ago' -R)" GIT_AUTHOR_DATE="$(date -d '5 hours ago' -R)" \
  git -C "$DEDUP_ROOT" commit -q -m pull-lag-merge
DEDUP_SCRIPT=$(git -C "$DEDUP_ROOT" rev-parse HEAD)
echo restart >> "$DEDUP_ROOT/src/b.ts"
git -C "$DEDUP_ROOT" add src/b.ts
GIT_COMMITTER_DATE="$(date -d '4 hours ago' -R)" GIT_AUTHOR_DATE="$(date -d '4 hours ago' -R)" \
  git -C "$DEDUP_ROOT" commit -q -m restart-lag-merge
DEDUP_RESTART=$(git -C "$DEDUP_ROOT" rev-parse HEAD)
git -C "$DEDUP_ROOT" checkout -q main

run_dedup_sentinel() { # env... -> sets OUT
  OUT="$(env PATH="$DEDUP_ROOT/bin:$PATH" NANOCLAW_DIR="$DEDUP_ROOT" LOAD15_MAX=999999 HEALTH_SENTINEL_OUTBOX="$DEDUP_OUTBOX" "$@" bash "$SENTINEL" 2>&1)"
}

# origin/main is one scripts-only commit ahead of the (unmoved) local HEAD:
# BEHIND (RESTART_PATHS, from $DEPLOYED) is 0, so only the pull-lag half can
# fire. Delivered non-dry to $DEDUP_OUTBOX so its dedup key actually gets
# stamped in state.json, same as the production success path.
git -C "$DEDUP_ROOT" update-ref refs/remotes/origin/main "$DEDUP_SCRIPT"
run_dedup_sentinel DEPLOY_LAG_PULL_MAX_S=14400
PULL_ALERT=$(ls -t "$DEDUP_OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)
if [ -n "$PULL_ALERT" ] && grep -q 'merge(s) to scripts or skills' "$PULL_ALERT"; then
  ok "a pull-lag breach fires first and reaches the outbox"
else
  bad "the pull-lag breach did not reach the outbox" "out=$OUT alert=${PULL_ALERT:-<none>}"
fi

# origin/main now also carries the src/ commit: BEHIND (RESTART_PATHS) from
# $DEPLOYED (still $DEDUP_BASE) is 1, aged 4h past the default 3h bound, so
# restart-lag fires this time — moments after the pull-lag run above, well
# inside the 6h cooldown. Before the fix, both breaches stamped the same
# `deploy-lag` key, so this restart-lag breach would be silently suppressed
# by the pull-lag run's stamp; fixed, pull-lag stamps `deploy-lag-pull`
# instead, and this restart-lag breach must still reach the outbox.
rm -f "$DEDUP_OUTBOX"/*health-sentinel*.md
git -C "$DEDUP_ROOT" update-ref refs/remotes/origin/main "$DEDUP_RESTART"
run_dedup_sentinel
RESTART_ALERT=$(ls -t "$DEDUP_OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)
if [ -n "$RESTART_ALERT" ] && grep -q 'merge(s) on origin/main change the host or its agent runner' "$RESTART_ALERT"; then
  ok "a restart-lag breach still reaches the outbox after an earlier pull-lag breach within its cooldown"
else
  bad "the restart-lag breach was suppressed by the pull-lag breach's cooldown" "out=$OUT alert=${RESTART_ALERT:-<none>}"
fi
rm -rf "$DEDUP_ROOT"

# ── DRY_RUN performs no fetch; the fetch and status calls carry their flags ──
# (#618 P3) A dedicated, disposable git fixture — not the shared $ROOT above,
# whose history is deliberately doctored for the scenarios tested there — so
# this only has to reason about one clean, one-merge-behind repo. A fake
# `git` ahead of the real one on PATH records every invocation and then execs
# the real binary, so the rest of the vital's git plumbing still runs for
# real; this is the "fake git that records calls" the review asked for.
# -p "$ROOT", not a bare mktemp: $ROOT is already under the EXIT trap (line
# 19), so nesting this fixture inside it means an early exit (a failure under
# `set -e` in a caller's shell, Ctrl-C, a killed CI job) still cleans it up
# instead of leaking a throwaway git repo in /tmp. The explicit `rm -rf` below
# stays as the fast path; the trap is the backstop.
FLAG_ROOT="$(mktemp -d -p "$ROOT")"
mkdir -p "$FLAG_ROOT/data" "$FLAG_ROOT/logs" "$FLAG_ROOT/node_modules/.bin" "$FLAG_ROOT/bin" "$FLAG_ROOT/dist"
: > "$FLAG_ROOT/logs/nanoclaw.log"
: > "$FLAG_ROOT/logs/nanoclaw.error.log"
cp "$ROOT/node_modules/.bin/tsx" "$FLAG_ROOT/node_modules/.bin/tsx"
cp "$ROOT/bin/systemctl" "$FLAG_ROOT/bin/systemctl"

git -C "$FLAG_ROOT" init -q -b main
git -C "$FLAG_ROOT" config user.email selfcheck@localhost
git -C "$FLAG_ROOT" config user.name selfcheck
mkdir -p "$FLAG_ROOT/src"
echo base >> "$FLAG_ROOT/src/a.ts"
git -C "$FLAG_ROOT" add src/a.ts
GIT_COMMITTER_DATE="$(date -d '10 hours ago' -R)" GIT_AUTHOR_DATE="$(date -d '10 hours ago' -R)" \
  git -C "$FLAG_ROOT" commit -q -m base
FLAG_BASE=$(git -C "$FLAG_ROOT" rev-parse HEAD)
printf '{"sha":"%s","shortSha":"%s","builtAt":"%s"}\n' "$FLAG_BASE" "${FLAG_BASE:0:9}" \
  "$(date -u -d '10 hours ago' +%Y-%m-%dT%H:%M:%S.000Z)" > "$FLAG_ROOT/dist/BUILD_INFO.json"
echo runtime >> "$FLAG_ROOT/src/b.ts"
git -C "$FLAG_ROOT" add src/b.ts
GIT_COMMITTER_DATE="$(date -d '4 hours ago' -R)" GIT_AUTHOR_DATE="$(date -d '4 hours ago' -R)" \
  git -C "$FLAG_ROOT" commit -q -m runtime
FLAG_RUNTIME=$(git -C "$FLAG_ROOT" rev-parse HEAD)
git -C "$FLAG_ROOT" update-ref refs/remotes/origin/main "$FLAG_RUNTIME"

GIT_CALLS="$FLAG_ROOT/git-calls.log"
: > "$GIT_CALLS"
REAL_GIT="$(command -v git)"
# Logs GIT_OPTIONAL_LOCKS alongside the call, not just the argv: removing the
# `export GIT_OPTIONAL_LOCKS=0` at the top of health-sentinel.sh (#715 P3)
# left this selfcheck green, because nothing asserted the env var itself —
# only that `status` carried its own `--no-optional-locks` flag. The fetch
# call carries no per-invocation flag for this at all, so the export is its
# only guard.
cat > "$FLAG_ROOT/bin/git" <<EOF
#!/bin/bash
printf 'GIT_OPTIONAL_LOCKS=%s %s\n' "\${GIT_OPTIONAL_LOCKS:-<unset>}" "\$*" >> "$GIT_CALLS"
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FLAG_ROOT/bin/git"

run_flag_sentinel() { # env... -> sets OUT (no outbox: this fixture only cares about $OUT/$GIT_CALLS)
  # `-u GIT_OPTIONAL_LOCKS`: strip any ambient value before the sentinel runs,
  # so the GIT_OPTIONAL_LOCKS=0 assertions below can only pass because
  # health-sentinel.sh's own `export` set it, never because it leaked in from
  # this harness's environment.
  OUT="$(env -u GIT_OPTIONAL_LOCKS PATH="$FLAG_ROOT/bin:$PATH" NANOCLAW_DIR="$FLAG_ROOT" LOAD15_MAX=999999 HEALTH_SENTINEL_OUTBOX= "$@" bash "$SENTINEL" 2>&1)"
}

: > "$GIT_CALLS"
run_flag_sentinel
if grep -q -- '-c gc.auto=0 -c maintenance.auto=false fetch --quiet --no-write-fetch-head origin main' "$GIT_CALLS"; then
  ok "fetch carries -c gc.auto=0 -c maintenance.auto=false --no-write-fetch-head"
else
  bad "fetch is missing the safety flags" "$(cat "$GIT_CALLS")"
fi
if grep -q -- '--no-optional-locks status' "$GIT_CALLS"; then
  ok "git status runs with --no-optional-locks"
else
  bad "git status missing --no-optional-locks" "$(cat "$GIT_CALLS")"
fi
# (#715 P3) `export GIT_OPTIONAL_LOCKS=0` at the top of health-sentinel.sh had
# no test of its own — removing it still passed both checks above, since
# neither one asserted the env var itself, only argv flags. Assert it
# directly: every git call this vital makes must see it exported as 0.
#
# `[ -s "$GIT_CALLS" ] &&` guards the OK path, not just the BAD one (#716
# P3): `grep -qv PATTERN` on a completely empty file has nothing to select
# either way and exits 1 (false), so the un-guarded form below used to read
# a call log with NOTHING recorded in it as "every call exported it" — a
# vacuous pass that would stay quiet even if the fake git wrapper above were
# never actually invoked. Requiring the log to be non-empty before a PASS is
# possible turns that silent case into a FAIL, the same fail-closed shape the
# two checks above already have (each requires ITS OWN pattern to be found).
if [ -s "$GIT_CALLS" ] && ! grep -qv '^GIT_OPTIONAL_LOCKS=0 ' "$GIT_CALLS"; then
  ok "every git call ran with GIT_OPTIONAL_LOCKS=0 exported"
else
  bad "a git call ran without GIT_OPTIONAL_LOCKS=0 exported, or no git call was recorded at all" "$(cat "$GIT_CALLS")"
fi

: > "$GIT_CALLS"
run_flag_sentinel DRY_RUN=1
if grep -q 'fetch' "$GIT_CALLS"; then
  bad "dry run performed a fetch" "$(cat "$GIT_CALLS")"
else
  ok "dry run performs no fetch"
fi
case "$OUT" in
  *"last-fetched origin/main"*) ok "dry run says the lag is against the last-fetched ref" ;;
  *) bad "dry run did not explain the last-fetched-ref caveat" "$OUT" ;;
esac
rm -rf "$FLAG_ROOT"

# ── invalid DEPLOY_LAG_MAX_S / DEPLOY_LAG_PULL_MAX_S / missing jq (#618 P3) ──
# Chosen behavior: fail CLOSED, the same shape WATCHED_TIMERS already uses
# above — an invalid or missing input is its own breach, never a silent skip
# or a substituted default. DRY_RUN keeps these hermetic: no delivery/outbox
# plumbing needed, just the "would alert" listing.
run_sentinel DRY_RUN=1 DEPLOY_LAG_MAX_S=notanumber
case "$OUT" in
  *"DEPLOY_LAG_MAX_S='notanumber' is not a non-negative integer"*) ok "a non-integer DEPLOY_LAG_MAX_S is reported as a breach" ;;
  *) bad "a non-integer DEPLOY_LAG_MAX_S was not reported" "$OUT" ;;
esac

run_sentinel DRY_RUN=1 DEPLOY_LAG_PULL_MAX_S=notanumber
case "$OUT" in
  *"DEPLOY_LAG_PULL_MAX_S='notanumber' is not a non-negative integer"*) ok "a non-integer DEPLOY_LAG_PULL_MAX_S is reported as a breach" ;;
  *) bad "a non-integer DEPLOY_LAG_PULL_MAX_S was not reported" "$OUT" ;;
esac

# DEPLOY_LAG_MAX_S=0 stays the one documented, intentional off switch — not a
# config error, so it must NOT raise the new config breach.
run_sentinel DRY_RUN=1 DEPLOY_LAG_MAX_S=0
case "$OUT" in
  *"is not a non-negative integer"*) bad "DEPLOY_LAG_MAX_S=0 was treated as an invalid threshold" "$OUT" ;;
  *) ok "DEPLOY_LAG_MAX_S=0 stays the documented off switch, not a config breach" ;;
esac

# Overflow (#715 P3): `is_nonneg_int` used to accept a digit string of any
# length, and `[ -eq ]`/`[ -ge ]` on a value past int64 range (2^63-1 = 19
# digits) errors with exit status 2 — which `if`/`elif` reads as plain false,
# not a crash. That let an overflowing threshold sail past validation as "a
# non-negative integer" and then silently switch the whole vital off a few
# lines down, with no breach and no error. 20 digits is comfortably past the
# 18-digit cap.
run_sentinel DRY_RUN=1 DEPLOY_LAG_MAX_S=12345678901234567890
case "$OUT" in
  *"DEPLOY_LAG_MAX_S='12345678901234567890' is not a non-negative integer"*) ok "a 20-digit (overflowing) DEPLOY_LAG_MAX_S is reported as a breach" ;;
  *) bad "a 20-digit DEPLOY_LAG_MAX_S overflow was not reported" "$OUT" ;;
esac

# The cap boundary itself, not just A case comfortably past it (#716 P3): the
# 20-digit case above would still pass even if the 18-digit cap were loosened
# to 19 (a 19-digit value is still well under int64's 2^63-1 = 19 digits, so
# it would neither overflow `[ -ge ]` nor get caught) — and a 19-digit
# DEPLOY_LAG_MAX_S would then silently switch the vital off with nobody told,
# the exact shape this validation exists to close. Pin both edges directly.
run_sentinel DRY_RUN=1 DEPLOY_LAG_MAX_S=9999999999999999999
case "$OUT" in
  *"DEPLOY_LAG_MAX_S='9999999999999999999' is not a non-negative integer of at most 18 digits"*) ok "a 19-digit DEPLOY_LAG_MAX_S is reported as a breach" ;;
  *) bad "a 19-digit DEPLOY_LAG_MAX_S was not reported as a breach" "$OUT" ;;
esac

run_sentinel DRY_RUN=1 DEPLOY_LAG_MAX_S=999999999999999999
case "$OUT" in
  *"is not a non-negative integer"*) bad "an 18-digit DEPLOY_LAG_MAX_S was treated as invalid" "$OUT" ;;
  *) ok "an 18-digit DEPLOY_LAG_MAX_S stays within the cap" ;;
esac

# A missing `jq`: a PATH built from symlinks to every tool the script needs
# EXCEPT jq, so `command -v jq` genuinely fails closed instead of silently
# falling back to HEAD (the exact under-report the header warns about).
# `rm` is in the list (not just the read-only tools) because a non-dry run
# needs it to clean up its own ALERT_FILE trap (health-sentinel.sh:510) — an
# earlier version of this fixture omitted it, so the trap's `rm -f` silently
# failed (no `rm` on PATH) and every run of the both-faults case below leaked
# a 372-byte alert file into $TMPDIR. Built once here and reused by both
# no-jq cases so the tool list only has to be kept correct in one place.
build_nojq_dir() { # -> path to a fresh directory, on stdout
  local dir
  # -p "$ROOT": nested under the EXIT trap's directory so an early exit still
  # cleans it up, same reasoning as FLAG_ROOT above.
  dir="$(mktemp -d -p "$ROOT")"
  local tool tool_path
  for tool in bash awk cat date df dirname git grep head mktemp nproc od python3 rm stat tail timeout tr wc; do
    tool_path="$(command -v "$tool" 2>/dev/null)"
    [ -n "$tool_path" ] && ln -sf "$tool_path" "$dir/$tool"
  done
  printf '%s\n' "$dir"
}

NOJQ_DIR="$(build_nojq_dir)"
OUT="$(env PATH="$ROOT/bin:$NOJQ_DIR" NANOCLAW_DIR="$ROOT" LOAD15_MAX=999999 DRY_RUN=1 bash "$SENTINEL" 2>&1)"
case "$OUT" in
  *"jq is not installed"*) ok "a missing jq is reported as a breach" ;;
  *) bad "a missing jq was not reported as a breach" "$OUT" ;;
esac
rm -rf "$NOJQ_DIR"

# ── two config faults at once, delivered together (#715 P3) ────────────────
# The three config faults used to share one dedup key, `deploy-lag-config`,
# and the dedup loop sends only the first message per key within the 6h
# cooldown — so an invalid DEPLOY_LAG_PULL_MAX_S together with a missing jq
# delivered only one of the two breaches and the cooldown then hid the other
# for 6h. Now that each fault has its own key, both must land in the SAME
# delivered alert. Non-dry, going to the outbox under $ROOT like the other
# delivery-path cases above (notify-owner.ts always fails in this fixture, so
# delivery falls through to HEALTH_SENTINEL_OUTBOX, already exported above).
#
# This is the only non-dry case in this section, so it is the one that
# actually exercises the sentinel's `mktemp`+EXIT-trap cleanup of its own
# ALERT_FILE (health-sentinel.sh:509-510). Pointing TMPDIR at a fresh,
# otherwise-empty directory under $ROOT lets us assert directly that nothing
# was left behind (#716 P3): with `rm` missing from NOJQ_DIR the trap fails
# silently and the alert file leaks.
rm -f "$ROOT/data/health-sentinel-state.json"
rm -f "$OUTBOX"/*health-sentinel*.md 2>/dev/null || true
NOJQ_DIR="$(build_nojq_dir)"
ALERT_TMPDIR="$(mktemp -d -p "$ROOT")"
OUT="$(env PATH="$ROOT/bin:$NOJQ_DIR" NANOCLAW_DIR="$ROOT" LOAD15_MAX=999999 TMPDIR="$ALERT_TMPDIR" DEPLOY_LAG_PULL_MAX_S=notanumber bash "$SENTINEL" 2>&1)"
BOTH_ALERT=$(ls -t "$OUTBOX"/*health-sentinel*.md 2>/dev/null | head -1)
if [ -n "$BOTH_ALERT" ] && grep -q "DEPLOY_LAG_PULL_MAX_S='notanumber' is not a non-negative integer" "$BOTH_ALERT"; then
  ok "invalid PULL_MAX_S + missing jq: the pull-config breach reached the outbox"
else
  bad "the pull-config breach did not reach the outbox" "out=$OUT alert=${BOTH_ALERT:-<none>}"
fi
if [ -n "$BOTH_ALERT" ] && grep -q "jq is not installed" "$BOTH_ALERT"; then
  ok "invalid PULL_MAX_S + missing jq: the jq breach reached the outbox"
else
  bad "the jq breach did not reach the outbox" "out=$OUT alert=${BOTH_ALERT:-<none>}"
fi
LEFTOVER=$(ls -A "$ALERT_TMPDIR" 2>/dev/null | wc -l)
[ "$LEFTOVER" -eq 0 ] && ok "the both-faults run left no alert file behind in TMPDIR" \
  || bad "the both-faults run leaked $LEFTOVER file(s) into TMPDIR" "$(ls -la "$ALERT_TMPDIR")"
rm -rf "$NOJQ_DIR" "$ALERT_TMPDIR"

[ "$FAILED" -eq 0 ] && echo "health-sentinel-selfcheck: all checks passed" || echo "health-sentinel-selfcheck: FAILURES"
exit "$FAILED"
