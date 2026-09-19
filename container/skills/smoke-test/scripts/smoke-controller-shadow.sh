#!/usr/bin/env bash
# Task-script wrapper: one fire of the PR smoke-campaign controller in SHADOW.
#
#   ncl tasks create ... --recurrence '*/10 * * * *' \
#     --script 'bash /app/skills/smoke-test/scripts/smoke-controller-shadow.sh'
#
# It runs next to the legacy coordinator and changes nothing it does. Each fire:
#   1. sources the gate env (SMOKE_CONTROLLER_ENV_FILE, default
#      /workspace/agent/smoke-gate-env.sh); SMOKE_CONTROLLER_MODE there is the
#      kill switch (unset or `off` = do nothing; `shadow` = run);
#   2. `init`s the controller journal ONCE per out-dir. The controller keeps one
#      journal for every run (smoke-campaign-controller.py:264-353) and `init`
#      refuses an existing one (:325-330). A sentinel records that init
#      happened, so a journal lost later is never re-created as empty -- the
#      controller's `step` hard-errors on it instead (:302-303);
#   3. reads the gate's state files directly. `poll` is NOT side-effect-free:
#      it claims the slot and writes pr-<n>-state.json before it wakes anyone
#      (smoke-pr-gate.sh:5351-5361 via write_pr_state, :1380-1388). The state
#      files are replaced by tmp+rename (:1382-1384), so a read never sees a
#      half-written file;
#   4. fetches the current head of every PR the controller has in play with
#      `gh pr view` (read-only), and `ncl tasks list --json` ONLY when the
#      journal holds a bare dispatch intent -- the one path that reads tasks
#      (smoke-campaign-controller.py:856-862);
#   5. runs `step --shadow` once. That one step covers every active run
#      (fire_once, smoke-campaign-controller.py:1235-1245).
#
# Receipts are passed as `{}` on purpose. They are chat DELIVERY receipts keyed
# key#attempt (smoke-campaign-controller.py:731-742), consulted only for an
# `enqueued` send, and shadow never enqueues: a refused send is journaled
# `done` at once (:774-778). There is no GitHub receipt input.
#
# Counterfactual hold (the replay's model, smoke-campaign-replay.py:425-428):
# once the legacy coordinator finishes a run the shadow is tracking, the
# controller would see verdict.json and stop (step_run, :958-963) -- before it
# ever posts the verdict, comments on the PR or finishes, so none of the pass
# bars could be measured. The controller therefore reads a GATE VIEW rebuilt
# under the out-dir each fire: a copy of the real state in which a run the
# shadow journal still has open, and that the real gate finished less than
# SMOKE_CONTROLLER_SHADOW_HOLD_SECONDS (default 7200, the replay's horizon)
# ago, still looks active and its verdict files are withheld. After the hold
# the view shows the real outcome and the controller records the run finished
# by the gate (a missed `finish` in the report).
#
# New claims: the controller would run right after the gate's `poll`, which
# hands it the claiming wake. The shadow never sees that wake, so it rebuilds
# one from the state file for (at most) one not-yet-journaled active claim per
# fire -- the gate emits at most one wake per poll (smoke-pr-gate.sh:12-14) --
# marked `shadowSynthesized`. Any other unjournaled claim is recovered by the
# controller as `controller_orphan_claim`.
#
# Guarantees:
#   - The LAST stdout line is always {"wakeAgent":false,"data":{...}} and
#     wakeAgent is a literal. stdout is moved to fd 3 on the first line and
#     everything else writes to stderr, so no child can print the line the
#     task runner parses (agent-runner scheduling/task-script.ts:163-176).
#   - Exit status is 0 whatever happens. An input that cannot be read, a gh or
#     ncl call that fails or times out, or a budget too small for the step
#     each skip the step: a decision-less fire, logged with its reason.
#   - Everything finishes inside SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS
#     (default 100, under the runner's 120 s, task-script.ts:18-21): every
#     child has a timeout cut to the time left, and a backstop `timeout` kills
#     the whole fire.
#   - Writes stay under the out-dir: the controller's journal, lock and
#     decisions (its own containment, smoke-campaign-controller.py:202-257),
#     and this wrapper's `wrapper/` dir (view, inputs, fire log, temp files,
#     gh's XDG cache/state). TMPDIR and XDG_* point there, and bytecode writes
#     are off. The one write this wrapper cannot keep under the out-dir is
#     ncl's own transport: `ncl` sends its request as a system row in this
#     session's outbound.db (agent-runner cli/ncl.ts:52-65), and the reply is
#     written with trigger=0, which never wakes the agent
#     (src/cli/delivery-action.ts:78). That is why ncl runs only when needed.
set -uo pipefail
exec 3>&1 1>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_EPOCH="$(date +%s)"

