#!/usr/bin/env bash
# Task-script wrapper: one fire of the PR smoke-campaign controller in SHADOW.
#
#   ncl tasks create ... --recurrence '*/10 * * * *' \
#     --script 'bash /app/skills/smoke-test/scripts/smoke-controller-shadow.sh'
#
# It runs next to the legacy coordinator and changes nothing it does. Each fire:
#   1. reads the gate env file (SMOKE_CONTROLLER_ENV_FILE, default
#      /workspace/agent/smoke-gate-env.sh) AS DATA -- see Guarantees;
#      SMOKE_CONTROLLER_MODE there is the kill switch (unset or `off` = do
#      nothing; `shadow` = run);
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
#      journal holds a bare, non-ambiguous dispatch intent -- the one path
#      that reads tasks (smoke-campaign-controller.py:856-862);
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
#   - Two layers. This bash SUPERVISOR runs no config and touches no file: it
#     validates the budget, runs the python WORKER under a hard
#     `timeout -k 2 <budget>`, and prints the final line whatever the worker
#     did -- exited, crashed, printed nothing or was killed. A config line
#     such as `exit 0` or a hanging command therefore cannot skip that line.
#   - The config file is read by the worker AS DATA, never sourced: only
#     `[export] NAME=<literal>` and `unset NAME` lines for the names in
#     CONFIG_KEYS count; every other line (set -u, echo, exit, sleep, ...) is
#     ignored, and an allowed name assigned anything but a literal (e.g.
#     "$HOME/x") skips the fire rather than guess its value.
#   - Budget: SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS (process env only, never
#     the config file), decimal 1..110 with no leading zero; anything else
#     ("08", "1e3", "200") falls back to 100 and is reported as
#     budgetRejected. The hard kill lands by budget + 2 <= 112 s, under the
#     runner's 120 s (task-script.ts:18-21). The worker keeps its own
#     deadline, cuts every child's timeout to the time left, and on the
#     supervisor's SIGTERM kills its child's process group and logs the fire.
#   - Exit status is 0 whatever happens. An input that cannot be read, a gh or
#     ncl call that fails or times out, or a budget too small for the step
#     each skip the step: a decision-less fire, logged with its reason.
#   - Writes stay under the out-dir, and nothing is created before it is
#     validated: OUT must be a real directory (lstat; made with one mkdir only
#     when absent), and every wrapper write is opened relative to a directory
#     fd with O_NOFOLLOW at each component, then checked with the controller's
#     own helpers (open_contained / _contained,
#     smoke-campaign-controller.py:202-257) to resolve under OUT and to be a
#     regular file with exactly one link. A symlinked OUT, wrapper/, tmp/ or
#     fires.ndjson is refused; a symlinked *.tmp or gate-view entry is
#     unlinked and replaced, never followed. The controller's journal, lock
#     and decisions use the same containment. TMPDIR and XDG_* point at a
#     wrapper/tmp recreated each fire; bytecode writes are off.
#   - Transport writes outside the out-dir, both ncl's own and only when ncl
#     runs: `ncl` sends its request as a system row in this session's
#     outbound.db (agent-runner cli/ncl.ts:52-65) and acknowledges the reply
#     with a processing_ack row (cli/ncl.ts:86 -> markMessages,
#     mailbox/sqlite/operations.ts:62). The reply is written with trigger=0,
#     which never wakes the agent (src/cli/delivery-action.ts:78). In shadow
#     the controller journals a dispatch intent (smoke-campaign-controller.py
#     :870) and records the refused create as `enqueued` in the same fire
#     (:878-885), so a bare intent survives only a step killed between those
#     lines. The next fire's ncl read then finds no task (shadow creates
#     none), the controller marks the intent ambiguous (:863-866), and ncl
#     never runs for it again: at most one ncl call per such crash.
set -uo pipefail
exec 3>&1 1>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

final() { # <data-json> -- the only write to the runner's stdout
  local data="${1:-}"
  if ! jq -e 'type == "object"' <<<"$data" >/dev/null 2>&1; then
    data="$(jq -cn --arg e "fire summary missing or not JSON" '{error:$e}' 2>/dev/null)" || data='{}'
  fi
  jq -cn --argjson d "$data" '{wakeAgent:false,data:$d}' >&3 2>/dev/null ||
    printf '%s\n' '{"wakeAgent":false,"data":{"error":"final line could not be rendered"}}' >&3
  exit 0
}

