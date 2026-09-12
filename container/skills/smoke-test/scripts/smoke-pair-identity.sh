#!/usr/bin/env bash
# smoke-pair-identity.sh — frozen-pair identity for QA runs.
# Identity = the LIVE serving Render deploy (service id, deploy id, commit) of BOTH
# frontend and backend services for a run. Not a bundle host, not a health check,
# not the shared worktree HEAD. Fails closed on everything.
#
#   start    <run-dir>          freeze once → <run-dir>/coordinator/identity.json (no-clobber: exit 4 if it exists)
#   check    <run-dir> <label>  re-read live pair, append coordinator/identity-checks.ndjson
#   refreeze <run-dir> <reason> bounded re-freeze after drift: exactly ONCE per run (see below)
#   finish   <run-dir>          coordinator pre-publication check: identity.json present, ≥1 prior
#                                check at the CURRENT freeze generation, live pair unchanged
#   read                        print the current live pair as JSON
#
# Tests: smoke-pair-identity.test.sh (unchanged, same-commit redeploy, null id,
# garbage, non-live-first, live→deactivated, non-string ids, re-start after
# drift, unwritable run dir, unwritable check log, bounded re-freeze — first
# drift ok, second drift blocked, stale generation ignored — all fail closed).
#
# Exit: 0 unchanged/frozen/re-frozen · 2 unreadable/invalid/unwritable/misconfigured ·
#       3 DRIFT (lane finishes BLOCKED) · 4 refused (re-start after freeze, or a second re-freeze)
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
# receipt (recorded against the OLD pair) stand in for a post-refreeze one. It does NOT
# touch lane markers — after a refreeze, the coordinator redispatches every lane whose
# evidence predates the new pair through smoke-run-scaffold.sh's own `redispatch <run-dir>
# <lane-id>` (see SKILL.md), the same generation mechanism the barrier already uses for a
# re-run lane. This script has no notion of a lane and must not grow a second, parallel
# staleness mechanism for one.
set -uo pipefail
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
compare() { # $1 frozen file, $2 now json, $3 label, $4 rc-of-read, $5 log, $6 freeze-generation → prints verdict, exit 0/2/3
  python3 - "$1" "$2" "$3" "$4" "$5" "$6" <<'PY'
import json, sys, os
try: frozen = json.load(open(sys.argv[1]))
except Exception as e: print(f"{sys.argv[3]}: unreadable — identity.json: {e}"); sys.exit(2)
now = json.loads(sys.argv[2]); label = sys.argv[3]; rc = int(sys.argv[4]); log = sys.argv[5]
try: generation = int(sys.argv[6])
except Exception: generation = 1
def key(o, s): return (o.get(s, {}).get("service"), o.get(s, {}).get("deploy"), o.get(s, {}).get("commit"))
if not frozen.get("ok"): verdict = "unreadable"
elif rc != 0: verdict = "unreadable"
else: verdict = "drift" if any(key(frozen, s) != key(now, s) for s in ("frontend", "backend")) else "ok"
rec = {"label": label, "verdict": verdict, "freezeGeneration": generation,
       "frozen": {s: frozen.get(s) for s in ("frontend", "backend")},
       "now": {s: now.get(s) for s in ("frontend", "backend")}, "readAt": now.get("readAt")}
try:
    with open(log, "a") as f: f.write(json.dumps(rec, separators=(",", ":")) + "\n"); f.flush(); os.fsync(f.fileno())
except Exception as e: print(f"{label}: unreadable — check log not writable: {e}"); sys.exit(2)
print(f"{label}: {verdict}" + ("" if verdict == "ok" else " — " + json.dumps(rec["now"])))
sys.exit({"ok": 0, "drift": 3, "unreadable": 2}[verdict])
PY
}
case "${1:-}" in
  read) require_services; read_pair; exit $? ;;
  start)
    require_services
    RUN="${2:?run dir}"; F="$RUN/coordinator/identity.json"
    [ -e "$F" ] && { echo "REFUSED: $F already exists — identity is frozen once; use check/refreeze/finish (exit 4)" >&2; exit 4; }
    mkdir -p "$RUN/coordinator" 2>/dev/null || { echo "REFUSED: cannot create $RUN/coordinator (exit 2)" >&2; exit 2; }
    P="$(read_pair)"; rc=$?
    [ $rc -eq 0 ] || { echo "REFUSED: identity unreadable/invalid — nothing frozen: $P" >&2; exit 2; }
    PAYLOAD="$(printf '%s' "$P" | jq -c '. + {freezeGeneration: 1, history: []}')" || {
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
    P="$(read_pair)"; rc=$?
    [ $rc -eq 0 ] || { echo "REFUSED: live identity unreadable/invalid — nothing re-frozen: $P" >&2; exit 2; }
    NOW_ISO="$(date -u +%FT%TZ)"
    PAYLOAD="$(jq -c \
      --argjson old "$OLD" --arg reason "$REASON" --arg at "$NOW_ISO" --argjson gen "$NEW_GEN" \
      '. + {freezeGeneration: $gen,
            history: (($old.history // []) + [{
              frontend: $old.frontend, backend: $old.backend, readAt: $old.readAt,
              reason: $reason, refrozenAt: $at}])}' <<<"$P")" || {
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
    CUR_GEN="$(jq -r '(.freezeGeneration // 1)' "$F" 2>/dev/null || echo 1)"
    printf '%s' "$CUR_GEN" | grep -Eq '^[0-9]+$' || CUR_GEN=1
    if [ "$1" = finish ]; then
      python3 - "$LOG" "$CUR_GEN" <<'PY' || exit $?
import json, sys
try: lines = [l for l in open(sys.argv[1]).read().splitlines() if l.strip()]
except Exception as e: print(f"finish: unreadable — journal missing/unreadable: {e} (exit 2)"); sys.exit(2)
if not lines: print("finish: unreadable — no lane checks recorded before publication (exit 2)"); sys.exit(2)
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
    print(f"finish: unreadable — no lane checks recorded at the current freeze generation ({cur_gen}); a redispatch after refreeze must post fresh checks before publication (exit 2)")
    sys.exit(2)
verdicts = [rec.get("verdict") for rec in current]
if "drift" in verdicts: print("finish: drift — a lane already recorded drift at the current freeze generation; verdict must be BLOCKED (exit 3)"); sys.exit(3)
bad = [v for v in verdicts if v != "ok"]
if bad: print(f"finish: unreadable — journal contains non-ok lane checks {bad} at the current freeze generation; every lane must have a clean identity receipt (exit 2)"); sys.exit(2)
PY
      LABEL="finish-prepublication"
    fi
    NOW="$(read_pair)"; rc=$?; compare "$F" "$NOW" "$LABEL" "$rc" "$LOG" "$CUR_GEN"; exit $? ;;
  *) sed -n 2,24p "$0"; exit 1 ;;
esac