final() { # <data-json> -- the only write to the runner's stdout
  local data="${1:-}"
  if ! jq -e 'type == "object"' <<<"$data" >/dev/null 2>&1; then
    data="$(jq -cn --arg e "fire summary missing or not JSON" '{error:$e}' 2>/dev/null)" || data='{}'
  fi
  jq -cn --argjson d "$data" '{wakeAgent:false,data:$d}' >&3 2>/dev/null ||
    printf '%s\n' '{"wakeAgent":false,"data":{"error":"final line could not be rendered"}}' >&3
  exit 0
}

ENV_FILE="${SMOKE_CONTROLLER_ENV_FILE:-/workspace/agent/smoke-gate-env.sh}"
if [ -e "$ENV_FILE" ]; then
  # Try it in a subshell first: under its own `set -u` an unbound variable
  # would abort this shell before final() could run.
  if ! ( . "$ENV_FILE" ) >/dev/null 2>&1; then
    final "$(jq -cn --arg f "$ENV_FILE" '{mode:null,skipped:"env file failed to source",envFile:$f}')"
  fi
  . "$ENV_FILE" >/dev/null 2>&1
fi

MODE="${SMOKE_CONTROLLER_MODE:-off}"
case "$MODE" in
  off) final '{"mode":"off","stepped":false}' ;;
  shadow) ;;
  *) final "$(jq -cn --arg m "$MODE" '{mode:$m,stepped:false,skipped:"unsupported SMOKE_CONTROLLER_MODE (off|shadow only)"}')" ;;
esac

BUDGET="${SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS:-100}"
case "$BUDGET" in ''|*[!0-9]*) BUDGET=100 ;; esac
REMAIN=$(( BUDGET - ($(date +%s) - START_EPOCH) ))
if [ "$REMAIN" -lt 5 ]; then
  final '{"mode":"shadow","stepped":false,"skipped":"budget exhausted before start"}'
fi

# Out-dir: explicit, else a sibling of the run root (the shared workgroup dir).
if [ -z "${SMOKE_CONTROLLER_SHADOW_DIR:-}" ]; then
  if [ -z "${SMOKE_GATE_RUN_ROOT:-}" ]; then
    final '{"mode":"shadow","stepped":false,"skipped":"no out-dir: set SMOKE_CONTROLLER_SHADOW_DIR or SMOKE_GATE_RUN_ROOT"}'
  fi
  SMOKE_CONTROLLER_SHADOW_DIR="$(dirname "${SMOKE_GATE_RUN_ROOT%/}")/controller-shadow"
fi
export SMOKE_CONTROLLER_SHADOW_DIR

export SMOKE_CONTROLLER_SHADOW_START="$START_EPOCH"
export SMOKE_CONTROLLER_SHADOW_DEADLINE=$(( START_EPOCH + BUDGET ))
export SMOKE_CONTROLLER_SCRIPT_DIR="$SCRIPT_DIR"
export PYTHONDONTWRITEBYTECODE=1

# The backstop: python keeps its own deadline; this only fires if it hangs.
DATA="$(timeout -k 2 "$REMAIN" python3 - <<'PY'
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

