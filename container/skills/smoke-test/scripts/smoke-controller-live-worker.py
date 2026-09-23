#!/usr/bin/env python3
"""Worker for smoke-controller-live.sh: one LIVE fire of the smoke campaign
controller. Run only under that supervisor, which owns the hard kill and the
final stdout line; this prints one JSON summary line and exits 0.

A fire that cannot complete reports itself through that line and nothing else:
`failure` (a stable cause slug), `detail` and `fire` in the summary, which the
supervisor renders as wakeAgent:true so the host wakes the owner with the data
(modules/scheduling/host-script.ts:490-503). The wrapper never posts to chat
itself -- the owner does, per references/controller-owner-router.md.

See smoke-controller-live.sh for the fire's steps and guarantees.
"""
import datetime as dt
import fcntl
import importlib.util
import json
import os
import re
import signal
import sqlite3
import stat
import sys
import time

START = float(os.environ["SMOKE_CONTROLLER_LIVE_START"])
BUDGET = float(os.environ["SMOKE_CONTROLLER_LIVE_BUDGET"])
DEADLINE = START + BUDGET - 1
SCRIPT_DIR = os.environ["SMOKE_CONTROLLER_SCRIPT_DIR"]
CTL = os.path.join(SCRIPT_DIR, "smoke-campaign-controller.py")
ENV_FILE = os.environ.get("SMOKE_CONTROLLER_ENV_FILE", "/workspace/agent/smoke-gate-env.sh")
# Commands and paths that are NOT configuration: process env only (test seams),
# never read from the env file.
GH = os.environ.get("SMOKE_CONTROLLER_LIVE_GH_CMD", "gh")
NCL = os.environ.get("SMOKE_CONTROLLER_LIVE_NCL_CMD", "ncl")
ENQUEUE = os.environ.get("SMOKE_CONTROLLER_LIVE_ENQUEUE_CMD", "bun /app/src/cli/enqueue-send.ts")
INBOUND_DB = os.environ.get("SMOKE_CONTROLLER_LIVE_INBOUND_DB", "/workspace/inbound.db")
# THE ENV FILE IS THE LIST OF KEYS. Every literal assignment in it is
# configuration and is passed through, because the file is the INSTALL's and
# a copy of its key names kept here goes stale the first time the install adds
# one. That is XZO #2047: this file carried a 12-name allowlist while the
# install's env file defined 17, so SMOKE_GATE_LEASE_DIR was dropped. An
# install's deployment gate wrapper sources the file itself (`. <its
# dir>/smoke-gate-env.sh`, then exec the skill's gate), so ITS lease dir stayed
# right -- but the evidence barrier is spawned by the controller directly, with this
# process's environment (smoke-campaign-controller.py:1800 -> run_read_only ->
# spawn, :692-704, env=None), and it read the fallback
# ${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}/qa-coordinator/leases
# (smoke-evidence-barrier.sh:739). No pin for the campaign lives there, so
# smoke-journeys.py's barrier took the "no gate pin owns it" path (:997) and
# every campaign stranded at the lanes barrier.
#
# So this pass-through is NOT redundant with the gate sourcing the file. The
# barrier has no way to source it, and the skill's own gate does not source
# anything either -- smoke-pr-gate.sh:241 reads SMOKE_GATE_LEASE_DIR from
# whatever environment its caller hands it, so an install that points
# SMOKE_CONTROLLER_GATE_CMD straight at the skill gets its whole configuration
# from here too. The file is read as DATA, never sourced (that is the
# supervisor's guarantee), so the pass-through is what carries it.
#
# WITHIN ONE NAMESPACE, though. The scope is the `SMOKE_` prefix the install's
# configuration owns -- not a list of names, so it cannot drift: a new SMOKE_
# key the install adds works here with no change. Everything outside it is not
# this file's configuration and is IGNORED, exactly as it was before XZO #2047:
# PATH, IFS and the shell hooks, LD_PRELOAD and friends, PYTHONPATH, and
# BUN_OPTIONS -- whose `--preload` makes Bun execute a module before its main
# script, and this wrapper's enqueue command is Bun (ENQUEUE above). Honouring
# any of those would let a file read AS DATA choose the code its children load,
# which is the guarantee the supervisor advertises (smoke-controller-live.sh).
# An exhaustive deny list could never hold that line; the namespace does.
CONFIG_PREFIX = "SMOKE_"
# NOT_CONFIG is then only for the dangerous names INSIDE the namespace: values
# that say how this process and its children RUN rather than what the campaign
# IS. A name here is IGNORED -- exactly as every unlisted name was ignored
# before -- so denying one takes nothing away that used to work.
# SMOKE_GATE_CLAIMANT is deliberately NOT here: it keeps its own, louder
# refusal in load_config below.
NOT_CONFIG = frozenset((
    # This wrapper's own seams, read from the process env above and documented
    # there as process-env-only. SMOKE_CONTROLLER_CRASH_AT is the controller's
    # kill-injection seam (smoke-campaign-controller.py:237-238, os._exit) and
    # reaches it through CHILD_ENV, so the file must not be able to set it.
    "SMOKE_CONTROLLER_ENV_FILE", "SMOKE_CONTROLLER_SCRIPT_DIR", "SMOKE_CONTROLLER_CRASH_AT",
    "SMOKE_CONTROLLER_LIVE_START", "SMOKE_CONTROLLER_LIVE_BUDGET", "SMOKE_CONTROLLER_LIVE_GH_CMD",
    "SMOKE_CONTROLLER_LIVE_NCL_CMD", "SMOKE_CONTROLLER_LIVE_ENQUEUE_CMD", "SMOKE_CONTROLLER_LIVE_INBOUND_DB",
))
MARGIN = 3
STATE_RE = re.compile(r"^pr-(\d+)-state\.json$")
ASSIGN_RE = re.compile(r"""^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()]*))\s*(?:#.*)?$""")
NAME_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
UNSET_RE = re.compile(r"^unset\s+([A-Za-z_][A-Za-z0-9_\s]*)$")


