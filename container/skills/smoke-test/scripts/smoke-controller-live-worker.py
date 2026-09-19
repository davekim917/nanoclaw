#!/usr/bin/env python3
"""Worker for smoke-controller-live.sh: one LIVE fire of the smoke campaign
controller. Run only under that supervisor, which owns the hard kill and the
final stdout line; this prints one JSON summary line and exits 0.

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
CONFIG_KEYS = (
    "SMOKE_CONTROLLER_MODE", "SMOKE_CONTROLLER_OUT_DIR", "SMOKE_CONTROLLER_SEND_TO", "SMOKE_CONTROLLER_GATE_CMD",
    "SMOKE_CONTROLLER_CHALLENGER_MENTION", "SMOKE_CONTROLLER_CRITIC_LOG", "SMOKE_CONTROLLER_ONESHOT_MODEL",
    "SMOKE_CONTROLLER_ONESHOT_EFFORT", "SMOKE_CONTROLLER_POLL_TIMEOUT",
    "SMOKE_GATE_STATE_DIR", "SMOKE_GATE_RUN_ROOT", "SMOKE_GATE_REPO",
)
MARGIN = 3
STATE_RE = re.compile(r"^pr-(\d+)-state\.json$")
ASSIGN_RE = re.compile(r"""^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>()]*))\s*(?:#.*)?$""")
NAME_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
UNSET_RE = re.compile(r"^unset\s+([A-Za-z_][A-Za-z0-9_\s]*)$")

now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
FIRE = now.strftime("%Y-%m-%dT%H:%M:%SZ")
summary = {"mode": None, "fire": FIRE, "stepped": False}
log_lines = []
OUT = None
WRITABLE = False
CHILD = None
FINISHING = False
ctl = None


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


def on_term(signum, frame):
    if FINISHING:
        return
    if CHILD is not None:
        try:
            os.killpg(CHILD.pid, signal.SIGKILL)
        except OSError:
            pass
    finish({"stepped": False, "ownerWake": None, "skipped": "fire exceeded its budget and was killed"})


signal.signal(signal.SIGTERM, on_term)


def run(argv, timeout, env):
    """(rc, stdout, stderr); rc None = timed out / not runnable."""
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
    for CONFIG_KEYS count; anything else is ignored; a non-literal value for a
    key skips the fire."""
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


# -- config -----------------------------------------------------------------------
cfg, refused, cfg_err = load_config(ENV_FILE)
if cfg is None:
    finish({"skipped": "env file unreadable", "envFile": ENV_FILE, "error": cfg_err})
for k, v in cfg.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v
MODE = os.environ.get("SMOKE_CONTROLLER_MODE") or "shadow"
summary["mode"] = MODE
if MODE != "live":
    # Not live: nothing at all. The legacy PR gate task (or the shadow series)
    # owns this state; this wrapper must not poll, claim or post.
    finish({"skipped": "SMOKE_CONTROLLER_MODE is {!r}, not live: the live wrapper does nothing".format(MODE)})
if "SMOKE_GATE_CLAIMANT" in refused:
    finish({"skipped": "the env file names SMOKE_GATE_CLAIMANT: every gate caller sources it, so it would mark "
                       "legacy calls as the controller's. Remove it; this wrapper sets it per call.",
            "misconfigured": ["SMOKE_GATE_CLAIMANT"]})
if refused:
    finish({"skipped": "env file assigns a non-literal value", "refusedKeys": sorted(set(refused))})
STATE_DIR = os.environ.get("SMOKE_GATE_STATE_DIR", "")
RUN_ROOT = os.environ.get("SMOKE_GATE_RUN_ROOT", "")
REPO = os.environ.get("SMOKE_GATE_REPO", "")
SEND_TO = os.environ.get("SMOKE_CONTROLLER_SEND_TO", "")
GATE_CMD = os.environ.get("SMOKE_CONTROLLER_GATE_CMD") or "/workspace/agent/smoke-pr-gate.sh"
POLL_TIMEOUT = int(os.environ.get("SMOKE_CONTROLLER_POLL_TIMEOUT") or 45) \
    if (os.environ.get("SMOKE_CONTROLLER_POLL_TIMEOUT") or "45").isdigit() else 45
missing = [n for n, v in (("SMOKE_GATE_STATE_DIR", STATE_DIR), ("SMOKE_GATE_RUN_ROOT", RUN_ROOT),
                          ("SMOKE_GATE_REPO", REPO), ("SMOKE_CONTROLLER_SEND_TO", SEND_TO)) if not v]
if missing:
    finish({"skipped": "live needs " + ", ".join(missing), "misconfigured": missing})
if not os.path.isfile(GATE_CMD):
    finish({"skipped": "gate wrapper {} is not a file".format(GATE_CMD), "misconfigured": ["SMOKE_CONTROLLER_GATE_CMD"]})
if not os.path.isdir(STATE_DIR):
    finish({"skipped": "SMOKE_GATE_STATE_DIR is not a directory", "inputErrors": 1})
OUT = os.path.abspath(os.environ.get("SMOKE_CONTROLLER_OUT_DIR") or
                      os.path.join(os.path.dirname(RUN_ROOT.rstrip("/")), "controller"))
for root, name in ((STATE_DIR, "gate state dir"), (RUN_ROOT, "run root")):
    if under(OUT, root) or under(root, OUT):
        finish({"skipped": "out-dir overlaps the {}".format(name)})
if remaining() < 20:
    finish({"skipped": "budget exhausted before start"})

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
        os.mkdir(OUT, 0o755)
        st = os.lstat(OUT)
    if not stat.S_ISDIR(st.st_mode):
        raise ctl.ControllerError("out-dir is not a real directory (symlink?)")
    ctl.write_contained_atomic(OUT, ["wrapper", ".probe"], "")
except (OSError, ctl.ControllerError) as exc:
    finish({"skipped": "out-dir refused: {}".format(exc)})
WRAP = os.path.join(OUT, "wrapper")
WRITABLE = True
try:
    lock_fd = ctl.open_contained(OUT, ["wrapper", "wrapper.lock"], os.O_RDWR | os.O_CREAT)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    finish({"skipped": "another live fire holds wrapper.lock"})
except (OSError, ctl.ControllerError) as exc:
    WRITABLE = False
    finish({"skipped": "wrapper.lock refused: {}".format(exc)})

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
                finish({"skipped": "controller init did not complete", "controllerRc": rc,
                        "error": ((out or "") + (err or "")).strip()[-300:]})
            summary["initialized"] = True
        write(["wrapper", "initialized"], FIRE + "\n")

    # -- cutover: once, BEFORE this controller's first poll ------------------------
    cutover = os.path.join(OUT, "cutover.json")
    states, bad = gate_states()
    if not os.path.lexists(cutover):
        if bad:
            finish({"skipped": "cannot write the cutover: gate state unreadable ({})".format(", ".join(bad))})
        legacy = sorted(st["activeRunId"] for st in states.values()
                        if isinstance(st.get("activeRunId"), str) and st.get("activeClaimant") != "controller")
        ctl.write_contained_once(OUT, ["cutover.json"], json.dumps(
            {"schemaVersion": 1, "flippedAt": FIRE, "legacyRuns": legacy}, sort_keys=True) + "\n")
        summary["cutover"] = {"legacyRuns": legacy}

    # -- keep our claims live, then poll (the poll may reclaim a stale run) --------
    try:
        folded = fold_journal()
    except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError) as exc:
        log("journal not readable for input planning ({}); controller will decide".format(exc))
        folded = {}
    tokens = {ob["runId"]: ob["detail"].get("ownerToken") for ob in folded.values()
              if ob.get("kind") == "run" and ob.get("slot") == "claim" and ob.get("state") not in ("done", "abandoned")}
    for st in states.values():
        run_id = st.get("activeRunId")
        if st.get("activeClaimant") == "controller" and tokens.get(run_id) and \
                tokens[run_id] == st.get("activeLeaseOwner"):
            rc, out, err = run(["bash", GATE_CMD, "progress", run_id, tokens[run_id]], 20, GATE_ENV)
            if not (ctl.last_json_line(out) or {}).get("ok"):
                log("progress stamp for {} failed: {}".format(run_id, (err or out or "").strip()[:120]))
    rc, out, err = run(["bash", GATE_CMD, "poll"], POLL_TIMEOUT, GATE_ENV)
    poll = ctl.last_json_line(out) if rc is not None else None
    poll_path = None
    if isinstance(poll, dict):
        poll_path = write(["wrapper", "inputs", "poll.json"], json.dumps(poll, sort_keys=True))
        data = poll.get("data") if isinstance(poll.get("data"), dict) else {}
        summary["pollTrigger"] = data.get("trigger")
        if data.get("trigger") == "pr_build_settled" and ctl.RUN_ID_RE.match(str(data.get("runId") or "")):
            # Kept until the controller journals the claim, so a fire killed
            # between the poll and the step does not lose the wake's fields.
            write(["wrapper", "wakes", data["runId"] + ".json"], json.dumps(poll, sort_keys=True))
    else:
        log("gate poll gave no result: rc={} {}".format(rc, (err or "").strip()[:160]))
        summary["pollError"] = True
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
        finish({"skipped": "input fetch failed", "inputErrors": len(input_errors)})
    heads_path = write(["wrapper", "inputs", "pr-heads.json"], json.dumps(heads, sort_keys=True))
    tasks_path = write(["wrapper", "inputs", "tasks.json"], json.dumps(tasks))
    receipts_path = write(["wrapper", "inputs", "receipts.json"], json.dumps(receipts, sort_keys=True))

    # -- the step ---------------------------------------------------------------------
    step_budget = remaining() - MARGIN
    if step_budget < 15:
        finish({"skipped": "budget too small for the step ({:.0f}s left)".format(remaining())})
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
    rc, out, err = run(argv, step_budget, CHILD_ENV)
    summary["controllerRc"] = rc
    res = ctl.last_json_line(out) or {}
    if rc is None:
        log("controller step killed: {}".format(err))
        finish({"skipped": "controller step timed out", "stepped": False})
    if rc != 0 or not res.get("ok"):
        finish({"stepped": False, "controllerError": res.get("alarm") or "rc={}".format(rc),
                "error": str(res.get("error") or (err or "").strip())[:300]})
    if res.get("skipped"):
        finish({"stepped": False, "skipped": "controller: " + str(res["skipped"])})
    # Settled claims no longer need their saved wake.
    for run_id in list(os.listdir(os.path.join(WRAP, "wakes")) if os.path.isdir(os.path.join(WRAP, "wakes")) else []):
        rid = run_id[:-5]
        if rid not in active:
            try:
                os.unlink(os.path.join(WRAP, "wakes", run_id))
            except OSError:
                pass
    finish({"stepped": True, "runs": res.get("runs") or [], "decisions": res.get("decisions", 0),
            "effectsPerformed": res.get("effectsPerformed", 0),
            "alarms": sorted({a.get("trigger") for a in res.get("alarms") or [] if isinstance(a, dict)}),
            "ownerWake": res.get("ownerWake")})


try:
    main()
except (OSError, ctl.ControllerError) as exc:
    finish({"stepped": False, "skipped": "containment or IO refused: {}".format(exc)[:300]})
