#!/usr/bin/env bash
# smoke-pair-identity.sh — frozen-pair identity for QA runs.
# Identity = the LIVE serving Render deploy (service id, deploy id, commit) of BOTH
# frontend and backend services for a run. Not a bundle host, not a health check,
# not the shared worktree HEAD. Fails closed on everything.
#
#   start    <run-dir>          freeze once → <run-dir>/coordinator/identity.json (no-clobber: exit 4 if it exists)
#   check    <run-dir> <label>  re-read live pair, append coordinator/identity-checks.ndjson
#   refreeze <run-dir> <reason> bounded re-freeze after drift: exactly ONCE per run (see below)
#   finish   <run-dir>          coordinator pre-publication check: identity.json present; after a
#                                re-freeze, every required lane redispatched since it; ≥1 prior check
#                                at the CURRENT freeze generation and every such check ok; live
#                                pair unchanged
#   read                        print the current live pair as JSON
#
# For a PR-owned completion contract, start/check/finish also require both
# serving commits to equal that contract's sourceSha. The shared gate env
# intentionally names the develop pair by default, so merely comparing a
# frozen pair to itself cannot establish that a PR campaign froze its preview.
#
# Tests: smoke-pair-identity.test.sh (unchanged, same-commit redeploy, null id,
# garbage, non-live-first, live→deactivated, non-string ids, re-start after
# drift, unwritable run dir, unwritable check log, bounded re-freeze — first
# drift ok, second drift blocked, stale generation ignored, finish refused until
# every lane is redispatched — all fail closed).
#
# Exit: 0 unchanged/frozen/re-frozen · 2 unreadable/invalid/unwritable/misconfigured, or
#       finish refused (a lane not redispatched since a re-freeze) · 3 DRIFT or a
#       PR-contract source mismatch (lane finishes BLOCKED) · 4 refused (re-start
#       after freeze, or a second re-freeze)
#
# Env: RENDER_API_KEY; SMOKE_GATE_FRONTEND_SERVICE / SMOKE_GATE_BACKEND_SERVICE (required —
#      no defaults; a missing id fails closed rather than silently identifying the wrong pair.
#      Same names smoke-develop-gate.sh reads, so one wrapper env file configures both.)
#      SMOKE_PAIR_FIXTURE_DIR (tests only: <dir>/fe.json, <dir>/be.json replace Render).
#
# RE-FREEZE, BOUNDED. `start` is no-clobber by design — an unbounded re-freeze would let
# a coordinator paper over drift by simply re-baselining every time `check` complains. But
# that same rigidity turns a single build swap mid-run into a hard BLOCKED with no recovery
# but a whole new run, which cost two blocked runs plus two evidence-recovery runs in one
# day. `refreeze` is the one sanctioned escape hatch: it is allowed exactly ONCE per run
# (a second call, or a second drift after using it, refuses — exit 4), it records the OLD
# pair plus the reason in identity.json's `history[]` so both pairs are named, not just the
# new one, and it bumps `freezeGeneration` so `finish` never lets a pre-refreeze check
# receipt (recorded against the OLD pair) stand in for a post-refreeze one.
#
# REDISPATCH AFTER RE-FREEZE. A fresher receipt is not fresher lane evidence: before this
# was enforced, one ok `check` by the coordinator at the new generation cleared `finish`
# while every lane's evidence still came from the OLD pair (issue #731, F3). `refreeze`
# therefore snapshots the completion contract's lane generations into identity.json
# (`refreezeLaneSnapshot`) — the scaffold's own `.lanes[].generation`, which only
# smoke-run-scaffold.sh `redispatch <run-dir> <lane-id>` (one lane) or `contract
# --regenerate` (every lane) moves — and `finish` refuses while any required lane is still
# at or below its snapshot generation. The rule lives in refreeze-lanes.jq and
# smoke-evidence-barrier.sh applies it too, so skipping `finish` does not skip it. This
# script still keeps no lane state of its own and never touches markers or the contract;
# the snapshot is the scaffold's field, copied at one moment. A refreeze with no contract
# yet snapshots no lanes (none was dispatched); one with markers but no contract refuses.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="${SMOKE_GATE_FRONTEND_SERVICE:-}"
BE="${SMOKE_GATE_BACKEND_SERVICE:-}"
require_services() {
  [ -n "$FE" ] && [ -n "$BE" ] && return 0
  echo "REFUSED: SMOKE_GATE_FRONTEND_SERVICE and SMOKE_GATE_BACKEND_SERVICE are required — no default pair (exit 2)" >&2
  exit 2
}
fetch() { if [ -n "${SMOKE_PAIR_FIXTURE_DIR:-}" ]; then cat "$SMOKE_PAIR_FIXTURE_DIR/$1.json"; return; fi
  curl -sS --max-time 20 -H "Authorization: Bearer ${RENDER_API_KEY:?RENDER_API_KEY required}" "https://api.render.com/v1/services/$2/deploys?limit=5"; }