def is_config(name):
    """A name the env file is allowed to set: inside the install's namespace,
    and not one of the dangerous names in it. See CONFIG_PREFIX / NOT_CONFIG."""
    return name.startswith(CONFIG_PREFIX) and name not in NOT_CONFIG


now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
FIRE = now.strftime("%Y-%m-%dT%H:%M:%SZ")
summary = {"mode": None, "fire": FIRE, "stepped": False}
log_lines = []
OUT = None
WRITABLE = False
CHILD = None
FINISHING = False
ctl = None
# The one line every failure carries, because a persistent fault re-reports
# itself on every fire and the owner is the thing doing the reporting.
REPEAT_NOTE = ("this cause repeats every fire while it persists, so you may have reported it already: "
               "post the alarm under the same per-cause daily id, which replays instead of duplicating")


def log(msg):
    log_lines.append(msg)
    print("smoke-controller-live: " + msg, file=sys.stderr)


def remaining():
    return DEADLINE - time.time()


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


# The controller's post destination. Read from the PROCESS env first, so a
# failure that is itself about the env file (unreadable, a FIFO, a refused
# value) still carries somewhere to report to, and overridden by the env file
# when that can be read. Operators who want the first kind of failure to reach
# chat export it on the task's script line as well as in the env file.
SEND_TO = os.environ.get("SMOKE_CONTROLLER_SEND_TO", "")
MARKER_OPEN = False  # wrapper/fire-open written this fire
# CONSTANT per cause per day -- it is posted under an id keyed by exactly
# that, and enqueue-send refuses the same id with a different payload
# (cli/enqueue-send.ts:294-308). So: no timestamps, no paths, no detail; those
# ride in `data` and belong in the owner's reply, not in the post. It does NOT
# claim the fire changed nothing: a fire can fail after the gate's poll
# claimed a run, or after a step performed effects (round 6).
ALARM_TEXT = ("Smoke controller (live): a fire failed closed ({slug}). It stopped part-way, so this fire's effects are "
              "UNCERTAIN -- a run may have been claimed, a post or a GitHub write may have landed. Before acting, "
              "check the gate state for a run claimed but not advanced, and the controller's journal and fire log. "
              "No further fire will advance that run while the cause persists. Posted once a day per cause.")


def alarm_payload(slug):
    """Everything the owner needs to post this alarm, resolved HERE: the fire
    that failed is the last thing in a position to resolve any of it, and the
    owner must not have to re-read the configuration that just failed."""
    day = FIRE[:10].replace("-", "")
    return {"to": SEND_TO or None,
            "id": "ctl.failure.{}.{}#1".format(slug, day),
            "threadKey": "ctl.failure-{}-{}".format(slug, day),
            "runId": "ctl.wrapper.{}".format(day),
            "fingerprint": slug,
            "fire": FIRE,
            "text": ALARM_TEXT.format(slug=slug)}


# What a failing fire reports itself with. `data.alarm` is the owner's routing
# payload and NOTHING else -- the owner reads {to,id,threadKey,...} off it, so
# a string there makes the prescribed send impossible. A per-cause label lives
# in its own field (`controllerAlarm`).
#
# Round 7: `journal_fail_closed` passed `"alarm": "controller_journal_error"`
# as ordinary detail and _emit's `update()` silently replaced the payload with
# that string. Fixed at the root, in two places that each stop it alone: these
# fields are written AFTER the caller's detail, so detail can never overwrite
# them; and the structure test refuses any `end_fire` call site that names one.
REPORT_FIELDS = ("failure", "detail", "note", "alarm", "outDir")
report = {}