BUDGET_MAX=110
BUDGET=100
BUDGET_REJECTED=""
RAW_BUDGET="${SMOKE_CONTROLLER_SHADOW_BUDGET_SECONDS:-}"
if [ -n "$RAW_BUDGET" ]; then
  # Decimal only: a leading zero is octal in $(( )), and "08" is an error there.
  if [[ "$RAW_BUDGET" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$RAW_BUDGET" -le "$BUDGET_MAX" ]; then
    BUDGET="$RAW_BUDGET"
  else
    BUDGET_REJECTED="$RAW_BUDGET"
  fi
fi

export SMOKE_CONTROLLER_SHADOW_START
SMOKE_CONTROLLER_SHADOW_START="$(date +%s)"
export SMOKE_CONTROLLER_SHADOW_BUDGET="$BUDGET"
export SMOKE_CONTROLLER_SCRIPT_DIR="$SCRIPT_DIR"
export PYTHONDONTWRITEBYTECODE=1

# The hard wall clock: SIGTERM at the budget, SIGKILL 2 s later.
DATA="$(timeout -k 2 "$BUDGET" python3 - <<'PY'
import datetime as dt
import fcntl
import importlib.util
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

START = float(os.environ["SMOKE_CONTROLLER_SHADOW_START"])
BUDGET = float(os.environ["SMOKE_CONTROLLER_SHADOW_BUDGET"])
DEADLINE = START + BUDGET - 1  # leave the supervisor its second
SCRIPT_DIR = os.environ["SMOKE_CONTROLLER_SCRIPT_DIR"]
CTL = os.path.join(SCRIPT_DIR, "smoke-campaign-controller.py")
ENV_FILE = os.environ.get("SMOKE_CONTROLLER_ENV_FILE", "/workspace/agent/smoke-gate-env.sh")
TEST_HANG = os.environ.get("SMOKE_CONTROLLER_SHADOW_TEST_HANG", "")  # test-only; never read from config
CONFIG_KEYS = (
    "SMOKE_CONTROLLER_MODE", "SMOKE_CONTROLLER_SHADOW_DIR", "SMOKE_CONTROLLER_SHADOW_HOLD_SECONDS",
    "SMOKE_CONTROLLER_SHADOW_GH_TIMEOUT", "SMOKE_CONTROLLER_SHADOW_NCL_TIMEOUT",
    "SMOKE_CONTROLLER_SHADOW_STEP_TIMEOUT", "SMOKE_CONTROLLER_SHADOW_STEP_MIN_SECONDS",
    "SMOKE_GATE_STATE_DIR", "SMOKE_GATE_RUN_ROOT", "SMOKE_GATE_REPO",
)
MARGIN = 3
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
STATE_RE = re.compile(r"^pr-(\d+)-state\.json$")
ASSIGN_RE = re.compile(r"""^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()]*))\s*(?:#.*)?$""")
NAME_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
UNSET_RE = re.compile(r"^unset\s+([A-Za-z_][A-Za-z0-9_\s]*)$")

now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
FIRE = now.strftime("%Y-%m-%dT%H:%M:%SZ")
summary = {"mode": None, "fire": FIRE, "stepped": False}
log_lines = []
OUT = None
WRITABLE = False   # True only once OUT and OUT/wrapper are validated
CHILD = None       # the running subprocess, killed with its group on SIGTERM
FINISHING = False
ctl = None


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


# -- contained writes (all relative to a validated OUT) --------------------------
class Refused(Exception):
    pass


def check_fd(fd, what):
    """The controller's resolve-under-root check, plus its regular-file and
    single-link checks (smoke-campaign-controller.py:241-252)."""
    ctl._contained(fd, OUT)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise Refused("{}: not a regular single-link file".format(what))


def open_dir(parts, create=True):
    """fd of OUT/<parts...>; every component opened O_NOFOLLOW (a symlink
    anywhere is refused, never followed) and the result resolved under OUT."""
    for p in parts:
        if not p or p in (".", "..") or "/" in p:
            raise Refused("unsafe path component {!r}".format(p))
    dfd = os.open(OUT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for p in parts:
            if create:
                try:
                    os.mkdir(p, 0o755, dir_fd=dfd)
                except FileExistsError:
                    pass
            nxt = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
            os.close(dfd)
            dfd = nxt
        ctl._contained(dfd, OUT)
    except BaseException:
        os.close(dfd)
        raise
    return dfd


def remove_entry(dfd, name):
    """Remove dfd/name without following it: a symlink is unlinked itself, a
    directory is removed by the fd-based rmtree (no symlink is followed)."""
    try:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(name, dir_fd=dfd)
    else:
        os.unlink(name, dir_fd=dfd)


def write_in(dfd, name, data):
    """Atomic replace of dfd/name: a fresh O_EXCL|O_NOFOLLOW temp (any old
    one, symlink or not, is unlinked first), then rename -- which replaces
    a symlink at name rather than writing through it."""
    tmp = name + ".tmp"
    remove_entry(dfd, tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
    try:
        check_fd(fd, tmp)
        view = memoryview(data if isinstance(data, bytes) else data.encode("utf-8"))
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)
    os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)


def write_file(parts, text):
    dfd = open_dir(parts[:-1])
    try:
        write_in(dfd, parts[-1], text)
    finally:
        os.close(dfd)
    return os.path.join(OUT, *parts)


def append_fire_log(rec):
    fd = ctl.open_contained(OUT, ["wrapper", "fires.ndjson"], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    try:
        os.write(fd, (json.dumps(rec, sort_keys=True) + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def finish(extra=None):
    global FINISHING
    FINISHING = True
    if extra:
        summary.update(extra)
    summary["elapsedSeconds"] = round(time.time() - START, 1)
    if log_lines:
        summary["log"] = log_lines[-5:]
    if WRITABLE:
        try:
            append_fire_log(dict(summary))
        except Exception as exc:  # noqa: BLE001 -- the fire log is best-effort
            summary["fireLogError"] = str(exc)[:200]
    sys.stdout.write(json.dumps(summary, sort_keys=True) + "\n")
    sys.stdout.flush()
    os._exit(0)


def on_term(signum, frame):
    if FINISHING:
        return
    if CHILD is not None:
        try:
            os.killpg(CHILD.pid, signal.SIGKILL)
        except OSError:
            pass
    finish({"stepped": False, "skipped": "fire exceeded its budget and was killed"})


signal.signal(signal.SIGTERM, on_term)


def run(argv, timeout, env=None):
    """(rc, stdout, stderr) with a hard timeout; rc None = timed out / not runnable."""
    global CHILD
    budget = min(timeout, remaining() - MARGIN)
    if budget < 1:
        return None, "", "no budget left"
    try:
        CHILD = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
    except OSError as exc:
        return None, "", str(exc)
    proc = CHILD
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
    finally:
        CHILD = None


# -- config, as data ------------------------------------------------------------------
def load_config(path):
    """({name: value|None}, [names with a non-literal value], error)."""
    cfg, refused = {}, []
    if not os.path.exists(path):
        return cfg, refused, None
    try:
        with open(path, "rb") as fh:
            text = fh.read(256 * 1024).decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, refused, str(exc)
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = UNSET_RE.match(s)
        if m:
            for name in m.group(1).split():
                if name in CONFIG_KEYS:
                    cfg[name] = None
            continue
        m = ASSIGN_RE.match(s)
        if m:
            if m.group(1) in CONFIG_KEYS:
                cfg[m.group(1)] = next(g for g in m.group(2, 3, 4) if g is not None)
            continue
        m = NAME_RE.match(s)
        if m and m.group(1) in CONFIG_KEYS:
            refused.append(m.group(1))
    return cfg, refused, None


cfg, refused, cfg_err = load_config(ENV_FILE)
if cfg is None:
    finish({"skipped": "env file unreadable", "envFile": ENV_FILE, "error": cfg_err})
for k, v in cfg.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v
MODE = os.environ.get("SMOKE_CONTROLLER_MODE") or "off"
summary["mode"] = MODE
if MODE == "off":
    finish()
if MODE != "shadow":
    finish({"skipped": "unsupported SMOKE_CONTROLLER_MODE (off|shadow only)"})
if refused:
    finish({"skipped": "env file assigns a non-literal value", "refusedKeys": sorted(set(refused))})
if remaining() < 5:
    finish({"skipped": "budget exhausted before start"})


def env_int(name, default):
    raw = os.environ.get(name, "")
    return int(raw) if raw.isdigit() else default


HOLD_SECONDS = env_int("SMOKE_CONTROLLER_SHADOW_HOLD_SECONDS", 7200)
GH_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_GH_TIMEOUT", 10)
NCL_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_NCL_TIMEOUT", 35)
STEP_TIMEOUT = env_int("SMOKE_CONTROLLER_SHADOW_STEP_TIMEOUT", 60)
STEP_MIN = env_int("SMOKE_CONTROLLER_SHADOW_STEP_MIN_SECONDS", 10)
STATE_DIR = os.environ.get("SMOKE_GATE_STATE_DIR", "")
RUN_ROOT = os.environ.get("SMOKE_GATE_RUN_ROOT", "")
REPO = os.environ.get("SMOKE_GATE_REPO", "")

# Out-dir: explicit, else a sibling of the run root (the shared workgroup dir).
OUT = os.environ.get("SMOKE_CONTROLLER_SHADOW_DIR", "")
if not OUT:
    if not RUN_ROOT:
        finish({"skipped": "no out-dir: set SMOKE_CONTROLLER_SHADOW_DIR or SMOKE_GATE_RUN_ROOT"})
    OUT = os.path.join(os.path.dirname(RUN_ROOT.rstrip("/")), "controller-shadow")
OUT = os.path.abspath(OUT)

# -- validate before any mutation -------------------------------------------------
if not STATE_DIR or not os.path.isdir(STATE_DIR):
    finish({"skipped": "SMOKE_GATE_STATE_DIR is not a directory", "inputErrors": 1})
for root, name in ((STATE_DIR, "gate state dir"), (RUN_ROOT, "run root")):
    if root and (under(OUT, root) or under(root, OUT)):
        finish({"skipped": "out-dir overlaps the {}".format(name)})
try:
    spec = importlib.util.spec_from_file_location("smoke_campaign_controller", CTL)
    ctl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ctl)
except Exception as exc:  # noqa: BLE001
    finish({"skipped": "controller not loadable: {}".format(exc)})
try:
    try:
        st = os.lstat(OUT)
    except FileNotFoundError:
        os.mkdir(OUT, 0o755)  # one level only; EEXIST on a dangling symlink
        st = os.lstat(OUT)
    if not stat.S_ISDIR(st.st_mode):
        raise Refused("out-dir is not a real directory (symlink?)")
    os.close(open_dir(["wrapper"]))
except (OSError, Refused, ctl.ControllerError) as exc:
    finish({"skipped": "out-dir refused: {}".format(exc)})
WRAP = os.path.join(OUT, "wrapper")
WRITABLE = True

try:
    lock_fd = ctl.open_contained(OUT, ["wrapper", "wrapper.lock"], os.O_RDWR | os.O_CREAT)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    finish({"skipped": "another shadow fire holds wrapper.lock"})
except (OSError, ctl.ControllerError) as exc:
    WRITABLE = False
    finish({"skipped": "wrapper.lock refused: {}".format(exc)})

if TEST_HANG:
    if TEST_HANG == "ignore-term":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(1)


def main():
    # A fresh tmp each fire: children (gh) write there by path.
    wfd = open_dir(["wrapper"])
    try:
        remove_entry(wfd, "tmp")
    finally:
        os.close(wfd)
    os.close(open_dir(["wrapper", "tmp"]))
    os.close(open_dir(["wrapper", "inputs"]))
    tmp = os.path.join(WRAP, "tmp")
    child_env = dict(os.environ)
    child_env.update({
        "SMOKE_CONTROLLER_MODE": "shadow",
        "TMPDIR": tmp, "XDG_CACHE_HOME": tmp, "XDG_STATE_HOME": tmp,
        "GH_NO_UPDATE_NOTIFIER": "1", "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1",
        "PYTHONDONTWRITEBYTECODE": "1", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
    })
    child_env.pop("SMOKE_CONTROLLER_SHADOW_TEST_HANG", None)

    # -- one-time init ---------------------------------------------------------
    journal_path = os.path.join(OUT, "journal.ndjson")
    if not os.path.lexists(os.path.join(WRAP, "initialized")):
        if not os.path.lexists(journal_path):
            rc, out, err = run(["python3", CTL, "init", "--shadow", "--out-dir", OUT, "--lock-timeout", "5"],
                               20, child_env)
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
        write_file(["wrapper", "initialized"], FIRE + "\n")

    # -- journal (read-only here; the controller owns it) -------------------------
    open_runs, bare_dispatch = set(), False
    try:
        folded = {}
        with open(journal_path, "rb") as fh:
            for line in fh.read().decode("utf-8").splitlines():
                if line.strip():
                    rec = json.loads(line)
                    folded[rec["key"]] = rec
        for rec in folded.values():
            if rec.get("kind") == "run" and rec.get("slot") == "claim" and rec.get("state") not in ("done", "abandoned"):
                open_runs.add(rec.get("runId"))
            # An ambiguous intent is never reconciled from tasks again in
            # shadow (no ctl-* task exists), so it needs no ncl read.
            if rec.get("kind") == "dispatch" and rec.get("state") == "intent" \
                    and not (rec.get("detail") or {}).get("ambiguous"):
                bare_dispatch = True
        journaled = {rec.get("runId") for rec in folded.values() if rec.get("kind") == "run"}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, UnicodeDecodeError) as exc:
        # Not ours to judge: the controller refuses a bad journal itself (exit 3).
        log("journal not readable for view planning ({}); controller will decide".format(exc))
        journaled = set()

    # -- gate state -> view ------------------------------------------------------
    seen, _ = read_json(os.path.join(WRAP, "claims-seen.json"))
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
    for run_id in sorted(r for r in open_runs if isinstance(r, str)):
        if not RUN_ID_RE.match(run_id) or run_id in active:
            continue
        info = seen.get(run_id) if isinstance(seen.get(run_id), dict) else None
        verdict, _ = read_json(os.path.join(STATE_DIR, "runs", run_id, "verdict.json"))
        fin = parse_iso(verdict.get("finishedAt")) if isinstance(verdict, dict) else None
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

    def src_bytes(path):
        with open(path, "rb") as fh:
            return fh.read(4 * 1024 * 1024)

    wfd = open_dir(["wrapper"])
    try:
        remove_entry(wfd, "gate-view.new")
        vfd = open_dir(["wrapper", "gate-view.new"])
        try:
            os.mkdir("runs", 0o755, dir_fd=vfd)
            for pr, st in view_states.items():
                write_in(vfd, "pr-{}-state.json".format(pr), json.dumps(st))
            for name in raw_bad:  # the controller must see the same unreadable file
                try:
                    write_in(vfd, name, src_bytes(os.path.join(STATE_DIR, name)))
                except FileNotFoundError:
                    pass
            held_prs = {seen[r]["pr"] for r in held}
            for pr in states:
                pv, _ = read_json(os.path.join(STATE_DIR, "pr-{}-verdict.json".format(pr)))
                if isinstance(pv, dict) and not (pr in held_prs and pv.get("runId") in held):
                    write_in(vfd, "pr-{}-verdict.json".format(pr), json.dumps(pv))
        finally:
            os.close(vfd)
        for run_id in sorted(expose):
            src = os.path.join(STATE_DIR, "runs", run_id, "verdict.json")
            if os.path.isfile(src):
                rfd = open_dir(["wrapper", "gate-view.new", "runs", run_id])
                try:
                    write_in(rfd, "verdict.json", src_bytes(src))
                finally:
                    os.close(rfd)
        remove_entry(wfd, "gate-view")
        os.rename("gate-view.new", "gate-view", src_dir_fd=wfd, dst_dir_fd=wfd)
    finally:
        os.close(wfd)
    view = os.path.join(WRAP, "gate-view")
    # Forget claims nobody can still need: not active, not held, not open.
    seen = {r: v for r, v in seen.items() if isinstance(v, dict) and (
        r in active or r in held or r in open_runs
        or (parse_iso(v.get("lastSeenActive")) and (now - parse_iso(v["lastSeenActive"])).total_seconds() < 7 * 86400))}
    write_file(["wrapper", "claims-seen.json"], json.dumps(seen, sort_keys=True))
    summary.update({"activeClaims": len(active), "held": len(held), "gateStateErrors": len(raw_bad)})

    # -- PR heads (gh, read-only) ------------------------------------------------
    input_errors = []
    heads, freeze = {}, {}
    prs = sorted({active[r] for r in active} | held_prs)
    if prs and not REPO:
        input_errors.append("SMOKE_GATE_REPO unset: cannot read PR heads")
    for pr in prs if REPO else []:
        rc, out, err = run(["gh", "pr", "view", str(pr), "-R", REPO, "--json", "headRefOid,headRefName"],
                           GH_TIMEOUT, child_env)
        try:
            doc = json.loads(out) if rc == 0 else None
        except ValueError:
            doc = None
        if not isinstance(doc, dict) or not re.match(r"^[0-9a-f]{40}$", str(doc.get("headRefOid"))):
            input_errors.append("gh pr view {}: {}".format(pr, "rc={} {}".format(rc, (err or "").strip()[:120])))
            continue
        heads[str(pr)] = doc["headRefOid"]
        freeze[pr] = str(doc.get("headRefName") or "").startswith("smoke/freeze-")

    # -- tasks (ncl, only when a bare dispatch intent needs reconciling) ----------
    tasks = []
    if bare_dispatch and not input_errors:
        rc, out, err = run(["ncl", "tasks", "list", "--json"], NCL_TIMEOUT, child_env)
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

    # -- synthesized claiming wake (at most one) ------------------------------------
    wake_path = None
    fresh = [r for r in active if r not in journaled]
    if fresh:
        run_id = max(fresh, key=lambda r: (str(seen[r].get("startedAt") or ""), r))
        pr = active[run_id]
        wake = {"wakeAgent": True, "data": {"trigger": "pr_build_settled", "runId": run_id, "pr": pr,
                                             "sourceSha": seen[run_id].get("sha"), "isFreezePr": freeze.get(pr),
                                             "shadowSynthesized": True}}
        wake_path = write_file(["wrapper", "inputs", "poll.json"], json.dumps(wake))
        summary["newClaimWake"] = run_id

    heads_path = write_file(["wrapper", "inputs", "pr-heads.json"], json.dumps(heads, sort_keys=True))
    tasks_path = write_file(["wrapper", "inputs", "tasks.json"], json.dumps(tasks))
    receipts_path = write_file(["wrapper", "inputs", "receipts.json"], "{}")

    # -- the step ------------------------------------------------------------------
    step_budget = min(STEP_TIMEOUT, remaining() - MARGIN)
    if step_budget < STEP_MIN:
        finish({"skipped": "budget too small for the step ({:.0f}s left)".format(remaining())})
    argv = ["python3", CTL, "step", "--shadow", "--out-dir", OUT, "--gate-state-dir", view, "--run-root", RUN_ROOT,
            "--pr-heads-json", heads_path, "--tasks-json", tasks_path, "--receipts-json", receipts_path,
            "--fire", FIRE, "--lock-timeout", "5"]
    if wake_path:
        argv += ["--poll-json", wake_path]
    rc, out, err = run(argv, step_budget, child_env)
    summary["controllerRc"] = rc
    lines = [l for l in (out or "").splitlines() if l.strip()]
    try:
        res = json.loads(lines[-1]) if lines else {}
    except ValueError:
        res = {}
    if not isinstance(res, dict):
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


try:
    main()
except (OSError, Refused, ctl.ControllerError) as exc:
    finish({"stepped": False, "skipped": "containment or IO refused: {}".format(exc)[:300]})
PY
)"
RC=$?
if [ -z "$DATA" ]; then
  case "$RC" in
    124|137) WHY="fire exceeded its budget and was killed" ;;
    *) WHY="wrapper failed before its summary (see stderr)" ;;
  esac
  DATA="$(jq -cn --argjson rc "$RC" --arg why "$WHY" --arg fire "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{mode:null,fire:$fire,stepped:false,skipped:$why,rc:$rc}' 2>/dev/null)"
fi
DATA="$(printf '%s\n' "$DATA" | tail -n 1)"
if [ -n "$BUDGET_REJECTED" ]; then
  DATA="$(jq -c --arg b "$BUDGET_REJECTED" --argjson used "$BUDGET" '. + {budgetRejected:$b,budgetSeconds:$used}' \
    <<<"$DATA" 2>/dev/null)" || DATA=""
fi
final "$DATA"