read_pair() { local fe be
  fe="$(fetch fe "$FE")" || { echo '{"ok":false,"error":"frontend read failed"}'; return 2; }
  be="$(fetch be "$BE")" || { echo '{"ok":false,"error":"backend read failed"}'; return 2; }
  FE_SVC="$FE" BE_SVC="$BE" python3 - "$fe" "$be" <<'PY'
import json, sys, os, re, datetime
DEP = re.compile(r"^dep-[a-z0-9]{10,}$"); SVC = re.compile(r"^srv-[a-z0-9]{10,}$"); SHA = re.compile(r"^[0-9a-f]{40}$")
def pick(raw, svc):
    try:
        arr = json.loads(raw)
        if not isinstance(arr, list): arr = [arr]
        live = [x.get("deploy", x) for x in arr if isinstance(x, dict) and isinstance(x.get("deploy", x), dict) and x.get("deploy", x).get("status") == "live"]
        if not live: return {"service": svc, "deploy": None, "commit": None, "status": None, "error": "no LIVE deploy among the newest records"}
        d = live[0]; dep = d.get("id"); commit = (d.get("commit") or {}).get("id")
        errs = []
        if not (isinstance(svc, str) and SVC.match(svc)): errs.append("service id shape")
        if not (isinstance(dep, str) and DEP.match(dep)): errs.append("deploy id shape")
        if not (isinstance(commit, str) and SHA.match(commit)): errs.append("commit sha shape")
        out = {"service": svc, "deploy": dep if isinstance(dep, str) else None, "commit": commit if isinstance(commit, str) else None, "status": "live", "finishedAt": d.get("finishedAt")}
        if errs: out["error"] = "invalid: " + ", ".join(errs)
        return out
    except Exception as e:
        return {"service": svc, "deploy": None, "commit": None, "status": None, "error": f"unparsable: {e}"}
fe = pick(sys.argv[1], os.environ["FE_SVC"]); be = pick(sys.argv[2], os.environ["BE_SVC"])
ok = all(not o.get("error") for o in (fe, be))
pair = {"frontend": fe, "backend": be, "readAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": ok}
if not ok: pair["error"] = "; ".join(f"{s}: {o['error']}" for s, o in (("frontend", fe), ("backend", be)) if o.get("error"))
print(json.dumps(pair, separators=(",", ":"))); sys.exit(0 if ok else 2)
PY
}

# A PR campaign's contract is the only source-of-truth that says which build
# this pair must serve. Develop/task campaigns may intentionally have frontend
# and backend at different commits, so preserve their existing pair-only
# behaviour. A valid PR contract with a missing/malformed sourceSha refuses;
# a wholly unreadable legacy contract is left for the existing contract
# consumers to reject, while a prior PR freeze keeps its stored expectation.
pr_contract_source_sha() { # <run-dir> → sourceSha on stdout, empty if not PR-owned
  local run="$1" contract payload error kind source
  contract="$run/completion-contract.json"
  [ -e "$contract" ] || return 0
  payload="$(jq -cs '
    if length != 1 then {error:"completion contract must contain exactly one JSON document"}
    elif (.[0] | type) != "object" then {error:"completion contract must be an object"}
    else .[0]
    end
  ' "$contract" 2>/dev/null)" || {
    return 0
  }
  error="$(jq -r '.error // empty' <<<"$payload" 2>/dev/null)"
  if [ -n "$error" ]; then
    return 0
  fi
  kind="$(jq -r '.ownershipKind // empty' <<<"$payload" 2>/dev/null)"
  [ "$kind" = "pr" ] || return 0
  source="$(jq -r '.sourceSha // empty' <<<"$payload" 2>/dev/null)"
  if ! printf '%s' "$source" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "REFUSED: PR completion contract at $contract has no valid 40-character sourceSha (exit 2)" >&2
    return 2
  fi
  printf '%s\n' "$source"
}