def _emit(extra):
    """Write the fire log and the one stdout line, then exit. Called ONLY by
    end_fire (the structure test enforces it)."""
    global FINISHING
    FINISHING = True
    if extra:
        summary.update(extra)
    summary.update(report)  # the report outranks per-call detail, always
    summary["elapsedSeconds"] = round(time.time() - START, 1)
    if log_lines:
        summary["log"] = log_lines[-5:]
    if WRITABLE:
        try:
            fd = ctl.open_contained(OUT, ["wrapper", "fires.ndjson"], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
            try:
                os.write(fd, (json.dumps(summary, sort_keys=True) + "\n").encode("utf-8"))
            finally:
                os.close(fd)
        except Exception as exc:  # noqa: BLE001 -- the fire log is best-effort
            summary["fireLogError"] = str(exc)[:200]
    sys.stdout.write(json.dumps(summary, sort_keys=True) + "\n")
    sys.stdout.flush()
    os._exit(0)


def end_fire(extra, ok=None, failure="wrapper-error"):
    """THE only way a fire ends. `ok` names one of the two non-failure ends
    ("stepped": the controller step completed; "not-live": the kill switch is
    off, so the wrapper must touch nothing), and those two alone end with
    wakeAgent:false.

    EVERY other end is FAIL-CLOSED and reports itself the only way a task
    script can: `failure` (a stable cause slug), `detail` and `fire` in the
    summary, which the supervisor renders as wakeAgent:true. The host wakes
    the owner with that data (modules/scheduling/host-script.ts:490-503) and
    the owner posts the operator alarm (references/controller-owner-router.md).
    The wrapper posts nothing itself: a fire that cannot complete cannot be
    trusted to run the send either, and one reporting path is one thing to get
    right."""
    global FINISHING
    assert ok in (None, "stepped", "not-live"), ok
    FINISHING = True  # a second SIGTERM while the fire ends must not re-enter
    if ok is None:
        report.update({"failure": failure,
                       "detail": str(extra.get("skipped") or extra.get("controllerError") or failure)[:300],
                       "note": REPEAT_NOTE,
                       "outDir": OUT,
                       "alarm": alarm_payload(failure)})
    if MARKER_OPEN:
        # fire-open means exactly one thing: a fire started and did not reach
        # this function. It carries no obligation and gates nothing.
        try:
            ctl.unlink_contained(OUT, ["wrapper", "fire-open"])
        except (OSError, ctl.ControllerError):
            pass
    _emit(extra)


def on_term(signum, frame):
    if FINISHING:
        return
    if CHILD is not None:
        try:
            os.killpg(CHILD.pid, signal.SIGKILL)
        except OSError:
            pass
    end_fire({"stepped": False, "ownerWake": None, "skipped": "fire exceeded its budget and was killed"},
             failure="fire-killed")


signal.signal(signal.SIGTERM, on_term)


def on_uncaught(exc_type, exc, tb):
    """Any exception nothing else caught is a fail-closed end too."""
    if FINISHING:
        return
    end_fire({"stepped": False, "skipped": "uncaught {}: {}".format(exc_type.__name__, exc)[:300]},
             failure="uncaught-exception")


sys.excepthook = on_uncaught


def run(argv, timeout, env):
    """(rc, stdout, stderr); rc None = timed out / not runnable. Every child
    stops MARGIN short of the worker's deadline, so the fire always has time
    to write its own summary line."""
    import subprocess
    global CHILD
    budget = min(timeout, remaining() - MARGIN)
    if budget < 1:
        return None, "", "no budget left"
    try:
        CHILD = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=env, start_new_session=True)
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


def load_config(path):
    """The shadow wrapper's rules: only `[export] NAME=<literal>` / `unset NAME`
    count, and only for names the file is allowed to set (is_config); anything
    else -- a different namespace, a NOT_CONFIG name, or a line that is not one
    of those two shapes -- is ignored, so an ordinary `EXTRA="$HOME/cache"` is
    as inert as it was before. A non-literal value for a name the file IS
    allowed to set skips the fire rather than guess it."""
    cfg, refused = {}, []
    if not os.path.exists(path):
        return cfg, refused, None
    # SMOKE_GATE_CLAIMANT is set per call by this worker and never in the env
    # file: the gate wrapper sources that file for EVERY caller, so a claimant
    # there would stamp the legacy coordinator's calls as the controller's.
    try:
        with open(path, "rb") as fh:
            text = fh.read(256 * 1024).decode("utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, refused, str(exc)
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if re.search(r"\bSMOKE_GATE_CLAIMANT\b", s):
            refused.append("SMOKE_GATE_CLAIMANT")
            continue
        m = UNSET_RE.match(s)
        if m:
            for name in m.group(1).split():
                if is_config(name):
                    cfg[name] = None
            continue
        m = ASSIGN_RE.match(s)
        if m:
            if is_config(m.group(1)):
                cfg[m.group(1)] = next(g for g in m.group(2, 3, 4) if g is not None)
            continue
        m = NAME_RE.match(s)
        if m and is_config(m.group(1)):
            refused.append(m.group(1))
    return cfg, refused, None


# -- config -----------------------------------------------------------------------
cfg, refused, cfg_err = load_config(ENV_FILE)
if cfg is None:
    end_fire({"skipped": "env file unreadable", "envFile": ENV_FILE, "error": cfg_err}, failure="env-unreadable")
for k, v in cfg.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v
MODE = os.environ.get("SMOKE_CONTROLLER_MODE") or "shadow"
summary["mode"] = MODE
if MODE != "live":
    # Not live: nothing at all. The legacy PR gate task (or the shadow series)
    # owns this state; this wrapper must not poll, claim or post. The kill
    # switch being off is not a failure, so it is the one silent end.
    end_fire({"skipped": "SMOKE_CONTROLLER_MODE is {!r}, not live: the live wrapper does nothing".format(MODE)},
             ok="not-live")
# The env file's value now overrides the process env read at the top.
SEND_TO = os.environ.get("SMOKE_CONTROLLER_SEND_TO", "") or SEND_TO
if "SMOKE_GATE_CLAIMANT" in refused:
    end_fire({"skipped": "the env file names SMOKE_GATE_CLAIMANT: every gate caller sources it, so it would mark "
                       "legacy calls as the controller's. Remove it; this wrapper sets it per call.",
            "misconfigured": ["SMOKE_GATE_CLAIMANT"]}, failure="misconfigured")
if refused:
    end_fire({"skipped": "env file assigns a non-literal value", "refusedKeys": sorted(set(refused))},
             failure="misconfigured")
STATE_DIR = os.environ.get("SMOKE_GATE_STATE_DIR", "")
RUN_ROOT = os.environ.get("SMOKE_GATE_RUN_ROOT", "")
REPO = os.environ.get("SMOKE_GATE_REPO", "")
GATE_CMD = os.environ.get("SMOKE_CONTROLLER_GATE_CMD") or "/workspace/agent/smoke-pr-gate.sh"
POLL_TIMEOUT = int(os.environ.get("SMOKE_CONTROLLER_POLL_TIMEOUT") or 45) \
    if (os.environ.get("SMOKE_CONTROLLER_POLL_TIMEOUT") or "45").isdigit() else 45
missing = [n for n, v in (("SMOKE_GATE_STATE_DIR", STATE_DIR), ("SMOKE_GATE_RUN_ROOT", RUN_ROOT),
                          ("SMOKE_GATE_REPO", REPO), ("SMOKE_CONTROLLER_SEND_TO", SEND_TO)) if not v]
if missing:
    end_fire({"skipped": "live needs " + ", ".join(missing), "misconfigured": missing}, failure="misconfigured")
if not os.path.isfile(GATE_CMD):
    end_fire({"skipped": "gate wrapper {} is not a file".format(GATE_CMD),
              "misconfigured": ["SMOKE_CONTROLLER_GATE_CMD"]}, failure="misconfigured")
if not os.path.isdir(STATE_DIR):
    end_fire({"skipped": "SMOKE_GATE_STATE_DIR is not a directory", "inputErrors": 1}, failure="misconfigured")
OUT = os.path.abspath(os.environ.get("SMOKE_CONTROLLER_OUT_DIR") or
                      os.path.join(os.path.dirname(RUN_ROOT.rstrip("/")), "controller"))
for root, name in ((STATE_DIR, "gate state dir"), (RUN_ROOT, "run root")):
    if under(OUT, root) or under(root, OUT):
        end_fire({"skipped": "out-dir overlaps the {}".format(name)}, failure="misconfigured")
if remaining() < 20:
    end_fire({"skipped": "budget exhausted before start"}, failure="budget-exhausted")

try:
    spec = importlib.util.spec_from_file_location("smoke_campaign_controller", CTL)
    ctl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ctl)