DEADLINE = float(os.environ["SMOKE_CONTROLLER_SHADOW_DEADLINE"])
START = float(os.environ["SMOKE_CONTROLLER_SHADOW_START"])
SCRIPT_DIR = os.environ["SMOKE_CONTROLLER_SCRIPT_DIR"]
CTL = os.path.join(SCRIPT_DIR, "smoke-campaign-controller.py")
OUT = os.environ["SMOKE_CONTROLLER_SHADOW_DIR"]
STATE_DIR = os.environ.get("SMOKE_GATE_STATE_DIR", "")
RUN_ROOT = os.environ.get("SMOKE_GATE_RUN_ROOT", "")
REPO = os.environ.get("SMOKE_GATE_REPO", "")


def env_int(name, default):
    raw = os.environ.get(name, "")
    return int(raw) if raw.isdigit() else default


HOLD_SECONDS = env_int("SMOKE_CONTROLLER_SHADOW_HOLD_SECONDS", 7200)
GH_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_GH_TIMEOUT", 10)
NCL_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_NCL_TIMEOUT", 35)
STEP_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_STEP_TIMEOUT", 60)
STEP_MIN = env_int("SMOKE_CONTROLLER_SHADOW_STEP_MIN_SECONDS", 10)
MARGIN = 3
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
STATE_RE = re.compile(r"^pr-(\d+)-state\.json$")

now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
FIRE = now.strftime("%Y-%m-%dT%H:%M:%SZ")
summary = {"mode": "shadow", "fire": FIRE, "stepped": False}
log_lines = []


def log(msg):
    log_lines.append(msg)
    print("smoke-controller-shadow: " + msg, file=sys.stderr)


def remaining():
    return DEADLINE - time.time()