stored_expected_source_sha() { # <identity.json> → validated sourceSha or empty
  local source
  source="$(jq -r '.expectedSourceSha // empty' "$1" 2>/dev/null)"
  printf '%s' "$source" | grep -Eq '^[0-9a-f]{40}$' || return 0
  printf '%s\n' "$source"
}

pair_matches_source_sha() { # <pair-json> <source-sha>
  jq -e --arg sha "$2" '
    .frontend.commit == $sha and .backend.commit == $sha
  ' <<<"$1" >/dev/null 2>&1
}

compare() { # $1 frozen file, $2 now json, $3 label, $4 rc-of-read, $5 log, $6 freeze-generation, $7 expected-source-sha → prints verdict, exit 0/2/3
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'PY'
import json, sys, os
try: frozen = json.load(open(sys.argv[1]))
except Exception as e: print(f"{sys.argv[3]}: unreadable — identity.json: {e}"); sys.exit(2)
now = json.loads(sys.argv[2]); label = sys.argv[3]; rc = int(sys.argv[4]); log = sys.argv[5]; expected = sys.argv[7]
try: generation = int(sys.argv[6])
except Exception: generation = 1
def key(o, s): return (o.get(s, {}).get("service"), o.get(s, {}).get("deploy"), o.get(s, {}).get("commit"))
def serves_expected(pair): return not expected or all(pair.get(s, {}).get("commit") == expected for s in ("frontend", "backend"))
if not frozen.get("ok"): verdict = "unreadable"
elif not serves_expected(frozen): verdict = "source-mismatch"
elif rc != 0: verdict = "unreadable"
elif not serves_expected(now): verdict = "source-mismatch"
else: verdict = "drift" if any(key(frozen, s) != key(now, s) for s in ("frontend", "backend")) else "ok"
rec = {"label": label, "verdict": verdict, "freezeGeneration": generation,
       "frozen": {s: frozen.get(s) for s in ("frontend", "backend")},
       "now": {s: now.get(s) for s in ("frontend", "backend")}, "readAt": now.get("readAt"),
       "expectedSourceSha": expected or None}
try:
    with open(log, "a") as f: f.write(json.dumps(rec, separators=(",", ":")) + "\n"); f.flush(); os.fsync(f.fileno())
except Exception as e: print(f"{label}: unreadable — check log not writable: {e}"); sys.exit(2)
detail = "" if verdict == "ok" else " — " + json.dumps(rec["now"])
if expected: detail += " expectedSourceSha=" + expected
print(f"{label}: {verdict}" + detail)
sys.exit({"ok": 0, "drift": 3, "source-mismatch": 3, "unreadable": 2}[verdict])
PY
}
case "${1:-}" in
  read) require_services; read_pair; exit $? ;;
  start)
    require_services
    RUN="${2:?run dir}"; F="$RUN/coordinator/identity.json"
    [ -e "$F" ] && { echo "REFUSED: $F already exists — identity is frozen once; use check/refreeze/finish (exit 4)" >&2; exit 4; }
    mkdir -p "$RUN/coordinator" 2>/dev/null || { echo "REFUSED: cannot create $RUN/coordinator (exit 2)" >&2; exit 2; }
    CONTRACT_SOURCE_SHA="$(pr_contract_source_sha "$RUN")" || exit 2
    EXPECTED_SOURCE_SHA="$CONTRACT_SOURCE_SHA"
    P="$(read_pair)"; rc=$?
    [ $rc -eq 0 ] || { echo "REFUSED: identity unreadable/invalid — nothing frozen: $P" >&2; exit 2; }
    if [ -n "$EXPECTED_SOURCE_SHA" ] && ! pair_matches_source_sha "$P" "$EXPECTED_SOURCE_SHA"; then
      echo "REFUSED: live pair does not serve PR contract sourceSha $EXPECTED_SOURCE_SHA — nothing frozen (exit 2): $P" >&2
      exit 2
    fi
    # LATE FREEZE (XZO #2092). A freeze binds evidence gathered AFTER it; it
    # proves nothing about a lane that already ran, which gathered its evidence
    # against a pair nobody froze and possibly a different deploy. Without this,
    # `start` after the lanes plus one ok `check` cleared every gate and those
    # unbound markers supported GO. So a `start` that finds lane evidence on
    # disk records itself as late and snapshots the contract's lane generations
    # exactly as `refreeze` does (rl_lane_snapshot); rl_refrozen then treats
    # the run as re-frozen, and `finish` and smoke-evidence-barrier.sh refuse
    # every lane until it is redispatched above that snapshot. INVARIANT: a
    # counted marker comes from a dispatch made after the pair it is checked
    # against was frozen. The snapshot covers every required lane, marker or
    # not: a lane still in flight at the freeze started on an unfrozen pair
    # too. The one shape this cannot see is a late freeze while lanes run and
    # NO marker has landed yet -- nothing on disk records a dispatch -- which is
    # why the controller's lanes brief puts `start` before any dispatch
    # (smoke-campaign-controller.py:865-866, OWNER_BRIEF["lanes"], which opens
    # "STEP 1, BEFORE ANY LANE IS DISPATCHED"). Editing that brief's ordering
    # reopens the race this comment names.
    C="$RUN/completion-contract.json"
    LATE='{}'
    MARKED=""
    for m in "$RUN"/markers/*.json; do [ -s "$m" ] && MARKED="$MARKED ${m#"$RUN"/}"; done
    CJSON=null
    if [ -e "$C" ]; then
      CJSON="$(jq -cs 'if length == 1 then .[0] else "unparsable" end' "$C" 2>/dev/null)" || CJSON='"unparsable"'
      while IFS= read -r m; do
        case "$m" in ''|/*|*..*) continue ;; esac
        [ -s "$RUN/$m" ] && case " $MARKED " in *" $m "*) ;; *) MARKED="$MARKED $m" ;; esac
      done < <(jq -r 'if type == "object" then (.requiredLaneMarkers // [])[]? | strings else empty end' <<<"$CJSON" 2>/dev/null)
    fi
    MARKED="${MARKED# }"
    if [ -n "$MARKED" ]; then
      [ "$CJSON" != null ] || {
        echo "REFUSED: lane markers exist under $RUN but there is no completion contract — cannot tell which lanes must be redispatched after this late freeze; nothing frozen (exit 2)" >&2; exit 2; }
      SNAP="$(jq -cn -L "$HERE" --argjson c "$CJSON" 'include "refreeze-lanes"; $c | rl_lane_snapshot')" || {
        echo "REFUSED: could not snapshot the contract's lane generations for a late freeze — nothing frozen (exit 2)" >&2; exit 2; }
      SNAP_ERR="$(jq -r '.error // empty' <<<"$SNAP")"
      [ -z "$SNAP_ERR" ] || { echo "REFUSED: $SNAP_ERR — cannot snapshot lane generations for a late freeze; nothing frozen (exit 2)" >&2; exit 2; }
      LATE="$(jq -cn --argjson snap "$SNAP" --arg at "$(date -u +%FT%TZ)" --arg marked "$MARKED" \
        '{lateFreeze: {frozenAt: $at, markersOnDisk: ($marked | split(" ") | map(select(length > 0)))},
          refreezeLaneSnapshot: $snap}')" || {
        echo "REFUSED: could not record the late freeze (exit 2)" >&2; exit 2; }
      echo "LATE FREEZE: lane evidence already exists ($MARKED); every required lane must be redispatched (smoke-run-scaffold.sh redispatch $RUN <lane-id>) and re-run before it counts" >&2
    fi
    PAYLOAD="$(printf '%s' "$P" | jq -c --arg expected "$EXPECTED_SOURCE_SHA" --argjson late "$LATE" '
      . + {freezeGeneration: 1, history: []} +
      (if $expected == "" then {} else {expectedSourceSha: $expected} end) + $late
    ')" || {
      echo "REFUSED: could not attach freeze bookkeeping to the live pair (exit 2)" >&2; exit 2; }
    python3 - "$RUN/coordinator" "$PAYLOAD" <<'PY'
import json, os, sys, tempfile
d, payload = sys.argv[1], sys.argv[2]; final = os.path.join(d, "identity.json")
try:
    fd, tmp = tempfile.mkstemp(prefix=".identity.", dir=d)
    with os.fdopen(fd, "w") as f:
        f.write(payload + "\n"); f.flush(); os.fsync(f.fileno())
    # read back and compare BEFORE installing: a short/partial write must never become the baseline
    back = open(tmp).read()
    if back != payload + "\n" or json.loads(back) != json.loads(payload) or not json.loads(back).get("ok"):
        os.unlink(tmp); print("REFUSED: baseline read-back mismatch/partial write; nothing installed (exit 2)", file=sys.stderr); sys.exit(2)
    os.link(tmp, final)   # atomic no-clobber install
    os.unlink(tmp)
    dfd = os.open(d, os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    installed = open(final).read()
    if installed != payload + "\n": print("REFUSED: installed baseline differs from frozen pair (exit 2)", file=sys.stderr); sys.exit(2)
except FileExistsError:
    try: os.unlink(tmp)
    except Exception: pass
    print("REFUSED: identity.json appeared concurrently; not overwritten (exit 4)", file=sys.stderr); sys.exit(4)
except Exception as e:
    try: os.unlink(tmp)
    except Exception: pass
    print(f"REFUSED: could not durably install baseline: {e} (exit 2)", file=sys.stderr); sys.exit(2)
print("identity frozen: " + payload)
PY
    exit $? ;;
  refreeze)
    require_services
    RUN="${2:?run dir}"; REASON="${3:-}"; F="$RUN/coordinator/identity.json"
    [ -n "$REASON" ] || { echo "REFUSED: refreeze requires a reason (exit 2)" >&2; exit 2; }
    [ -s "$F" ] || { echo "REFUSED: no identity.json in $RUN — run start first (exit 2)" >&2; exit 2; }
    OLD="$(cat "$F")"
    python3 -c 'import json,sys; json.loads(sys.argv[1])' "$OLD" >/dev/null 2>&1 || {
      echo "REFUSED: identity.json is not valid JSON — cannot re-freeze over it (exit 2)" >&2; exit 2; }
    HIST_LEN="$(jq -r '(.history // []) | length' <<<"$OLD" 2>/dev/null || echo x)"
    printf '%s' "$HIST_LEN" | grep -Eq '^[0-9]+$' || HIST_LEN=0
    if [ "$HIST_LEN" -ge 1 ]; then
      echo "REFUSED: this run already re-froze identity once — a second drift is BLOCKED, not re-frozen again (exit 4)" >&2
      exit 4
    fi
    OLD_GEN="$(jq -r '(.freezeGeneration // 1)' <<<"$OLD" 2>/dev/null || echo 1)"
    printf '%s' "$OLD_GEN" | grep -Eq '^[0-9]+$' || OLD_GEN=1
    NEW_GEN=$(( OLD_GEN + 1 ))
    # Snapshot the contract's lane generations (header, REDISPATCH AFTER RE-FREEZE). A
    # contract that exists but cannot be read refuses: that is when this script knows least
    # about which lanes ran on the old pair. No contract but markers on disk refuses too —
    # the scaffold writes a marker only under a contract, so the contract was removed.
    C="$RUN/completion-contract.json"
    if [ -e "$C" ]; then
      CJSON="$(jq -cs 'if length == 1 then .[0] else "unparsable" end' "$C" 2>/dev/null)" || CJSON='"unparsable"'
    else
      for m in "$RUN"/markers/*.json; do
        [ -e "$m" ] && { echo "REFUSED: lane markers exist under $RUN/markers but there is no completion contract — cannot tell which lanes must be redispatched; nothing re-frozen (exit 2)" >&2; exit 2; }
      done
      CJSON=null
    fi
    SNAP="$(jq -cn -L "$HERE" --argjson c "$CJSON" 'include "refreeze-lanes"; $c | rl_lane_snapshot')" || {
      echo "REFUSED: could not snapshot the contract's lane generations — nothing re-frozen (exit 2)" >&2; exit 2; }
    SNAP_ERR="$(jq -r '.error // empty' <<<"$SNAP")"
    [ -z "$SNAP_ERR" ] || { echo "REFUSED: $SNAP_ERR — cannot snapshot lane generations; nothing re-frozen (exit 2)" >&2; exit 2; }
    CONTRACT_SOURCE_SHA="$(pr_contract_source_sha "$RUN")" || exit 2
    EXPECTED_SOURCE_SHA="$CONTRACT_SOURCE_SHA"
    [ -n "$EXPECTED_SOURCE_SHA" ] || EXPECTED_SOURCE_SHA="$(stored_expected_source_sha "$F")"
    P="$(read_pair)"; rc=$?
    [ $rc -eq 0 ] || { echo "REFUSED: live identity unreadable/invalid — nothing re-frozen: $P" >&2; exit 2; }
    if [ -n "$EXPECTED_SOURCE_SHA" ] && ! pair_matches_source_sha "$P" "$EXPECTED_SOURCE_SHA"; then
      echo "REFUSED: live pair does not serve PR contract sourceSha $EXPECTED_SOURCE_SHA — nothing re-frozen (exit 2): $P" >&2
      exit 2
    fi
    NOW_ISO="$(date -u +%FT%TZ)"
    PAYLOAD="$(jq -c \
      --argjson old "$OLD" --arg reason "$REASON" --arg at "$NOW_ISO" --argjson gen "$NEW_GEN" \
      --argjson snap "$SNAP" --arg expected "$EXPECTED_SOURCE_SHA" \
      '. + {freezeGeneration: $gen, refreezeLaneSnapshot: $snap,
            history: (($old.history // []) + [{
              frontend: $old.frontend, backend: $old.backend, readAt: $old.readAt,
              reason: $reason, refrozenAt: $at}])}
       # The re-frozen record is a frozen pair like any other: it keeps the
       # source binding `start` wrote, or the barrier refuses it as not a
       # frozen pair (smoke-evidence-barrier.sh, shape check) on every fire.
       + (if $expected == "" then {} else {expectedSourceSha: $expected} end)' <<<"$P")" || {
      echo "REFUSED: could not build the re-frozen payload (exit 2)" >&2; exit 2; }
    python3 - "$RUN/coordinator" "$PAYLOAD" <<'PY'
import json, os, sys, tempfile
d, payload = sys.argv[1], sys.argv[2]; final = os.path.join(d, "identity.json")
try:
    fd, tmp = tempfile.mkstemp(prefix=".identity.", dir=d)
    with os.fdopen(fd, "w") as f:
        f.write(payload + "\n"); f.flush(); os.fsync(f.fileno())
    back = open(tmp).read()
    if back != payload + "\n" or json.loads(back) != json.loads(payload) or not json.loads(back).get("ok"):
        os.unlink(tmp); print("REFUSED: re-freeze read-back mismatch/partial write; nothing installed (exit 2)", file=sys.stderr); sys.exit(2)
    os.replace(tmp, final)   # deliberate overwrite: refreeze is the one sanctioned re-baseline
    dfd = os.open(d, os.O_RDONLY); os.fsync(dfd); os.close(dfd)
    installed = open(final).read()
    if installed != payload + "\n": print("REFUSED: installed baseline differs from re-frozen pair (exit 2)", file=sys.stderr); sys.exit(2)
except Exception as e:
    try: os.unlink(tmp)
    except Exception: pass
    print(f"REFUSED: could not durably install re-frozen baseline: {e} (exit 2)", file=sys.stderr); sys.exit(2)
print("identity re-frozen: " + payload)
PY
    exit $? ;;
  check|finish)
    require_services
    RUN="${2:?run dir}"; LABEL="${3:-$1}"; F="$RUN/coordinator/identity.json"; LOG="$RUN/coordinator/identity-checks.ndjson"
    [ -s "$F" ] || { echo "$LABEL: unreadable — no identity.json in $RUN (run start first) (exit 2)"; exit 2; }
    CONTRACT_SOURCE_SHA="$(pr_contract_source_sha "$RUN")" || exit 2
    EXPECTED_SOURCE_SHA="$CONTRACT_SOURCE_SHA"
    [ -n "$EXPECTED_SOURCE_SHA" ] || EXPECTED_SOURCE_SHA="$(stored_expected_source_sha "$F")"
    CUR_GEN="$(jq -r '(.freezeGeneration // 1)' "$F" 2>/dev/null || echo 1)"
    printf '%s' "$CUR_GEN" | grep -Eq '^[0-9]+$' || CUR_GEN=1
    if [ "$1" = finish ]; then
      # Redispatch after re-freeze (header). Checked first, because it names the remedy the
      # journal checks below cannot see. With no re-freeze this reads nothing but
      # identity.json, so a run that never re-froze behaves exactly as before.
      REFROZEN="$(jq -rs -L "$HERE" 'include "refreeze-lanes"; if length == 1 then (.[0] | rl_refrozen) else error("not one JSON document") end' "$F" 2>/dev/null)"
      case "$REFROZEN" in
        false) ;;
        true)
          C="$RUN/completion-contract.json"
          if [ -e "$C" ]; then
            CJSON="$(jq -cs 'if length == 1 then .[0] else "unparsable" end' "$C" 2>/dev/null)" || CJSON='"unparsable"'
          else CJSON=null; fi
          RES="$(jq -cs -L "$HERE" --argjson c "$CJSON" 'include "refreeze-lanes"; .[0] | rl_stale_after_refreeze($c)' "$F" 2>/dev/null)" || {
            echo "finish: unreadable — could not evaluate the re-freeze lane snapshot (exit 2)"; exit 2; }
          ERR="$(jq -r '.error // empty' <<<"$RES")"
          [ -z "$ERR" ] || { echo "finish: unreadable — $ERR (exit 2)"; exit 2; }
          STALE="$(jq -r '.stale | join(", ")' <<<"$RES")"
          SINCE="since the pair re-freeze: $STALE; their evidence predates the current pair"
          [ "$(jq -r '((.history // []) | length) == 0 and has("lateFreeze")' "$F" 2>/dev/null)" = true ] &&
            SINCE="since the pair was frozen late: $STALE; they ran before any pair was frozen, so their evidence is bound to no build"
          [ -z "$STALE" ] || {
            echo "finish: refused — required lanes not redispatched $SINCE. Run smoke-run-scaffold.sh redispatch <run-dir> <lane-id> for each, re-run it, then finish again (exit 2)"
            exit 2; }
          ;;
        *) echo "finish: unreadable — identity.json is not valid JSON (exit 2)"; exit 2 ;;
      esac
      python3 - "$LOG" "$CUR_GEN" <<'PY' || exit $?
import json, sys
try: lines = [l for l in open(sys.argv[1]).read().splitlines() if l.strip()]
except Exception as e: print(f"finish: unreadable — journal missing/unreadable: {e} (exit 2)"); sys.exit(2)
if not lines: print("finish: unreadable — no identity checks recorded before publication (exit 2)"); sys.exit(2)
cur_gen = int(sys.argv[2])
current = []
for i, l in enumerate(lines, 1):
    try: rec = json.loads(l)
    except Exception: print(f"finish: unreadable — journal line {i} is not JSON (exit 2)"); sys.exit(2)
    # A record from a PRIOR freeze generation is a receipt against a pair this run
    # already re-froze away from — informational history, not a live violation.
    # Only records at the identity file's CURRENT generation can block or clear finish.
    if int(rec.get("freezeGeneration", 1) or 1) == cur_gen:
        current.append(rec)
if not current:
    print(f"finish: unreadable — no identity checks recorded at the current freeze generation ({cur_gen}); after a refreeze, redispatched lanes must post fresh checks before publication (exit 2)")
    sys.exit(2)
verdicts = [rec.get("verdict") for rec in current]
if "drift" in verdicts: print("finish: drift — a check already recorded drift at the current freeze generation; verdict must be BLOCKED (exit 3)"); sys.exit(3)
if "source-mismatch" in verdicts: print("finish: source mismatch — a check recorded a pair that does not serve the PR contract sourceSha at the current freeze generation; verdict must be BLOCKED (exit 3)"); sys.exit(3)
bad = [v for v in verdicts if v != "ok"]
# What is checked: at least one check exists at the current generation and every check
# there is ok. Check labels are free-form, so this cannot tell which lane posted which.
if bad: print(f"finish: unreadable — non-ok identity checks {bad} at the current freeze generation; finish requires every check recorded at this generation to be ok (exit 2)"); sys.exit(2)
PY
      LABEL="finish-prepublication"
    fi
    NOW="$(read_pair)"; rc=$?; compare "$F" "$NOW" "$LABEL" "$rc" "$LOG" "$CUR_GEN" "$EXPECTED_SOURCE_SHA"; exit $? ;;
  *) sed -n 2,24p "$0"; exit 1 ;;
esac