except Exception as exc:  # noqa: BLE001
    end_fire({"skipped": "controller not loadable: {}".format(exc)}, failure="controller-unloadable")
try:
    try:
        st = os.lstat(OUT)
    except FileNotFoundError:
        os.mkdir(OUT, 0o755)
        st = os.lstat(OUT)
    if not stat.S_ISDIR(st.st_mode):
        raise ctl.ControllerError("out-dir is not a real directory (symlink?)")
    ctl.write_contained_atomic(OUT, ["wrapper", ".probe"], "")
except (OSError, ctl.ControllerError) as exc:
    end_fire({"skipped": "out-dir refused: {}".format(exc)}, failure="out-dir-refused")
WRAP = os.path.join(OUT, "wrapper")
WRITABLE = True
try:
    lock_fd = ctl.open_contained(OUT, ["wrapper", "wrapper.lock"], os.O_RDWR | os.O_CREAT)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    end_fire({"skipped": "another live fire holds wrapper.lock"}, failure="lock-held")
except (OSError, ctl.ControllerError) as exc:
    WRITABLE = False
    end_fire({"skipped": "wrapper.lock refused: {}".format(exc)}, failure="lock-refused")
# FORENSICS ONLY. A fire that died without reaching end_fire -- the whole task
# script killed, so neither the worker nor the supervisor printed a line and
# nobody was woken -- left this marker. Recording it in the next fire's summary
# and fire log is all it does: it owes nothing, gates nothing, and does not
# stand in for the alarm that fire never got to raise.
if os.path.lexists(os.path.join(WRAP, "fire-open")):
    log("the previous fire ended without closing (killed?)")
    summary["previousFireUnclosed"] = True