def parse_iso(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None


def read_json(path):
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8")), None
    except FileNotFoundError:
        return None, "missing"
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        return None, "unreadable: {}".format(exc)


def under(path, root):
    real, real_root = os.path.realpath(path), os.path.realpath(root)
    return real == real_root or real.startswith(real_root + os.sep)


def run(argv, timeout, env=None):
    """(rc, stdout) with a hard timeout; rc None = timed out / not runnable."""
    budget = min(timeout, remaining() - MARGIN)
    if budget < 1:
        return None, "", "no budget left"
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    except OSError as exc:
        return None, "", str(exc)
    try:
        out, err = proc.communicate(timeout=budget)
        return proc.returncode, out, err
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return None, "", "timed out after {:.0f}s".format(budget)


def write_file(rel, text):
    """Atomic write under OUT/wrapper only."""
    path = os.path.join(WRAP, rel)
    if not under(os.path.dirname(path), WRAP):
        raise SystemExit("refusing wrapper write outside {}".format(WRAP))
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return path


def finish(extra=None):
    if extra:
        summary.update(extra)
    summary["elapsedSeconds"] = round(time.time() - START, 1)
    if log_lines:
        summary["log"] = log_lines[-5:]
    try:
        rec = dict(summary)
        with open(os.path.join(WRAP, "fires.ndjson"), "a") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")
    except (OSError, TypeError):
        pass
    print(json.dumps(summary, sort_keys=True))
    sys.exit(0)


# -- out-dir setup and containment --------------------------------------------
WRAP = os.path.join(OUT, "wrapper")
if not STATE_DIR or not os.path.isdir(STATE_DIR):
    WRAP = None
    print(json.dumps(dict(summary, skipped="SMOKE_GATE_STATE_DIR is not a directory", inputErrors=1), sort_keys=True))
    sys.exit(0)
for root, name in ((STATE_DIR, "gate state dir"), (RUN_ROOT, "run root")):
    if root and (under(OUT, root) or under(root, OUT)):
        print(json.dumps(dict(summary, skipped="out-dir overlaps the {}".format(name)), sort_keys=True))
        sys.exit(0)
try:
    os.makedirs(os.path.join(WRAP, "inputs"), exist_ok=True)
    os.makedirs(os.path.join(WRAP, "tmp"), exist_ok=True)
except OSError as exc:
    WRAP = None
    print(json.dumps(dict(summary, skipped="cannot create out-dir: {}".format(exc)), sort_keys=True))
    sys.exit(0)
if os.path.islink(OUT) or os.path.islink(WRAP):
    print(json.dumps(dict(summary, skipped="out-dir or wrapper dir is a symlink"), sort_keys=True))
    sys.exit(0)

TMP = os.path.join(WRAP, "tmp")
CHILD_ENV = dict(os.environ)
CHILD_ENV.update({
    "SMOKE_CONTROLLER_MODE": "shadow",
    "TMPDIR": TMP, "XDG_CACHE_HOME": TMP, "XDG_STATE_HOME": TMP,
    "GH_NO_UPDATE_NOTIFIER": "1", "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1",
    "PYTHONDONTWRITEBYTECODE": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
})

lock_fd = os.open(os.path.join(WRAP, "wrapper.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o644)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    finish({"skipped": "another shadow fire holds wrapper.lock"})

# -- one-time init ---------------------------------------------------------------
JOURNAL = os.path.join(OUT, "journal.ndjson")
SENTINEL = os.path.join(WRAP, "initialized")
if not os.path.exists(SENTINEL):
    if not os.path.exists(JOURNAL):
        rc, out, err = run(["python3", CTL, "init", "--shadow", "--out-dir", OUT, "--lock-timeout", "5"], 20, CHILD_ENV)
        last = (out.strip().splitlines() or [""])[-1]
        try:
            initialized = rc == 0 and bool(json.loads(last).get("initialized"))
        except ValueError:
            initialized = False
        if not initialized:
            # e.g. control.lock busy: init printed ok but created nothing.
            finish({"skipped": "controller init did not complete", "controllerRc": rc,
                    "error": (last or (err or "").strip())[:300]})
        summary["initialized"] = True
    write_file("initialized", FIRE + "\n")

# -- journal (read-only here; the controller owns it) ----------------------------
open_runs, bare_dispatch = set(), False
try:
    folded = {}
    with open(JOURNAL, "rb") as fh:
        for line in fh.read().decode("utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                folded[rec["key"]] = rec
    for rec in folded.values():
        if rec.get("kind") == "run" and rec.get("slot") == "claim" and rec.get("state") not in ("done", "abandoned"):
            open_runs.add(rec.get("runId"))
        if rec.get("kind") == "dispatch" and rec.get("state") == "intent":
            bare_dispatch = True
    journaled = {rec.get("runId") for rec in folded.values() if rec.get("kind") == "run"}
except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
    # Not ours to judge: the controller refuses a bad journal itself (exit 3).
    log("journal not readable for view planning ({}); controller will decide".format(exc))
    journaled = set()

# -- gate state -> view ----------------------------------------------------------
seen_path = os.path.join(WRAP, "claims-seen.json")
seen, err = read_json(seen_path)
if not isinstance(seen, dict):
    seen = {}
states, raw_bad = {}, []
try:
    names = sorted(os.listdir(STATE_DIR))
except OSError as exc:
    finish({"skipped": "gate state dir unreadable: {}".format(exc), "inputErrors": 1})
for name in names:
    m = STATE_RE.match(name)
    if not m:
        continue
    doc, err = read_json(os.path.join(STATE_DIR, name))
    if err or not isinstance(doc, dict):
        raw_bad.append(name)
        continue
    states[int(m.group(1))] = doc

active = {}
for pr, st in states.items():
    run_id = st.get("activeRunId")
    if isinstance(run_id, str) and RUN_ID_RE.match(run_id):
        active[run_id] = pr
        seen[run_id] = {"pr": pr, "sha": st.get("activeSha"), "deadline": st.get("challengerDeadline"),
                        "disposition": st.get("challengerDisposition"), "startedAt": st.get("activeStartedAt"),
                        "lastSeenActive": FIRE}

view_states = {pr: dict(st) for pr, st in states.items()}
held, expose = set(), set()
for run_id in sorted(open_runs):
    if not isinstance(run_id, str) or not RUN_ID_RE.match(run_id) or run_id in active:
        continue
    info = seen.get(run_id)
    verdict, verr = read_json(os.path.join(STATE_DIR, "runs", run_id, "verdict.json"))
    fin = parse_iso((verdict or {}).get("finishedAt")) if isinstance(verdict, dict) else None
    pr = (info or {}).get("pr")
    st = states.get(pr) if pr is not None else None
    other_active = bool(st and st.get("activeRunId") and st.get("activeRunId") != run_id)
    if info and fin and st is not None and not other_active and (now - fin).total_seconds() < HOLD_SECONDS:
        view_states[pr] = dict(st, activeRunId=run_id, activeSha=info.get("sha"),
                               challengerDeadline=info.get("deadline"),
                               challengerDisposition=info.get("disposition"))
        held.add(run_id)
    else:
        expose.add(run_id)

view_new = os.path.join(WRAP, "gate-view.new")
view = os.path.join(WRAP, "gate-view")
shutil.rmtree(view_new, ignore_errors=True)
os.makedirs(os.path.join(view_new, "runs"))
for pr, st in view_states.items():
    with open(os.path.join(view_new, "pr-{}-state.json".format(pr)), "w") as fh:
        json.dump(st, fh)
for name in raw_bad:  # the controller must see the same unreadable file
    shutil.copyfile(os.path.join(STATE_DIR, name), os.path.join(view_new, name))
held_prs = {seen[r]["pr"] for r in held}
for pr in states:
    pv, _ = read_json(os.path.join(STATE_DIR, "pr-{}-verdict.json".format(pr)))
    if isinstance(pv, dict) and not (pr in held_prs and pv.get("runId") in held):
        with open(os.path.join(view_new, "pr-{}-verdict.json".format(pr)), "w") as fh:
            json.dump(pv, fh)
for run_id in expose:
    src = os.path.join(STATE_DIR, "runs", run_id, "verdict.json")
    if os.path.isfile(src):
        os.makedirs(os.path.join(view_new, "runs", run_id))
        shutil.copyfile(src, os.path.join(view_new, "runs", run_id, "verdict.json"))
shutil.rmtree(view, ignore_errors=True)
os.replace(view_new, view)
# Forget claims nobody can still need: not active, not held, not open.
seen = {r: v for r, v in seen.items() if r in active or r in held or r in open_runs
        or (parse_iso(v.get("lastSeenActive")) and (now - parse_iso(v["lastSeenActive"])).total_seconds() < 7 * 86400)}
write_file("claims-seen.json", json.dumps(seen, sort_keys=True))
summary.update({"activeClaims": len(active), "held": len(held), "gateStateErrors": len(raw_bad)})

# -- PR heads (gh, read-only) ------------------------------------------------------
input_errors = []
heads, freeze = {}, {}
prs = sorted({active[r] for r in active} | held_prs)
if prs and not REPO:
    input_errors.append("SMOKE_GATE_REPO unset: cannot read PR heads")
for pr in prs if REPO else []:
    rc, out, err = run(["gh", "pr", "view", str(pr), "-R", REPO, "--json", "headRefOid,headRefName"],
                       GH_TIMEOUT, CHILD_ENV)
    try:
        doc = json.loads(out) if rc == 0 else None
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or not re.match(r"^[0-9a-f]{40}$", str(doc.get("headRefOid"))):
        input_errors.append("gh pr view {}: {}".format(pr, "rc={} {}".format(rc, (err or "").strip()[:120])))
        continue
    heads[str(pr)] = doc["headRefOid"]
    freeze[pr] = str(doc.get("headRefName") or "").startswith("smoke/freeze-")

# -- tasks (ncl, only when a bare dispatch intent needs reconciling) ------------
tasks = []
if bare_dispatch and not input_errors:
    rc, out, err = run(["ncl", "tasks", "list", "--json"], NCL_TIMEOUT, CHILD_ENV)
    try:
        resp = json.loads(out) if rc == 0 else None
    except ValueError:
        resp = None
    if not isinstance(resp, dict) or resp.get("ok") is not True or not isinstance(resp.get("data"), list):
        input_errors.append("ncl tasks list: rc={} {}".format(rc, (err or "").strip()[:120]))
    else:
        # The controller matches `name` against its ctl-<key8> slug; a series
        # id is `<name slug>-<hex>` (src/modules/scheduling/create.ts:67-71).
        tasks = [{"id": t.get("series_id"), "name": t.get("series_id"), "status": t.get("status")}
                 for t in resp["data"] if isinstance(t, dict)]
    summary["tasksFetched"] = True

if input_errors:
    for e in input_errors:
        log("input fetch failed: " + e)
    finish({"skipped": "input fetch failed", "inputErrors": len(input_errors)})

# -- synthesized claiming wake (at most one) --------------------------------------
wake_path = None
fresh = [r for r in active if r not in journaled]
if fresh:
    run_id = max(fresh, key=lambda r: (str(seen[r].get("startedAt") or ""), r))
    pr = active[run_id]
    wake = {"wakeAgent": True, "data": {"trigger": "pr_build_settled", "runId": run_id, "pr": pr,
                                         "sourceSha": seen[run_id].get("sha"), "isFreezePr": freeze.get(pr),
                                         "shadowSynthesized": True}}
    wake_path = write_file("inputs/poll.json", json.dumps(wake))
    summary["newClaimWake"] = run_id

heads_path = write_file("inputs/pr-heads.json", json.dumps(heads, sort_keys=True))
tasks_path = write_file("inputs/tasks.json", json.dumps(tasks))
receipts_path = write_file("inputs/receipts.json", "{}")

# -- the step --------------------------------------------------------------------
step_budget = min(STEP_TIMEOUT, remaining() - MARGIN)
if step_budget < STEP_MIN:
    finish({"skipped": "budget too small for the step ({:.0f}s left)".format(remaining())})
argv = ["python3", CTL, "step", "--shadow", "--out-dir", OUT, "--gate-state-dir", view, "--run-root", RUN_ROOT,
        "--pr-heads-json", heads_path, "--tasks-json", tasks_path, "--receipts-json", receipts_path,
        "--fire", FIRE, "--lock-timeout", "5"]
if wake_path:
    argv += ["--poll-json", wake_path]
rc, out, err = run(argv, step_budget, CHILD_ENV)
summary["controllerRc"] = rc
res = {}
lines = [l for l in (out or "").splitlines() if l.strip()]
try:
    res = json.loads(lines[-1]) if lines else {}
except ValueError:
    res = {}
if rc is None:
    log("controller step killed: {}".format(err))
    finish({"skipped": "controller step timed out", "stepped": False})
if rc != 0 or not res.get("ok"):
    finish({"stepped": True, "controllerError": res.get("alarm") or "rc={}".format(rc),
            "error": str(res.get("error") or (err or "").strip())[:300]})
if res.get("skipped"):
    finish({"stepped": False, "skipped": "controller: " + str(res["skipped"])})
finish({"stepped": True, "runs": len(res.get("runs") or []), "decisions": res.get("decisions", 0),
        "effectsRefused": res.get("effectsRefused", 0), "alarms": len(res.get("alarms") or [])})
PY
)"
RC=$?
if [ -z "$DATA" ]; then
  case "$RC" in
    124|137) WHY="fire exceeded its budget and was killed" ;;
    *) WHY="wrapper failed before its summary (see stderr)" ;;
  esac
  DATA="$(jq -cn --argjson rc "$RC" --arg why "$WHY" --arg fire "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{mode:"shadow",fire:$fire,stepped:false,skipped:$why,rc:$rc}')"
  OUT_DIR="${SMOKE_CONTROLLER_SHADOW_DIR:-}"
  if [ -n "$OUT_DIR" ] && [ -d "$OUT_DIR/wrapper" ] && [ ! -L "$OUT_DIR" ] && [ ! -L "$OUT_DIR/wrapper" ]; then
    printf '%s\n' "$DATA" >>"$OUT_DIR/wrapper/fires.ndjson" 2>/dev/null || true
  fi
fi
final "$(printf '%s\n' "$DATA" | tail -n 1)"