_marker_fd = ctl.open_contained(OUT, ["wrapper", "fire-open"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
os.write(_marker_fd, (FIRE + "\n").encode("utf-8"))
os.close(_marker_fd)
MARKER_OPEN = True

tmp = os.path.join(WRAP, "tmp")
os.makedirs(tmp, exist_ok=True)
CHILD_ENV = dict(os.environ)
CHILD_ENV.update({"SMOKE_CONTROLLER_MODE": "live", "TMPDIR": tmp, "GH_NO_UPDATE_NOTIFIER": "1",
                  "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"})
CHILD_ENV.pop("SMOKE_GATE_CLAIMANT", None)
GATE_ENV = dict(CHILD_ENV, SMOKE_GATE_CLAIMANT="controller")


def write(parts, text):
    return ctl.write_contained_atomic(OUT, parts, text)


def gate_states():
    """({pr: state}, [unreadable names])."""
    states, bad = {}, []
    for name in sorted(os.listdir(STATE_DIR)):
        m = STATE_RE.match(name)
        if not m:
            continue
        doc, err = read_json(os.path.join(STATE_DIR, name))
        if err or not isinstance(doc, dict):
            bad.append(name)
            continue
        states[int(m.group(1))] = doc
    return states, bad


# EVERY latch the gate writes before emitting a wakeAgent:true alarm. The
# gate writes the latch first, so an alarm lost between the poll returning and
# the queue write is not emitted again: never, for the per-PR latches, and not
# for up to 6h, for the control-file ones. Audited against every wakeAgent
# emission in smoke-pr-gate.sh (the other two: pr_build_settled is a claim,
# and the coordinator_lease_unavailable/gate_* ones are the control latches).
#   per-PR state (pr-<n>-state.json), keyed by head SHA or run id:
#     refusedAlertSha / warmupAlertSha / factsStuckAlertSha   :5122-5129, :5145
#     overrunAlertRunId (+ overrunAlertAt, re-arms)           :5131, :5145-5147
#     stalledAlertRunId                                       :4783 (checked :4762)
#   control.json, rate-limited wakes (the timestamp moves on each emission):
#     leaseFailureWakeAt   coordinator_lease_unavailable     :1463
#     lastMisconfigWakeAt  gate_misconfigured                :4858
#     lastFailureWakeAt    gate_fetch_failed                 :4908
#     preflightWakeAt      pr_preflight_failed               :5245 (cleared :5222)
PR_LATCHES = {"refusedAlertSha": "pr_migrations_refused", "warmupAlertSha": "pr_warmup_stuck",
              "factsStuckAlertSha": "pr_facts_unavailable", "overrunAlertRunId": "pr_run_overrun",
              "stalledAlertRunId": "pr_run_stalled"}
RUN_KEYED = ("overrunAlertRunId", "stalledAlertRunId")
CONTROL_LATCHES = {"leaseFailureWakeAt": "coordinator_lease_unavailable",
                   "lastMisconfigWakeAt": "gate_misconfigured", "lastFailureWakeAt": "gate_fetch_failed",
                   "preflightWakeAt": "pr_preflight_failed"}
CONTROL_TRIGGERS = {t: f for f, t in CONTROL_LATCHES.items()}


def read_control():
    """(control.json dict, error). Missing is {} (a gate that never wrote it)."""
    doc, err = read_json(os.path.join(STATE_DIR, "control.json"))
    if err == "missing":
        return {}, None
    if err or not isinstance(doc, dict):
        return None, err or "not an object"
    return doc, None


def latch_map(states, control):
    out = {}
    for pr, st in states.items():
        for field in PR_LATCHES:
            v = st.get(field)
            if isinstance(v, str) and v:
                if field == "overrunAlertRunId":
                    # Overrun re-arms for the same run (overrunAlertAt moves).
                    v = "{}@{}".format(v, st.get("overrunAlertAt") or "")
                out["{}:{}".format(pr, field)] = v
    for field in CONTROL_LATCHES:
        v = control.get(field)
        if isinstance(v, str) and v:
            out["control:" + field] = v
    return out


def alarm_fingerprint(wake, control):
    """One fingerprint for the poll path and the latch path alike."""
    field = CONTROL_TRIGGERS.get(wake.get("trigger"))
    if field:
        return "control:{}@{}".format(field, control.get(field) or "-")
    key = wake.get("runId") if wake.get("trigger") in ("pr_run_overrun", "pr_run_stalled") else None
    key = key or wake.get("sourceSha") or wake.get("runId") or "-"
    return "{}:{}".format(wake.get("pr"), key)


def queue_alarm(wake, control):
    """Durable, once per fingerprint: wrapper/alarms/<fp>.json."""
    wake = dict(wake)
    if wake.get("fingerprint") and "gateFingerprint" not in wake:
        wake["gateFingerprint"] = wake["fingerprint"]
    wake["fingerprint"] = alarm_fingerprint(wake, control)
    wake.setdefault("queuedAt", FIRE)
    _, fp, _ = ctl.gate_alarm_ids(wake, now)
    try:
        ctl.write_contained_once(OUT, ["wrapper", "alarms", fp + ".json"],
                                 json.dumps({"wakeAgent": True, "data": wake}, sort_keys=True) + "\n")
    except FileExistsError:
        pass
    return fp


def alarm_queue():
    """The queued gate alarms, listed through the containment walk: a
    symlinked wrapper/alarms is refused, never silently read as empty."""
    return [n for n in ctl.listdir_contained(OUT, ["wrapper", "alarms"]) if n.endswith(".json")]


def journal_fail_closed(reason, detail):
    """The journal is not trustworthy: no progress stamp, no poll, no step.
    Its own cause slug, through the one fail-closed exit."""
    # The controller's own alarm name goes in `controllerAlarm`: `alarm` is the
    # owner's routing payload (round 7) and nothing may share it.
    end_fire({"stepped": False, "skipped": "journal failed validation: " + reason,
              "controllerAlarm": "controller_journal_error", "error": detail[:300]}, failure="journal-invalid")


def fold_journal():
    folded = {}
    path = os.path.join(OUT, "journal.ndjson")
    with open(path, "rb") as fh:
        for line in fh.read().decode("utf-8").splitlines():
            if line.strip():
                rec = json.loads(line)
                cur = folded.setdefault(rec["key"], {"detail": {}})
                cur.update({k: rec[k] for k in ("runId", "kind", "slot", "state")})
                cur["detail"].update(rec.get("detail") or {})
                if rec.get("attempt"):
                    cur["attempt"] = rec["attempt"]
    return folded


def main():
    # -- one-time init (sentinel as in the shadow wrapper) ------------------------
    journal_path = os.path.join(OUT, "journal.ndjson")
    if not os.path.lexists(os.path.join(WRAP, "initialized")):
        if not os.path.lexists(journal_path):
            rc, out, err = run(["python3", CTL, "init", "--out-dir", OUT, "--lock-timeout", "5"], 20, CHILD_ENV)
            doc = ctl.last_json_line(out) if rc == 0 else None
            if not (doc and doc.get("initialized")):
                end_fire({"skipped": "controller init did not complete", "controllerRc": rc,
                        "error": ((out or "") + (err or "")).strip()[-300:]}, failure="init-failed")
            summary["initialized"] = True
        write(["wrapper", "initialized"], FIRE + "\n")

    # -- the journal is validated in full BEFORE any gate effect ---------------------
    # Torn tail, record schema, born mode and per-record mode, under
    # control.lock (the controller's own load). Never "empty" on error.
    rc, out, err = run(["python3", CTL, "validate", "--out-dir", OUT, "--lock-timeout", "5"], 20, CHILD_ENV)
    doc = ctl.last_json_line(out) if rc is not None else None
    if not isinstance(doc, dict):
        end_fire({"skipped": "journal validation did not answer", "controllerRc": rc,
                "error": (err or "").strip()[-300:]}, failure="journal-unvalidated")
    if doc.get("skipped"):
        end_fire({"skipped": "journal validation: " + str(doc["skipped"])}, failure="journal-unvalidated")
    if not doc.get("valid"):
        journal_fail_closed(str(doc.get("alarm") or "invalid"), str(doc.get("error") or (err or "").strip()))
    try:
        folded = fold_journal()
    except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
        journal_fail_closed("unreadable after validation", str(exc))

    # -- cutover: once, BEFORE this controller's first poll ------------------------
    cutover = os.path.join(OUT, "cutover.json")
    latches_path = os.path.join(WRAP, "latches.json")
    states, bad = gate_states()
    if not os.path.lexists(cutover) or not os.path.lexists(latches_path):
        if bad:
            end_fire({"skipped": "cannot write the cutover: gate state unreadable ({})".format(", ".join(bad))},
                     failure="gate-state-unreadable")
        if not os.path.lexists(latches_path):
            # Baseline: latches set before this controller ever polled were
            # the legacy coordinator's alarms, not ours to re-post.
            control0, cerr0 = read_control()
            if control0 is None:
                end_fire({"skipped": "gate control.json unreadable ({}): no latch baseline".format(cerr0)},
                         failure="gate-control-unreadable")
            write(["wrapper", "latches.json"], json.dumps(latch_map(states, control0), sort_keys=True))
    if not os.path.lexists(cutover):
        legacy = sorted(st["activeRunId"] for st in states.values()
                        if isinstance(st.get("activeRunId"), str) and st.get("activeClaimant") != "controller")
        ctl.write_contained_once(OUT, ["cutover.json"], json.dumps(
            {"schemaVersion": 1, "flippedAt": FIRE, "legacyRuns": legacy}, sort_keys=True) + "\n")
        summary["cutover"] = {"legacyRuns": legacy}

    # -- gate alarm latches the queue has not seen (the poll-return crash window) ---
    if bad:
        end_fire({"skipped": "gate state unreadable ({}): latches cannot be reconciled".format(", ".join(bad))},
                 failure="gate-state-unreadable")
    acked, acked_err = read_json(latches_path)
    if acked_err or not isinstance(acked, dict):
        end_fire({"skipped": "wrapper/latches.json unreadable: {}".format(acked_err or "not an object")},
                 failure="latches-unreadable")
    control, cerr = read_control()
    if control is None:
        end_fire({"skipped": "gate control.json unreadable ({}): latches cannot be reconciled".format(cerr)},
                 failure="gate-control-unreadable")
    current = latch_map(states, control)
    for name, value in sorted(current.items()):
        if acked.get(name) == value:
            continue
        pr, field = name.split(":", 1)
        if pr == "control":
            wake = {"schemaVersion": 1, "trigger": CONTROL_LATCHES[field], "recoveredFromGateLatch": True,
                    "latchedAt": value}
            if field == "preflightWakeAt":
                m = re.match(r"^pr\|.*\|(\d+)$", str(control.get("preflightFingerprint") or ""))
                wake.update({"pr": int(m.group(1)) if m else None, "reason": control.get("preflightReason")})
        else:
            run_key = value.split("@", 1)[0] if field in RUN_KEYED else None
            wake = {"schemaVersion": 1, "trigger": PR_LATCHES[field], "pr": int(pr),
                    "sourceSha": None if run_key else value, "runId": run_key, "recoveredFromGateLatch": True}
            if field == "stalledAlertRunId":
                wake["sourceSha"] = states.get(int(pr), {}).get("activeSha")
        fp = queue_alarm(wake, control)
        log("gate latch {} had no queued alarm; recovered as {}".format(name, fp))
        summary.setdefault("recoveredAlarms", []).append(fp)
    if current != acked:
        write(["wrapper", "latches.json"], json.dumps(current, sort_keys=True))

    # -- keep our claims live, then poll (the poll may reclaim a stale run) --------
    tokens = {ob["runId"]: ob["detail"].get("ownerToken") for ob in folded.values()
              if ob.get("kind") == "run" and ob.get("slot") == "claim" and ob.get("state") not in ("done", "abandoned")}
    for st in states.values():
        run_id = st.get("activeRunId")
        if st.get("activeClaimant") == "controller" and tokens.get(run_id) and \
                tokens[run_id] == st.get("activeLeaseOwner"):
            rc, out, err = run(["bash", GATE_CMD, "progress", run_id, tokens[run_id]], 20, GATE_ENV)
            if not (ctl.last_json_line(out) or {}).get("ok"):
                log("progress stamp for {} failed: {}".format(run_id, (err or out or "").strip()[:120]))
    poll = None
    poll_path = None
    pending_alarms = alarm_queue()
    if pending_alarms:
        # Queued alarms are drained into the journal BEFORE the next poll: a
        # queue that never drains must not let polls keep claiming runs.
        summary["pollSkipped"] = "{} queued gate alarm(s) to drain first".format(len(pending_alarms))
    else:
        rc, out, err = run(["bash", GATE_CMD, "poll"], POLL_TIMEOUT, GATE_ENV)
        poll = ctl.last_json_line(out) if rc is not None else None
        if not isinstance(poll, dict):
            log("gate poll gave no result: rc={} {}".format(rc, (err or "").strip()[:160]))
            summary["pollError"] = True
    if isinstance(poll, dict):
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        summary["pollTrigger"] = data.get("trigger")
        if poll.get("wakeAgent") is True and data.get("trigger") not in (None, "pr_build_settled"):
            # An alarm: the gate has latched it and will not emit it again.
            # Queued durably first, then the latch is acknowledged.
            # Fingerprinted from the latch this poll just wrote.
            states_now, bad_now = gate_states()
            control_now, cerr_now = read_control()
            if control_now is None and data.get("trigger") in CONTROL_TRIGGERS:
                # Its fingerprint is the latch timestamp we cannot read; the
                # latch itself is durable, so next fire's recovery queues it
                # under the right fingerprint (queuing a guess here would post
                # it twice).
                log("control alarm {} left to latch recovery: control.json {}".format(data.get("trigger"), cerr_now))
            else:
                queue_alarm(data, control_now or {})
            if not bad_now and control_now is not None:
                write(["wrapper", "latches.json"], json.dumps(latch_map(states_now, control_now), sort_keys=True))
        else:
            poll_path = write(["wrapper", "inputs", "poll.json"], json.dumps(poll, sort_keys=True))
        if data.get("trigger") == "pr_build_settled" and ctl.RUN_ID_RE.match(str(data.get("runId") or "")):
            # Kept until the controller journals the claim, so a fire killed
            # between the poll and the step does not lose the wake's fields.
            write(["wrapper", "wakes", data["runId"] + ".json"], json.dumps(poll, sort_keys=True))
    states, bad = gate_states()
    active = {st["activeRunId"]: pr for pr, st in states.items() if isinstance(st.get("activeRunId"), str)}
    if not (isinstance(poll, dict) and (poll.get("data") or {}).get("trigger") == "pr_build_settled"):
        journaled = {ob["runId"] for ob in folded.values() if ob.get("kind") == "run"}
        for run_id in sorted(active):
            saved = os.path.join(WRAP, "wakes", run_id + ".json")
            if run_id not in journaled and os.path.isfile(saved):
                poll_path = saved
                summary["replayedWake"] = run_id
                break

    # -- inputs ---------------------------------------------------------------------
    input_errors = []
    open_runs = {ob["runId"] for ob in folded.values()
                 if ob.get("kind") == "run" and ob.get("state") not in ("done", "abandoned")}
    # Heads only for runs this controller may act on: legacy runs (the
    # cutover list) are never stepped, so their PRs are none of its business.
    cut_doc, _ = read_json(cutover)
    legacy = set((cut_doc or {}).get("legacyRuns") or []) if isinstance(cut_doc, dict) else set()
    prs = sorted({pr for run_id, pr in active.items()
                  if run_id not in legacy and states.get(pr, {}).get("activeClaimant") == "controller"} |
                 {ob["detail"].get("pr") for ob in folded.values()
                  if ob.get("kind") == "run" and ob.get("runId") in open_runs and ob["detail"].get("pr")})
    heads = {}
    for pr in prs:
        rc, out, err = run(GH.split() + ["pr", "view", str(pr), "-R", REPO, "--json", "headRefOid"], 15, CHILD_ENV)
        try:
            doc = json.loads(out) if rc == 0 else None
        except ValueError:
            doc = None
        if not isinstance(doc, dict) or not re.match(r"^[0-9a-f]{40}$", str(doc.get("headRefOid"))):
            input_errors.append("gh pr view {}: rc={} {}".format(pr, rc, (err or "").strip()[:120]))
            continue
        heads[str(pr)] = doc["headRefOid"]
    tasks = []
    if any(ob.get("kind") == "dispatch" and ob.get("state") == "intent" and not ob["detail"].get("ambiguous")
           for ob in folded.values()):
        rc, out, err = run(NCL.split() + ["tasks", "list", "--json"], 35, CHILD_ENV)
        try:
            resp = json.loads(out) if rc == 0 else None
        except ValueError:
            resp = None
        if not isinstance(resp, dict) or resp.get("ok") is not True or not isinstance(resp.get("data"), list):
            input_errors.append("ncl tasks list: rc={} {}".format(rc, (err or "").strip()[:120]))
        else:
            tasks = [{"id": t.get("series_id"), "name": t.get("series_id"), "status": t.get("status")}
                     for t in resp["data"] if isinstance(t, dict)]
    # Delivery receipts for enqueued sends: the host writes them into this
    # session's inbound.db `delivered` table (container/agent-runner/src/db/
    # delivery-acks.ts); 'pending' is not an answer yet.
    receipts = {}
    ids = [ob["detail"].get("messageId") for ob in folded.values()
           if ob.get("kind") == "send" and ob.get("state") == "enqueued" and ob["detail"].get("messageId")]
    if ids:
        try:
            conn = sqlite3.connect("file:{}?mode=ro".format(INBOUND_DB), uri=True, timeout=5)
            try:
                for i in range(0, len(ids), 200):
                    chunk = ids[i:i + 200]
                    rows = conn.execute("SELECT message_out_id, status FROM delivered WHERE message_out_id IN ({})"
                                        .format(",".join("?" * len(chunk))), chunk).fetchall()
                    receipts.update({mid: st for mid, st in rows if st in ("delivered", "failed")})
            finally:
                conn.close()
        except sqlite3.Error as exc:
            # A missing receipt only waits; it never advances an attempt.
            log("receipts unreadable ({}); enqueued sends wait".format(exc))
    if input_errors:
        for e in input_errors:
            log("input fetch failed: " + e)
        end_fire({"skipped": "input fetch failed", "inputErrors": len(input_errors)}, failure="input-fetch-failed")
    heads_path = write(["wrapper", "inputs", "pr-heads.json"], json.dumps(heads, sort_keys=True))
    tasks_path = write(["wrapper", "inputs", "tasks.json"], json.dumps(tasks))
    receipts_path = write(["wrapper", "inputs", "receipts.json"], json.dumps(receipts, sort_keys=True))

    # -- the step ---------------------------------------------------------------------
    step_budget = remaining() - MARGIN
    if step_budget < 15:
        end_fire({"skipped": "budget too small for the step ({:.0f}s left)".format(remaining())},
                 failure="budget-exhausted")
    argv = ["python3", CTL, "step", "--out-dir", OUT, "--gate-state-dir", STATE_DIR, "--run-root", RUN_ROOT,
            "--pr-heads-json", heads_path, "--tasks-json", tasks_path, "--receipts-json", receipts_path,
            "--cutover-json", cutover, "--repo", REPO, "--send-to", SEND_TO, "--gate-cmd", GATE_CMD,
            "--gh-cmd", GH, "--ncl-cmd", NCL, "--enqueue-cmd", ENQUEUE, "--fire", FIRE, "--lock-timeout", "5",
            "--deadline-epoch", str(DEADLINE - MARGIN)]
    for flag, key in (("--critic-log", "SMOKE_CONTROLLER_CRITIC_LOG"),
                      ("--challenger-mention", "SMOKE_CONTROLLER_CHALLENGER_MENTION"),
                      ("--oneshot-model", "SMOKE_CONTROLLER_ONESHOT_MODEL"),
                      ("--oneshot-effort", "SMOKE_CONTROLLER_ONESHOT_EFFORT")):
        if os.environ.get(key):
            argv += [flag, os.environ[key]]
    if poll_path:
        argv += ["--poll-json", poll_path]
    if alarm_queue():
        argv += ["--alarm-queue-dir", os.path.join(WRAP, "alarms")]
    rc, out, err = run(argv, step_budget, CHILD_ENV)
    summary["controllerRc"] = rc
    res = ctl.last_json_line(out) or {}
    if rc is None:
        log("controller step killed: {}".format(err))
        end_fire({"skipped": "controller step timed out", "stepped": False}, failure="step-timed-out")
    if rc != 0 or not res.get("ok"):
        end_fire({"stepped": False, "controllerError": res.get("alarm") or "rc={}".format(rc),
                "error": str(res.get("error") or (err or "").strip())[:300]}, failure="step-error")
    if res.get("skipped"):
        end_fire({"stepped": False, "skipped": "controller: " + str(res["skipped"])}, failure="step-skipped")
    # Queued alarms the journal now holds are drained (any state: a budget
    # refusal records nothing and so stays queued for the next fire).
    try:
        folded_after = fold_journal()
    except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError):
        folded_after = {}
    for name in alarm_queue():
        doc, _ = read_json(os.path.join(WRAP, "alarms", name))
        wake = doc.get("data") if isinstance(doc, dict) else None
        if not isinstance(wake, dict):
            continue
        pseudo, _, slot = ctl.gate_alarm_ids(wake, now)
        if ctl.obligation_key(pseudo, "send", slot) in folded_after:
            ctl.unlink_contained(OUT, ["wrapper", "alarms", name])
    summary["alarmsQueued"] = len(alarm_queue())
    # Settled claims no longer need their saved wake.
    for run_id in ctl.listdir_contained(OUT, ["wrapper", "wakes"]):
        rid = run_id[:-5]
        if rid not in active:
            ctl.unlink_contained(OUT, ["wrapper", "wakes", run_id])
    end_fire({"stepped": True, "runs": res.get("runs") or [], "decisions": res.get("decisions", 0),
            "effectsPerformed": res.get("effectsPerformed", 0),
            "alarms": sorted({a.get("trigger") for a in res.get("alarms") or [] if isinstance(a, dict)}),
            "ownerWake": res.get("ownerWake")}, ok="stepped")


try:
    main()
except Exception as exc:  # noqa: BLE001 -- every failure ends through end_fire
    end_fire({"stepped": False, "skipped": "fire failed: {}: {}".format(type(exc).__name__, exc)[:300]},
             failure="fire-failed")
