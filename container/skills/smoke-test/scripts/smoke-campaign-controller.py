#!/usr/bin/env python3
"""Durable PR smoke-campaign controller -- SHADOW ONLY in this revision.

One fire = one `step`: read gate state, run artifacts and the obligation
journal; derive each run's phase; decide the next mechanical action; journal
the intent BEFORE the action; hand the action to the effect layer; journal the
outcome. The model is woken only for judgment (owner steps, fresh critic).
Spec: jev-smoke-sweep/CONTROLLER-SPEC.md rev 3 (s2 design, s3 shadow).

SHADOW IS A HARD PROPERTY, NOT A CONVENTION. Every external effect -- a chat
send, a GitHub write, an `ncl tasks create`, a gate verb -- goes through
EffectLayer.perform(), and the only EffectLayer this file contains refuses
every effect and returns `shadow_refused`. There is no live implementation to
switch to: any SMOKE_CONTROLLER_MODE other than off|shadow is refused at
startup (exit 3), and `--shadow` forces shadow whatever the env says. Subprocesses are limited to READ_ONLY_COMMANDS (the evidence barrier,
which only reads -- smoke-evidence-barrier.sh has no write path, and the
`smoke-journeys.py barrier` it calls reads only; its sole writer
`_write_atomic` serves `pin-run`/`match`). The controller's own writes are its
shadow journal, its decisions log, and its lock file, all under --out-dir.

Journal (append-only ndjson, fsync'd, under <out-dir>/control.lock):
  {v, at, fire, runId, kind, slot, key, state, attempt, detail}
  key   = sha256(runId|kind|slot)            -- one obligation
  state = intent|enqueued|delivered|done|abandoned|failed|failed_terminal
  A missing, unreadable or unparsable journal is a HARD ERROR (exit 3): no
  action, one alarm line on stdout. `init` creates an empty journal once.

synthesis.json (the owner's machine-readable verdict; new contract, s2):
  {schemaVersion:1, runId, sourceSha, verdict: GO|NO_GO|HUMAN_DECISION|BLOCKED,
   laneGenerations:{<laneId>:<gen>},
   findings:[{id, blocking:bool, confirmed:bool, disposition}],
   gaps:[{lane, disposition}], dissents:[{id, disposition}]}
  A closed disposition is `fixed-verified`, `not-blocking:<reason>` or
  `refuted:<run-relative evidence path>` (nonempty regular file in the run).
  The controller enumerates gaps, confirmed findings and dissent ITSELF
  (markers, contract, challenger/challenge.complete.json) and requires the
  synthesis to disposition each; it never trusts the synthesis' own list as
  complete. Anything short of that maps GO to BLOCKED naming the failed check.

challenger/challenge.complete.json dissent inventory (new contract, s2):
  {..., disposition: CLEAR|<other>, dissents:[<id> | {id}]}
  The authoritative list of dissent ids. Every id needs a closed disposition
  in synthesis.dissents. A non-CLEAR challenger with no readable inventory
  (absent, not a list, an empty or duplicate id) is BLOCKED: completeness
  cannot be established. Today's challenger writes only prose
  (challenger/disposition.md), so no historical run can reach GO past a
  non-CLEAR challenger.

Path containment: runIds must start with an alphanumeric (no `.`/`..`), and
every controller write (journal, lock, decisions) is opened relative to a
directory fd with O_NOFOLLOW and checked to resolve under --out-dir.

Test-only fault injection: SMOKE_CONTROLLER_CRASH_AT=<point>[:<kind>[:<slot>]]
exits 137 at that point (points: before-run-record, after-run-record,
after-intent, after-effect, after-run-done).
"""

import argparse
import datetime as dt
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BARRIER = os.path.join(SCRIPT_DIR, "smoke-evidence-barrier.sh")
READ_ONLY_COMMANDS = {("bash", BARRIER)}
# In-process seam for the offline replay harness only: a callable
# (run_dir, phase) -> barrier dict. The CLI never sets it. The replay needs it
# because today's barrier refuses every historical PR contract before reading a
# lane (pre-identity schemaVersion 1, smoke-journeys.py:1025).
BARRIER_OVERRIDE = None

JOURNAL_VERSION = 1
STATES = {"intent", "enqueued", "delivered", "done", "abandoned", "failed", "failed_terminal"}
TERMINAL_OK = {"done", "delivered"}
MAX_SEND_ATTEMPTS = 3

# Controller-send budget. Measured over the 30 finished PR campaigns of
# 2026-09-05..18 (gate agent outbound.db, chat rows naming the PR or run id, claim-5m
# to finish+2h): per campaign p50 3, max 12 (pr1896, incl. human-thread
# replies); max 4 inside any 10-minute window (one */10 fire), in 2/30 runs
# (pr1553, pr1686). Per-run and per-fire budgets sit at/above the measured
# maxima so the budget never throttles a burst the legacy coordinator really
# made; the per-fingerprint cap is the spec's (a third alarm for one cause is
# the overdue path's job, not another post).
BUDGET_PER_FIRE = 4
BUDGET_PER_RUN = 15
BUDGET_PER_FINGERPRINT = 2

TERMINAL_VERBS = ("finish", "challenger-timeout")
POST_FINISH_SLOTS = ("freeze-close",)
# Journal kinds whose obligations must all be receipted before a GO finish.
PRE_FINISH_KINDS = ("send", "gh", "dispatch")
OWNER_STEP_SLA_SECONDS = 3600
CRITIC_WAIT_SECONDS = 1200
# The fresh critic's machine-readable output (new contract; its brief asks for
# {screens:[{screen, grade, reason}]}). Today its lines live only in
# run-record.md prose and the workgroup design-critic-log.ndjson.
CRITIC_ARTIFACT = "contact-sheet/critic.json"
POST_FINISH_SLA_SECONDS = 3600
CLOSED_DISPOSITION = re.compile(r"^(fixed-verified|not-blocking:.+|refuted:.+)$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# First character alphanumeric: `.`, `..` and dot-files are never run ids, so a
# run id can never name a directory outside --out-dir or --run-root.
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
VERDICTS = {"GO", "NO_GO", "HUMAN_DECISION", "BLOCKED"}
PASS_STATUSES = {"pass"}


class ControllerError(Exception):
    """Fail-closed hard error: no action this fire, non-zero exit, one alarm."""


class JournalError(ControllerError):
    """The journal is missing, unreadable, torn or unparsable: never 'empty'."""


# ---------------------------------------------------------------------------
# small helpers


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None


def obligation_key(run_id, kind, slot):
    return hashlib.sha256("{}|{}|{}".format(run_id, kind, slot).encode()).hexdigest()


def send_id(key, attempt):
    return "{}#{}".format(key, attempt)


def crash_point(point, kind="", slot=""):
    spec = os.environ.get("SMOKE_CONTROLLER_CRASH_AT", "")
    if not spec:
        return
    parts = spec.split(":", 2)
    if parts[0] != point:
        return
    if len(parts) > 1 and parts[1] and parts[1] != kind:
        return
    if len(parts) > 2 and parts[2] and parts[2] != slot:
        return
    sys.stdout.flush()
    os._exit(137)


def read_json_file(path):
    """(value, error). error is None only for a parsed document."""
    try:
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8")), None
    except FileNotFoundError:
        return None, "missing"
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        return None, "unreadable: {}".format(exc)


def nonempty_file(path):
    try:
        return os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) > 0
    except OSError:
        return False


def safe_run_relative(run_dir, rel):
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\n" in rel:
        return False
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return False
    full = os.path.join(run_dir, rel)
    try:
        real_root = os.path.realpath(run_dir)
        real = os.path.realpath(full)
    except OSError:
        return False
    return real.startswith(real_root + os.sep) and nonempty_file(full)


# ---------------------------------------------------------------------------
# contained writes


def _contained(fd, root):
    """The opened fd must resolve under root (Linux /proc; refused elsewhere)."""
    try:
        real = os.readlink("/proc/self/fd/{}".format(fd))
    except OSError as exc:
        raise ControllerError("cannot verify where a controller write resolves: {}".format(exc))
    real_root = os.path.realpath(root)
    if real != real_root and not real.startswith(real_root + os.sep):
        raise ControllerError("controller write resolved outside {}: {}".format(real_root, real))


def open_contained(root, parts, flags, mode=0o644, make_dirs=False):
    """Open root/<parts...> without following a symlink at any component
    below root, and verify the result resolves under root. Returns an fd."""
    for part in parts:
        if not part or part in (".", "..") or "/" in part:
            raise ControllerError("refusing unsafe path component {!r}".format(part))
    dfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            if make_dirs:
                try:
                    os.mkdir(part, 0o755, dir_fd=dfd)
                except FileExistsError:
                    pass
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
            except OSError as exc:
                raise ControllerError("refusing controller path {}/{}: {}".format(root, part, exc))
            os.close(dfd)
            dfd = nxt
        try:
            fd = os.open(parts[-1], flags | os.O_NOFOLLOW, mode, dir_fd=dfd)
        except FileNotFoundError:
            raise
        except FileExistsError:
            raise
        except OSError as exc:
            raise ControllerError("refusing controller file {}/{}: {}".format(root, "/".join(parts), exc))
    finally:
        os.close(dfd)
    try:
        _contained(fd, root)
        # A hard link passes O_NOFOLLOW and resolves under root, yet writes an
        # inode shared with a file elsewhere: only a regular file with exactly
        # one link is ours to write.
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ControllerError("refusing controller file {}/{}: not a regular file".format(root, "/".join(parts)))
        if st.st_nlink != 1:
            raise ControllerError("refusing controller file {}/{}: {} hard links (must be 1)".format(
                root, "/".join(parts), st.st_nlink))
    except ControllerError:
        os.close(fd)
        raise
    return fd


# ---------------------------------------------------------------------------
# journal


class Journal:
    def __init__(self, out_dir):
        self.dir = out_dir
        self.path = os.path.join(out_dir, "journal.ndjson")
        self.lock_path = os.path.join(out_dir, "control.lock")
        self.records = []
        self._obs = {}
        self._lock_fd = None

    def lock(self, timeout=30.0):
        os.makedirs(self.dir, exist_ok=True)
        self._lock_fd = open_contained(self.dir, ["control.lock"], os.O_RDWR | os.O_CREAT)
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError as exc:
                if exc.errno not in (errno.EAGAIN, errno.EACCES):
                    raise
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.2)

    def unlock(self):
        # flock is held per open file description: a caller that runs main()
        # twice in one process (the replay) would otherwise block on itself.
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None

    def load(self):
        try:
            fd = open_contained(self.dir, ["journal.ndjson"], os.O_RDONLY)
            with os.fdopen(fd, "rb") as fh:
                raw = fh.read()
        except ControllerError as exc:
            raise JournalError("journal at {} refused: {}".format(self.path, exc))
        except FileNotFoundError:
            raise JournalError("journal missing at {} -- refusing to treat it as empty (run `init` once to create it)".format(self.path))
        except OSError as exc:
            raise JournalError("journal unreadable at {}: {}".format(self.path, exc))
        if raw and not raw.endswith(b"\n"):
            raise JournalError("journal {} ends in a torn (unterminated) record -- refusing to act".format(self.path))
        records = []
        for n, line in enumerate(raw.split(b"\n"), 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                raise JournalError("journal {} line {} is unparsable: {}".format(self.path, n, exc))
            if (not isinstance(rec, dict) or rec.get("v") != JOURNAL_VERSION or rec.get("state") not in STATES
                    or not isinstance(rec.get("key"), str) or not isinstance(rec.get("runId"), str)):
                raise JournalError("journal {} line {} is not a valid v{} record".format(self.path, n, JOURNAL_VERSION))
            records.append(rec)
        self.records = []
        self._obs = {}
        for rec in records:
            self._fold(rec)

    def init(self):
        os.makedirs(self.dir, exist_ok=True)
        try:
            fd = open_contained(self.dir, ["journal.ndjson"], os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            raise JournalError("journal already exists at {} -- init never truncates".format(self.path))
        os.fsync(fd)
        os.close(fd)
        self._fsync_dir()

    def _fsync_dir(self):
        dfd = os.open(self.dir, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)

    def append(self, rec):
        rec = dict(rec)
        rec["v"] = JOURNAL_VERSION
        line = (json.dumps(rec, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        fd = open_contained(self.dir, ["journal.ndjson"], os.O_WRONLY | os.O_APPEND)
        try:
            os.write(fd, line)
            os.fsync(fd)
        finally:
            os.close(fd)
        self._fold(rec)
        return rec

    # folded view -----------------------------------------------------------

    def _fold(self, rec):
        self.records.append(rec)
        ob = self._obs.setdefault(rec["key"], {
            "key": rec["key"], "runId": rec["runId"], "kind": rec.get("kind"), "slot": rec.get("slot"),
            "state": None, "attempt": 0, "history": [], "detail": {},
        })
        ob["history"].append(rec)
        ob["state"] = rec["state"]
        if rec.get("attempt"):
            ob["attempt"] = max(ob["attempt"], int(rec["attempt"]))
        if isinstance(rec.get("detail"), dict):
            ob["detail"].update(rec["detail"])

    def obligations(self):
        """key -> folded obligation (latest state, max attempt, merged detail)."""
        return self._obs

    def runs(self):
        return sorted({ob["runId"] for ob in self._obs.values()})


# ---------------------------------------------------------------------------
# effect layer -- the single choke point for external effects


class EffectLayer:
    """PR 1: shadow only. perform() never executes anything."""

    def __init__(self, mode):
        if mode != "shadow":
            raise ControllerError("mode {!r} is not implemented: this build is shadow-only".format(mode))
        self.mode = mode
        self.performed = []

    def perform(self, effect):
        # The would-be effect is recorded, never run. No subprocess, no socket,
        # no file outside --out-dir is touched on this path.
        self.performed.append(effect)
        return {"outcome": "shadow_refused"}


def run_read_only(argv, timeout=60):
    if (argv[0], argv[1]) not in READ_ONLY_COMMANDS:
        raise ControllerError("refusing to run non-allowlisted command: {}".format(argv[:2]))
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, str(exc)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1]), None
    except (ValueError, IndexError):
        return None, "unparsable output (rc={})".format(proc.returncode)


# ---------------------------------------------------------------------------
# inputs


class GateView:
    """Read-only view over the PR gate's state dir."""

    def __init__(self, state_dir):
        self.dir = state_dir
        self.pr_states = {}
        self.errors = []
        self.error_prs = set()
        if not state_dir or not os.path.isdir(state_dir):
            raise ControllerError("gate state dir {!r} is not a directory".format(state_dir))
        for name in sorted(os.listdir(state_dir)):
            m = re.match(r"^pr-(\d+)-state\.json$", name)
            if not m:
                continue
            doc, err = read_json_file(os.path.join(state_dir, name))
            if err or not isinstance(doc, dict):
                self.errors.append("{}: {}".format(name, err or "not an object"))
                self.error_prs.add(int(m.group(1)))
                continue
            self.pr_states[int(m.group(1))] = doc

    def active_claims(self):
        """runId -> {pr, sha, deadline}"""
        out = {}
        for pr, st in self.pr_states.items():
            run = st.get("activeRunId")
            if run:
                out[run] = {"pr": pr, "sha": st.get("activeSha"), "deadline": st.get("challengerDeadline"),
                            "disposition": st.get("challengerDisposition")}
        return out

    def run_verdict(self, run_id):
        doc, err = read_json_file(os.path.join(self.dir, "runs", run_id, "verdict.json"))
        if err == "missing":
            return None
        if err:
            return {"error": err}
        return doc

    def pr_verdict(self, pr):
        doc, _ = read_json_file(os.path.join(self.dir, "pr-{}-verdict.json".format(pr)))
        return doc

    def pr_for_run(self, run_id):
        for pr, st in self.pr_states.items():
            if run_id in (st.get("activeRunId"), st.get("completedRunId")):
                return pr
        m = re.match(r".*-pr(\d+)-", run_id)
        return int(m.group(1)) if m else None


class RunView:
    """Read-only view over one run directory."""

    def __init__(self, run_root, run_id):
        self.run_id = run_id
        self.dir = os.path.join(run_root, run_id) if run_root else None
        self.exists = bool(self.dir) and os.path.isdir(self.dir)
        self.contract, self.contract_error = (None, "missing")
        if self.exists:
            self.contract, self.contract_error = read_json_file(os.path.join(self.dir, "completion-contract.json"))

    def path(self, rel):
        return os.path.join(self.dir, rel)

    def has(self, rel):
        return self.exists and nonempty_file(self.path(rel))

    def isdir(self, rel):
        return self.exists and os.path.isdir(self.path(rel))

    def required_lanes(self):
        c = self.contract or {}
        return [m for m in c.get("requiredLaneMarkers") or [] if isinstance(m, str)]

    def expected_generation(self, lane_id):
        for entry in (self.contract or {}).get("lanes") or []:
            if isinstance(entry, dict) and entry.get("id") == lane_id:
                return int(entry.get("generation") or 1)
        return 1

    def markers(self):
        out = {}
        for rel in self.required_lanes():
            lane = os.path.basename(rel)[:-5] if rel.endswith(".json") else os.path.basename(rel)
            doc, err = read_json_file(self.path(rel)) if self.exists else (None, "missing")
            out[lane] = {"rel": rel, "doc": doc if not err else None, "error": err}
        return out

    def challenge_complete(self):
        doc, err = read_json_file(self.path("challenger/challenge.complete.json")) if self.exists else (None, "missing")
        return doc if not err else None

    def synthesis(self):
        if not self.exists:
            return None, "missing"
        return read_json_file(self.path("synthesis.json"))

    def last_identity_check(self):
        if not self.has("coordinator/identity-checks.ndjson"):
            return None
        try:
            with open(self.path("coordinator/identity-checks.ndjson"), "rb") as fh:
                lines = [ln for ln in fh.read().decode("utf-8", "replace").splitlines() if ln.strip()]
            return json.loads(lines[-1]) if lines else None
        except (OSError, ValueError):
            return {"verdict": "unreadable"}

    def barrier(self, phase):
        if not self.exists:
            return {"ready": False, "missing": ["<run dir>"], "invalid": []}
        if BARRIER_OVERRIDE is not None:
            return BARRIER_OVERRIDE(self.dir, phase)
        doc, err = run_read_only(["bash", BARRIER, self.dir, phase])
        if err or not isinstance(doc, dict):
            return {"ready": False, "missing": [], "invalid": ["barrier"], "invalidReasons": ["barrier did not run: {}".format(err)]}
        return doc


# ---------------------------------------------------------------------------
# verdict validation (no false clear)


def dissent_inventory(challenge):
    """(ids, error). The challenger's own list of dissent ids is authoritative;
    the synthesis' list is never taken as complete. A non-CLEAR challenger
    without a readable inventory fails closed."""
    raw = challenge.get("dissents")
    clear = challenge.get("disposition") == "CLEAR"
    if raw is None:
        if clear:
            return [], None
        return [], "challenger {} with no dissent inventory (challenge.complete.json dissents[])".format(
            challenge.get("disposition"))
    if not isinstance(raw, list):
        return [], "challenger dissent inventory is not a list"
    ids = []
    for item in raw:
        did = item.get("id") if isinstance(item, dict) else item
        if not isinstance(did, str) or not did.strip():
            return [], "challenger dissent inventory has an entry with no id"
        if did in ids:
            return [], "challenger dissent inventory repeats id {}".format(did)
        ids.append(did)
    if not clear and not ids:
        return [], "challenger {} with an empty dissent inventory".format(challenge.get("disposition"))
    return ids, None


def validate_synthesis(run, claim_sha, pr_head, synthesis_barrier, identity):
    """Returns (verdict, failed_checks). GO only when every check passes."""
    doc, err = run.synthesis()
    if err:
        return "BLOCKED", ["synthesis.json {}".format(err)]
    failed = []
    if not isinstance(doc, dict) or doc.get("schemaVersion") != 1:
        return "BLOCKED", ["synthesis.json is not schemaVersion 1"]
    proposed = doc.get("verdict")
    if proposed not in VERDICTS:
        return "BLOCKED", ["synthesis.json verdict {!r} is not a legal verdict".format(proposed)]
    contract_sha = (run.contract or {}).get("sourceSha")
    # Binding checks apply to every verdict: a stale synthesis is BLOCKED
    # whatever it proposes.
    if doc.get("runId") != run.run_id:
        failed.append("runId: synthesis names {!r}, run is {!r}".format(doc.get("runId"), run.run_id))
    shas = {"synthesis": doc.get("sourceSha"), "contract": contract_sha, "claim": claim_sha}
    if not all(isinstance(v, str) and SHA_RE.match(v) for v in shas.values()) or len(set(shas.values())) != 1:
        failed.append("sourceSha binding: {}".format(shas))
    if pr_head is None:
        failed.append("pr head unverified (no current PR head supplied)")
    elif pr_head != claim_sha:
        failed.append("pr head {} moved off the frozen sha {}".format(pr_head, claim_sha))
    gens = doc.get("laneGenerations") if isinstance(doc.get("laneGenerations"), dict) else {}
    for lane in run.markers():
        want = run.expected_generation(lane)
        if gens.get(lane) != want:
            failed.append("evidence generation: lane {} synthesis={} contract={}".format(lane, gens.get(lane), want))
    if failed:
        return "BLOCKED", failed
    if proposed != "GO":
        return proposed, []

    # GO-only checks: readiness, identity, and a closed disposition for every
    # gap, confirmed finding and dissent the controller enumerates itself.
    if not synthesis_barrier.get("ready"):
        failed.append("synthesis barrier not ready: missing={} invalid={}".format(
            synthesis_barrier.get("missing"), synthesis_barrier.get("invalid")))
    if not identity or identity.get("verdict") != "ok":
        failed.append("pair identity not ok (last check: {})".format((identity or {}).get("verdict", "none")))

    def closed(value):
        return isinstance(value, str) and CLOSED_DISPOSITION.match(value) and (
            not value.startswith("refuted:") or safe_run_relative(run.dir, value[len("refuted:"):]))

    gap_disp = {g.get("lane"): g.get("disposition") for g in doc.get("gaps") or [] if isinstance(g, dict)}
    finding_disp = {f.get("id"): f for f in doc.get("findings") or [] if isinstance(f, dict)}
    confirmed_ids = set()
    for lane, m in run.markers().items():
        status = (m["doc"] or {}).get("status")
        if status not in PASS_STATUSES and not closed(gap_disp.get(lane)):
            failed.append("gap: lane {} is {} with no closed disposition".format(lane, status or m["error"]))
        for fid in (m["doc"] or {}).get("confirmedFindings") or []:
            confirmed_ids.add(fid)
    for fid, f in finding_disp.items():
        if f.get("blocking") or f.get("confirmed"):
            confirmed_ids.add(fid)
    for fid in sorted(confirmed_ids, key=str):
        f = finding_disp.get(fid) or {}
        if not closed(f.get("disposition")):
            failed.append("finding {} has no closed disposition".format(fid))
    challenge = run.challenge_complete()
    if challenge is None:
        failed.append("challenger outcome not machine-readable (challenger/challenge.complete.json missing)")
    else:
        inventory, inv_err = dissent_inventory(challenge)
        if inv_err:
            failed.append(inv_err)
        dissent_disp = {}
        for d in doc.get("dissents") or []:
            if isinstance(d, dict) and isinstance(d.get("id"), str):
                dissent_disp.setdefault(d["id"], d.get("disposition"))
        for did in inventory:
            if not closed(dissent_disp.get(did)):
                failed.append("dissent {} has no closed disposition".format(did))
    if failed:
        return "BLOCKED", failed
    return "GO", []


# ---------------------------------------------------------------------------
# the step engine


class Controller:
    def __init__(self, args, journal, gate, effects, now, fire):
        self.args = args
        self.journal = journal
        self.gate = gate
        self.effects = effects
        self.now = now
        self.fire = fire
        self.decisions = []
        self.alarms = []
        # Obligation keys whose intent THIS process journaled and has not yet
        # attempted. Never inferred from the journal: an intent that existed
        # when the process started may have been attempted by a fire that died
        # (same fire id or not), so it always goes through reconciliation.
        self.planned = set()
        self.fire_sends = {}
        self.receipts = self._load_json_arg(args.receipts_json, {})
        self.tasks = self._load_json_arg(args.tasks_json, [])
        self.pr_heads = {str(k): v for k, v in self._load_json_arg(args.pr_heads_json, {}).items()}
        self.poll = self._load_json_arg(args.poll_json, None)

    @staticmethod
    def _load_json_arg(path, default):
        if not path:
            return default
        doc, err = read_json_file(path)
        if err:
            raise ControllerError("input {} {}".format(path, err))
        return doc

    # -- journal/decision primitives ----------------------------------------

    def obligations(self):
        return self.journal.obligations()

    def record(self, run_id, kind, slot, state, attempt=None, detail=None):
        rec = {"at": iso(self.now), "fire": self.fire, "runId": run_id, "kind": kind, "slot": slot,
               "key": obligation_key(run_id, kind, slot), "state": state, "mode": self.effects.mode}
        if attempt:
            rec["attempt"] = attempt
        if detail:
            rec["detail"] = detail
        return self.journal.append(rec)

    def decide(self, run_id, phase, dtype, cls, reason, **extra):
        d = {"at": iso(self.now), "fire": self.fire, "runId": run_id, "phase": phase, "type": dtype,
             "class": cls, "reason": reason, "mode": self.effects.mode}
        d.update(extra)
        self.decisions.append(d)
        # Appended and fsync'd as it is made, so a fire killed mid-way still
        # leaves the decisions it reached (the shadow's whole output).
        append_decision(self.journal.dir, d)
        return d

    def alarm(self, run_id, trigger, fingerprint, detail, send=True):
        a = {"trigger": trigger, "runId": run_id, "fingerprint": fingerprint, "detail": detail}
        self.alarms.append(a)
        self.decide(run_id, None, "alarm", "mechanical", trigger, fingerprint=fingerprint, detail=detail)
        if send:
            self.send(run_id, "alarm", "alarm:{}".format(fingerprint), fingerprint=fingerprint)

    # -- effects ------------------------------------------------------------

    def _budget_refusal(self, run_id, fingerprint):
        obs = [o for o in self.obligations().values() if o["runId"] == run_id and o["kind"] == "send"]
        sent_attempts = sum(o["attempt"] for o in obs)
        if self.fire_sends.get(run_id, 0) >= BUDGET_PER_FIRE:
            return "per-fire budget {} reached".format(BUDGET_PER_FIRE)
        if sent_attempts >= BUDGET_PER_RUN:
            return "per-run budget {} reached".format(BUDGET_PER_RUN)
        if fingerprint:
            same = [o for o in obs if o["detail"].get("fingerprint") == fingerprint]
            if sum(o["attempt"] for o in same) >= BUDGET_PER_FINGERPRINT:
                return "per-fingerprint budget {} reached for {}".format(BUDGET_PER_FINGERPRINT, fingerprint)
        return None

    def send(self, run_id, phase, slot, fingerprint=None):
        """Chat send obligation with attempt-scoped ids and receipt recovery."""
        key = obligation_key(run_id, "send", slot)
        ob = self.obligations().get(key)
        if ob and ob["state"] in TERMINAL_OK | {"abandoned", "failed_terminal"}:
            return ob["state"]
        attempt = ob["attempt"] if ob else 0
        if ob and ob["state"] == "enqueued":
            mid = send_id(key, attempt)
            receipt = self.receipts.get(mid)
            if receipt == "delivered":
                self.record(run_id, "send", slot, "delivered", attempt, {"messageId": mid})
                return "delivered"
            if receipt != "failed":
                # A missing receipt is ambiguous and waits; only a definitive
                # failed receipt advances the attempt.
                self.decide(run_id, phase, "wait", "wait", "awaiting delivery receipt", slot=slot, messageId=mid)
                return "enqueued"
            self.record(run_id, "send", slot, "failed", attempt, {"messageId": mid, "receipt": "failed"})
            if attempt >= MAX_SEND_ATTEMPTS:
                self.record(run_id, "send", slot, "failed_terminal", attempt,
                            {"reason": "{} attempts failed".format(attempt)})
                if not slot.startswith("alarm:"):
                    self.alarm(run_id, "controller_send_failed", "send-failed:{}".format(key[:12]),
                               {"slot": slot, "attempts": attempt})
                return "failed_terminal"
            ob = self.obligations().get(key)
        if ob and ob["state"] == "intent":
            # Latest record is the intent itself, so no outcome was journaled:
            # killed between intent and enqueue. The helper is idempotent on
            # key#attempt (INSERT ... ON CONFLICT(id) DO NOTHING + read-back),
            # so re-running the SAME attempt is safe and is not a new send.
            next_attempt = attempt
        else:
            next_attempt = attempt + 1
            refusal = self._budget_refusal(run_id, fingerprint)
            if refusal:
                self.alarms.append({"trigger": "controller_send_budget", "runId": run_id, "detail": refusal, "slot": slot})
                self.decide(run_id, phase, "alarm", "mechanical", "controller_send_budget", slot=slot, detail=refusal)
                return "budget"
            self.record(run_id, "send", slot, "intent", next_attempt,
                        {"fingerprint": fingerprint} if fingerprint else None)
            crash_point("after-intent", "send", slot)
        mid = send_id(key, next_attempt)
        self.fire_sends[run_id] = self.fire_sends.get(run_id, 0) + 1
        result = self.effects.perform({"type": "send", "runId": run_id, "slot": slot, "messageId": mid,
                                       "threadKey": run_id})
        self.decide(run_id, phase, "send", "mechanical", "obligation due", slot=slot, key=key, attempt=next_attempt,
                    messageId=mid, effect=result["outcome"])
        crash_point("after-effect", "send", slot)
        if result["outcome"] == "shadow_refused":
            # Shadow assumes the enqueue and the delivery succeeded, so the
            # decision stream keeps moving; the journal says it was assumed.
            self.record(run_id, "send", slot, "done", next_attempt, {"outcome": "shadow_refused", "shadowAssumed": True})
            return "done"
        if result["outcome"] in ("enqueued", "replay"):
            self.record(run_id, "send", slot, "enqueued", next_attempt, {"messageId": mid})
            return "enqueued"
        # Any other outcome leaves the intent open; the same attempt id is
        # re-offered next fire and the helper's read-back settles it.
        return "intent"

    def github(self, run_id, phase, slot):
        """GitHub write: marker-carrying body; ambiguous outcomes reconcile by search."""
        key = obligation_key(run_id, "gh", slot)
        ob = self.obligations().get(key)
        if ob and ob["state"] in TERMINAL_OK | {"abandoned", "failed_terminal"}:
            return ob["state"]
        # An intent this process planned moments ago (post_finish journals the
        # freeze close before marking the run done) has not been attempted yet;
        # any other bare intent -- including one from an earlier invocation of
        # the SAME fire -- has an unknown outcome and is reconciled.
        planned_now = key in self.planned
        self.planned.discard(key)
        reconcile = bool(ob and ob["state"] == "intent" and not planned_now)
        if reconcile:
            # Outcome unknown (timeout, 5xx, or a crash): never retried blind.
            # The effect is a search for <!-- smoke-ctl:<key> --> that writes
            # only when the marker is absent -- so it is not a second write.
            self.decide(run_id, phase, "gh_reconcile", "mechanical", "prior outcome unknown; search marker before write",
                        slot=slot, marker="<!-- smoke-ctl:{} -->".format(key))
        elif not planned_now:
            self.record(run_id, "gh", slot, "intent", 1)
            crash_point("after-intent", "gh", slot)
        else:
            crash_point("after-intent", "gh", slot)
        result = self.effects.perform({"type": "gh", "runId": run_id, "slot": slot,
                                       "marker": "<!-- smoke-ctl:{} -->".format(key),
                                       "writeOnlyIfMarkerAbsent": reconcile})
        self.decide(run_id, phase, "gh", "mechanical", "obligation due", slot=slot, key=key, effect=result["outcome"],
                    afterReconcile=reconcile)
        crash_point("after-effect", "gh", slot)
        self.record(run_id, "gh", slot, "done", 1, {"outcome": result["outcome"], "shadowAssumed": True})
        return "done"

    def gate_verb(self, run_id, phase, verb, argv_tail, verdict):
        key = obligation_key(run_id, "gate", verb)
        ob = self.obligations().get(key)
        if ob and ob["state"] in TERMINAL_OK:
            return ob["state"]
        if not ob:
            self.record(run_id, "gate", verb, "intent", 1, {"args": argv_tail, "verdict": verdict})
            crash_point("after-intent", "gate", verb)
        # Both terminal verbs are crash-safe on retry: `finish` holds a
        # finishIntent and writes verdict.json once (smoke-pr-gate.sh:4108-4135),
        # and `challenger-timeout` refuses once the slot is gone or a
        # disposition exists (smoke-pr-gate.sh:4575-4625) -- so an intent with
        # no recorded outcome is simply re-offered.
        result = self.effects.perform({"type": "gate", "runId": run_id, "verb": verb, "args": argv_tail})
        self.decide(run_id, phase, "gate", "mechanical", "obligation due", verb=verb, args=argv_tail,
                    effect=result["outcome"])
        crash_point("after-effect", "gate", verb)
        self.record(run_id, "gate", verb, "done", 1, {"outcome": result["outcome"], "shadowAssumed": True,
                                                       "args": argv_tail, "verdict": verdict})
        return "done"

    def dispatch(self, run_id, phase, slot, artifact_rel, run):
        """Fresh judgment one-shot (critic/adjudicator) via `ncl tasks create`.

        Journals dispatch intent BEFORE create. An intent with no recorded
        outcome is AMBIGUOUS: `ncl tasks list` shows only pending/paused tasks,
        so absence there does not prove absence. Never recreated; escalated.
        """
        key = obligation_key(run_id, "dispatch", slot)
        slug = "ctl-{}".format(key[:8])
        ob = self.obligations().get(key)
        if run.has(artifact_rel):
            if not ob or ob["state"] != "done":
                self.record(run_id, "dispatch", slot, "done", 1, {"evidence": artifact_rel})
            return "done"
        if ob and ob["state"] in ("done", "enqueued", "failed_terminal", "abandoned"):
            return ob["state"]
        if ob and ob["state"] == "intent":
            # A bare intent means the fire died between journaling it and
            # recording the create's outcome (see the enqueued record below).
            live =[t for t in self.tasks if isinstance(t, dict) and (t.get("name") or "").startswith(slug)]
            if live:
                self.record(run_id, "dispatch", slot, "enqueued", 1, {"taskId": live[0].get("id"), "reconciled": True})
                return "enqueued"
            if not ob["detail"].get("ambiguous"):
                self.record(run_id, "dispatch", slot, "intent", 1, {"ambiguous": True})
                self.alarm(run_id, "controller_dispatch_ambiguous", "dispatch-ambiguous:{}".format(key[:12]),
                           {"slot": slot, "slug": slug})
            self.decide(run_id, phase, "escalate", "coordination_model", "controller_dispatch_ambiguous",
                        slot=slot, slug=slug)
            return "ambiguous"
        self.record(run_id, "dispatch", slot, "intent", 1, {"slug": slug})
        crash_point("after-intent", "dispatch", slot)
        result = self.effects.perform({"type": "ncl_create", "runId": run_id, "slot": slot, "name": slug,
                                       "marker": "smoke-ctl:{}".format(key), "muteChat": True})
        self.decide(run_id, phase, "dispatch", "judgment", "fresh one-shot", slot=slot, slug=slug,
                    effect=result["outcome"])
        crash_point("after-effect", "dispatch", slot)
        if result["outcome"] == "shadow_refused":
            # Shadow assumes the task was created (as send() assumes delivery),
            # journaled as such, so a bare intent stays reserved for the crash
            # window. Reading the outcome off the LAST history record instead
            # let any later record on this key (rootWithoutCritic) turn a
            # shadow-assumed create into a false controller_dispatch_ambiguous.
            self.record(run_id, "dispatch", slot, "enqueued", 1,
                        {"outcome": "shadow_refused", "shadowAssumed": True, "taskId": None})
            return "enqueued"
        if result.get("taskId"):
            self.record(run_id, "dispatch", slot, "enqueued", 1, {"taskId": result["taskId"]})
            return "enqueued"
        # Timeout or unknown: the intent stays bare and is reconciled next fire.
        return "intent"

    def owner_step(self, run_id, phase, step, done):
        key = obligation_key(run_id, "owner", step)
        ob = self.obligations().get(key)
        if done:
            if ob and ob["state"] != "done":
                self.record(run_id, "owner", step, "done", 1)
            return "done"
        if not ob:
            self.record(run_id, "owner", step, "intent", 1)
            self.decide(run_id, phase, "wake_owner", "judgment", "owner step due", step=step,
                        brief="controller/brief-{}.md".format(step), wakeAgent=True)
            return "intent"
        started = parse_iso(ob["history"][0].get("at"))
        if ob["state"] == "intent" and started and (self.now - started).total_seconds() > OWNER_STEP_SLA_SECONDS:
            if not ob["detail"].get("overdue"):
                self.record(run_id, "owner", step, "intent", 1, {"overdue": True})
                self.alarm(run_id, "controller_obligation_overdue", "overdue:{}".format(key[:12]),
                           {"obligation": "owner:{}".format(step)})
                # There is no timeout verdict for a silent owner (the spec's
                # only timeout is the challenger's); resume vs abandon is the
                # same human call the gate's pr_run_stalled asks for
                # (smoke-pr-gate.sh:4775-4795), so it is counted as one.
                self.decide(run_id, phase, "escalate", "coordination_model", "owner step overdue", step=step)
        self.decide(run_id, phase, "wait", "wait", "owner step in progress", step=step)
        return "intent"

    # -- per-fire reconciliation --------------------------------------------

    def reconcile_claims(self):
        obs = self.obligations()
        claims = self.gate.active_claims()
        wake = (self.poll or {}).get("data") if isinstance(self.poll, dict) else None
        if isinstance(wake, dict) and wake.get("trigger") == "pr_build_settled" and wake.get("runId"):
            run = wake["runId"]
            if RUN_ID_RE.match(run) and obligation_key(run, "run", "claim") not in obs:
                # The gate's poll has already claimed; this is the first record
                # of the run. A kill right here is recovered below on the next
                # fire from gate state (controller_orphan_claim).
                crash_point("before-run-record", "run", "claim")
                self.record(run, "run", "claim", "enqueued", 1, {
                    "origin": "poll-wake", "pr": wake.get("pr"), "sha": wake.get("sourceSha"),
                    "isFreezePr": wake.get("isFreezePr")})
                crash_point("after-run-record", "run", "claim")
                obs = self.obligations()
        for run, claim in sorted(claims.items()):
            if not RUN_ID_RE.match(run):
                continue
            if obligation_key(run, "run", "claim") not in obs:
                self.record(run, "run", "claim", "enqueued", 1, {"origin": "recovered", "pr": claim["pr"],
                                                                "sha": claim["sha"]})
                self.alarms.append({"trigger": "controller_orphan_claim", "runId": run, "pr": claim["pr"]})
                self.decide(run, None, "log", "mechanical", "controller_orphan_claim", pr=claim["pr"])

    # -- one run ------------------------------------------------------------

    def step_run(self, run_id):
        obs = self.obligations()
        run_ob = obs.get(obligation_key(run_id, "run", "claim"))
        if run_ob and run_ob["state"] in ("done", "abandoned") and not self._post_finish_pending(run_id):
            return None
        claims = self.gate.active_claims()
        claim = claims.get(run_id)
        verdict_doc = self.gate.run_verdict(run_id)
        run = RunView(self.args.run_root, run_id)
        pr = (run_ob or {}).get("detail", {}).get("pr") or self.gate.pr_for_run(run_id)

        if verdict_doc and verdict_doc.get("error"):
            self.decide(run_id, None, "escalate", "coordination_model", "gate verdict.json unreadable",
                        error=verdict_doc.get("error"))
            return "unknown"
        if verdict_doc:
            return self.post_finish(run_id, pr, verdict_doc.get("verdict"), external=True)
        if claim is None and pr in self.gate.error_prs:
            # Absence is only evidence when presence was readable.
            self.decide(run_id, None, "escalate", "coordination_model", "gate state for this PR is unreadable")
            return "unknown"
        for verb in TERMINAL_VERBS:
            own_finish = obs.get(obligation_key(run_id, "gate", verb))
            if own_finish and own_finish["state"] == "done":
                return self.post_finish(run_id, pr, own_finish["detail"].get("verdict"), external=False)
        if claim is None:
            # Not active and not finished: reclaimed or released. Pre-finish
            # obligations are abandoned with the reason on record.
            for ob in obs.values():
                if ob["runId"] == run_id and ob["state"] not in ("done", "delivered", "abandoned", "failed_terminal"):
                    self.record(run_id, ob["kind"], ob["slot"], "abandoned", ob["attempt"] or None,
                                {"reason": "run no longer holds the gate slot"})
            self.decide(run_id, "released", "log", "mechanical", "run lost the slot without a verdict")
            return "released"

        # -- phase derivation (derived, never stored) --
        if not run.exists or run.contract_error:
            self.owner_step(run_id, "intake", "intake", done=False)
            if run.exists and run.contract_error not in ("missing",):
                self.decide(run_id, "intake", "escalate", "coordination_model",
                            "completion contract unreadable: {}".format(run.contract_error))
            return "intake"
        self.owner_step(run_id, "intake", "intake", done=True)

        if run.isdir("contact-sheet"):
            # The root post carries the critic's lines (PRP step 3), so it waits
            # for the fresh critic -- but only up to CRITIC_WAIT_SECONDS. A
            # critic that never answers (or an ambiguous dispatch, which is
            # escalated and blocks GO on its own) must not stall the campaign.
            critic = self.dispatch(run_id, "intake", "critic", CRITIC_ARTIFACT, run)
            if critic != "done":
                ob = self.obligations().get(obligation_key(run_id, "dispatch", "critic"))
                started = parse_iso(ob["history"][0].get("at")) if ob else None
                if started and (self.now - started).total_seconds() < CRITIC_WAIT_SECONDS:
                    self.decide(run_id, "intake", "wait", "wait", "critic pending before root post")
                    return "intake"
                if not ob["detail"].get("rootWithoutCritic"):
                    self.record(run_id, "dispatch", "critic", ob["state"], 1, {"rootWithoutCritic": True})
                    self.decide(run_id, "intake", "log", "mechanical",
                                "critic output not in by {}s; root post goes without the design check".format(
                                    CRITIC_WAIT_SECONDS))
        root = self.send(run_id, "lanes", "root")
        # PRP step 3: the sheet is a SEPARATE, later row so the host threads it
        # under the fresh root -- never before the root row exists.
        if run.has("contact-sheet/sheet.png") and root in ("enqueued", "delivered", "done"):
            self.send(run_id, "lanes", "root-sheet")

        # An owner may conclude BLOCKED or HUMAN_DECISION before the barriers
        # are ready (lanes that cannot be repaired). Neither verdict can clear
        # a PR, so it is taken from any phase once bound to this run; GO and
        # NO_GO still go through lanes -> preliminary -> challenger -> synthesis.
        # Found by the replay: 4/30 historical campaigns ended HUMAN_DECISION
        # over lanes the barrier never passed, and would otherwise stall.
        early, early_err = run.synthesis()
        if not early_err and isinstance(early, dict) and early.get("verdict") in ("BLOCKED", "HUMAN_DECISION"):
            verdict, failed = validate_synthesis(run, claim.get("sha"), self.pr_heads.get(str(pr)),
                                                 {"ready": False}, run.last_identity_check())
            self.owner_step(run_id, "synthesis", "synthesis", done=True)
            return self.pre_finish(run_id, pr, verdict, failed, early)

        lanes = run.barrier("lanes")
        if not lanes.get("ready"):
            self.owner_step(run_id, "lanes", "lanes", done=False)
            if lanes.get("invalid"):
                self.decide(run_id, "lanes", "escalate", "coordination_model",
                            "lane evidence invalid (redispatch is a judgment call)",
                            invalid=lanes.get("invalid"), reasons=(lanes.get("invalidReasons") or [])[:3])
            return self._maybe_challenger_timeout(run_id, claim, run) or "lanes"
        self.owner_step(run_id, "lanes", "lanes", done=True)

        if not run.has("coordinator/preliminary.md"):
            self.owner_step(run_id, "preliminary", "preliminary", done=False)
            return self._maybe_challenger_timeout(run_id, claim, run) or "preliminary"
        self.owner_step(run_id, "preliminary", "preliminary", done=True)

        if not run.has("challenger/disposition.md"):
            timed = self._maybe_challenger_timeout(run_id, claim, run)
            if timed:
                return timed
            self.decide(run_id, "await_challenger", "wait", "wait", "challenger disposition pending",
                        deadline=claim.get("deadline"))
            return "await_challenger"

        syn_barrier = run.barrier("synthesis")
        synthesis_doc, syn_err = run.synthesis()
        if syn_err == "missing":
            if not syn_barrier.get("ready"):
                if syn_barrier.get("invalid"):
                    self.decide(run_id, "synthesis", "escalate", "coordination_model",
                                "synthesis barrier invalid", invalid=syn_barrier.get("invalid"))
                else:
                    self.decide(run_id, "synthesis", "wait", "wait", "synthesis barrier not ready",
                                missing=syn_barrier.get("missing"))
                return "synthesis"
            timed = self._maybe_synthesis_overdue_blocked(run_id, pr, run)
            if timed:
                return timed
            self.owner_step(run_id, "synthesis", "synthesis", done=False)
            return "synthesis"
        self.owner_step(run_id, "synthesis", "synthesis", done=True)

        head = self.pr_heads.get(str(pr))
        verdict, failed = validate_synthesis(run, claim.get("sha"), head, syn_barrier, run.last_identity_check())
        return self.pre_finish(run_id, pr, verdict, failed, synthesis_doc if not syn_err else {})

    def _maybe_synthesis_overdue_blocked(self, run_id, pr, run):
        """Ruling on spec gap 3: the challenger concluded BLOCKED and the owner's
        synthesis step is past its SLA -> finish BLOCKED with no model. It can
        never produce GO (the verdict is fixed here), so it is fail-safe. Seen in
        the replay (pr1945, pr1953): the historical coordinator finished BLOCKED
        straight from the challenger and never wrote a synthesis."""
        ob = self.obligations().get(obligation_key(run_id, "owner", "synthesis"))
        if not ob or ob["state"] != "intent":
            return None
        started = parse_iso(ob["history"][0].get("at"))
        if not started or (self.now - started).total_seconds() <= OWNER_STEP_SLA_SECONDS:
            return None
        challenge = run.challenge_complete()
        if not isinstance(challenge, dict) or challenge.get("disposition") != "BLOCKED":
            return None
        self.decide(run_id, "synthesis", "log", "mechanical",
                    "synthesis overdue after challenger BLOCKED; finishing BLOCKED model-free")
        return self.pre_finish(run_id, pr, "BLOCKED", [
            "synthesis overdue ({}s) and challenger disposition BLOCKED".format(OWNER_STEP_SLA_SECONDS)], {})

    def _maybe_challenger_timeout(self, run_id, claim, run):
        deadline = parse_iso(claim.get("deadline"))
        if not deadline or self.now < deadline or run.has("challenger/disposition.md"):
            return None
        # `challenger-timeout` IS the terminal verb: it records no-disposition
        # and runs `finish ... BLOCKED` itself (smoke-pr-gate.sh:4660-4666), so
        # the controller must not call `finish` after it.
        return self.pre_finish(run_id, claim.get("pr"), "BLOCKED", ["challenger-timeout: no disposition by {}".format(
            claim.get("deadline"))], {}, terminal_verb="challenger-timeout")

    def pre_finish(self, run_id, pr, verdict, failed, synthesis_doc, terminal_verb="finish"):
        phase = "verdict"
        # The verdict is frozen the first time it validates, because the
        # verdict post is rendered from it. Later fires only re-check a frozen
        # GO: if it no longer validates (the PR head moved, evidence changed),
        # finish goes BLOCKED with an alarm -- a GO is never upgraded into and
        # a non-GO is never changed after its post.
        vob = self.obligations().get(obligation_key(run_id, "verdict", "validated"))
        if vob is None:
            self.record(run_id, "verdict", "validated", "done", 1, {"verdict": verdict, "failedChecks": failed})
        else:
            frozen = vob["detail"].get("verdict")
            if frozen == "GO" and verdict != "GO":
                failed = failed + ["verdict changed after validation: GO no longer holds"]
                if not vob["detail"].get("superseded"):
                    self.record(run_id, "verdict", "validated", "done", 1, {"superseded": True})
                    self.alarm(run_id, "controller_verdict_superseded", "verdict-superseded:{}".format(run_id[-24:]),
                               {"failedChecks": failed})
                verdict = "BLOCKED"
            elif frozen != "GO":
                verdict, failed = frozen, vob["detail"].get("failedChecks") or []
        self.decide(run_id, phase, "validate", "mechanical", "verdict validated", verdict=verdict, failedChecks=failed)
        findings = []
        for f in (synthesis_doc or {}).get("findings") or []:
            if isinstance(f, dict) and f.get("confirmed") and isinstance(f.get("id"), str):
                findings.append(f["id"])
        run = RunView(self.args.run_root, run_id)
        for m in run.markers().values():
            for fid in (m["doc"] or {}).get("confirmedFindings") or []:
                if isinstance(fid, str) and fid not in findings:
                    findings.append(fid)
        states = []
        for fid in findings:
            states.append(("gh", "issue:{}".format(fid), self.github(run_id, phase, "issue:{}".format(fid))))
        states.append(("send", "verdict", self.send(run_id, phase, "verdict")))
        states.append(("gh", "pr-comment", self.github(run_id, phase, "pr-comment")))
        # failed_terminal and dispatch-ambiguous obligations keep their
        # escalation evidence and permit ONLY finish BLOCKED (spec rev 3).
        blocking = []
        for ob in self.obligations().values():
            if ob["runId"] != run_id:
                continue
            if ob["state"] == "failed_terminal":
                blocking.append("obligation {}:{} is failed_terminal".format(ob["kind"], ob["slot"]))
            elif ob["kind"] == "dispatch" and ob["state"] == "intent" and ob["detail"].get("ambiguous"):
                blocking.append("obligation dispatch:{} is ambiguous".format(ob["slot"]))
        if blocking and verdict != "BLOCKED":
            failed = failed + blocking
            verdict = "BLOCKED"
        if verdict == "GO":
            # GO needs EVERY journaled pre-finish obligation receipted -- not just
            # the ones assembled above: a critic still enqueued, a root post or
            # alarm awaiting its receipt. Young ones are waited on; one older
            # than the owner SLA can no longer be assumed to land, so GO is
            # refused (BLOCKED, naming it) rather than waited on forever.
            for ob in self.obligations().values():
                if ob["runId"] != run_id or ob["kind"] not in PRE_FINISH_KINDS or ob["slot"] in POST_FINISH_SLOTS:
                    continue
                if ob["state"] in TERMINAL_OK:
                    continue
                if ob["kind"] == "dispatch" and ob["slot"] == "critic" and run.has(CRITIC_ARTIFACT):
                    continue  # its evidence is in; dispatch() records done on its next pass
                started = parse_iso(ob["history"][0].get("at"))
                age = (self.now - started).total_seconds() if started else OWNER_STEP_SLA_SECONDS + 1
                label = "{}:{} is {}".format(ob["kind"], ob["slot"], ob["state"])
                if age > OWNER_STEP_SLA_SECONDS:
                    failed = failed + ["obligation {} after {}s (GO needs it receipted)".format(label, int(age))]
                    verdict = "BLOCKED"
                elif (ob["kind"], ob["slot"]) not in {(k, sl) for k, sl, _ in states}:
                    states.append((ob["kind"], ob["slot"], "enqueued" if ob["state"] == "enqueued" else "intent"))
        pending = [s for s in states if s[2] in ("intent", "enqueued", "budget")]
        if pending:
            self.decide(run_id, phase, "wait", "wait", "pre-finish obligations pending", pending=pending)
            return "verdict"
        claim_sha = (self.gate.active_claims().get(run_id) or {}).get("sha")
        if verdict == "GO" and failed:
            # Unreachable by construction; asserted so a future edit cannot
            # turn a failed check into a GO finish.
            raise ControllerError("refusing finish GO with failed checks: {}".format(failed))
        self.decide(run_id, phase, "finish", "mechanical", "all pre-finish obligations settled",
                    verdict=verdict, failedChecks=failed, verb=terminal_verb)
        args = [run_id] if terminal_verb == "challenger-timeout" else [claim_sha, run_id, verdict]
        if self.gate_verb(run_id, phase, terminal_verb, args, verdict) in TERMINAL_OK:
            # PRP step 7: the freeze-PR close follows finish in the same turn.
            return self.post_finish(run_id, pr, verdict, external=False)
        return "verdict"

    def _post_finish_pending(self, run_id):
        for ob in self.obligations().values():
            if ob["runId"] == run_id and ob["slot"] in POST_FINISH_SLOTS and ob["state"] not in (
                    "done", "delivered", "abandoned", "failed_terminal"):
                return True
        return False

    def post_finish(self, run_id, pr, verdict, external):
        obs = self.obligations()
        run_key = obligation_key(run_id, "run", "claim")
        is_freeze = (obs.get(run_key) or {}).get("detail", {}).get("isFreezePr")
        pv = self.gate.pr_verdict(pr) if pr else None
        if isinstance(pv, dict) and pv.get("runId") == run_id and isinstance(pv.get("handoff"), dict):
            is_freeze = bool(pv["handoff"].get("written") or pv["handoff"].get("targetSha"))
        # Required post-finish obligations are journaled BEFORE the run is
        # marked done, so a crash between the two leaves an open obligation
        # that the done early-return (step_run) still reconciles.
        if is_freeze and obligation_key(run_id, "gh", "freeze-close") not in obs:
            self.record(run_id, "gh", "freeze-close", "intent", 1, {"planned": True})
            self.planned.add(obligation_key(run_id, "gh", "freeze-close"))
        obs = self.obligations()
        if run_key in obs and obs[run_key]["state"] not in ("done", "abandoned"):
            self.record(run_id, "run", "claim", "done", 1, {"verdict": verdict, "finishedBy": "gate" if external else
                                                          "controller"})
            # Owner steps still waiting are moot once the verdict is written.
            for ob in list(self.obligations().values()):
                if ob["runId"] == run_id and ob["kind"] == "owner" and ob["state"] == "intent":
                    self.record(run_id, "owner", ob["slot"], "abandoned", 1, {"reason": "run finished"})
            crash_point("after-run-done", "run", "claim")
        if is_freeze or obligation_key(run_id, "gh", "freeze-close") in self.obligations():
            key = obligation_key(run_id, "gh", "freeze-close")
            ob = self.obligations().get(key)
            if ob and ob["state"] == "intent":
                started = parse_iso(ob["history"][0].get("at"))
                if started and (self.now - started).total_seconds() > POST_FINISH_SLA_SECONDS and \
                        not ob["detail"].get("overdue"):
                    self.record(run_id, "gh", "freeze-close", "intent", 1, {"overdue": True})
                    self.alarm(run_id, "controller_obligation_overdue", "overdue:{}".format(key[:12]),
                               {"obligation": "gh:freeze-close"})
            self.github(run_id, "finished", "freeze-close")
        self.decide(run_id, "finished", "log", "mechanical", "run finished", verdict=verdict,
                    finishedBy="gate" if external else "controller")
        return "finished"

    # -- fire ---------------------------------------------------------------

    def fire_once(self):
        self.reconcile_claims()
        runs = set(self.journal.runs()) | set(self.gate.active_claims())
        summary = []
        for run_id in sorted(runs):
            if not RUN_ID_RE.match(run_id):
                continue
            phase = self.step_run(run_id)
            if phase:
                summary.append({"runId": run_id, "phase": phase})
        return summary


# ---------------------------------------------------------------------------
# cli


def resolve_mode(args):
    env = os.environ.get("SMOKE_CONTROLLER_MODE", "off")
    mode = "shadow" if args.shadow else env
    if mode not in ("off", "shadow"):
        raise ControllerError("SMOKE_CONTROLLER_MODE={!r} is not supported by this build (off|shadow only)".format(mode))
    return mode


def append_decision(out_dir, decision):
    run_id = decision.get("runId") or "_global"
    if run_id != "_global" and not RUN_ID_RE.match(run_id):
        run_id = "_global"
    fd = open_contained(out_dir, [run_id, "decisions.ndjson"], os.O_WRONLY | os.O_APPEND | os.O_CREAT,
                        make_dirs=True)
    try:
        os.write(fd, (json.dumps(decision, sort_keys=True) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("init", "step"):
        s = sub.add_parser(name)
        s.add_argument("--shadow", action="store_true", help="force shadow mode (the only implemented mode)")
        s.add_argument("--out-dir", default=os.environ.get("SMOKE_CONTROLLER_SHADOW_DIR"))
        s.add_argument("--gate-state-dir", default=os.environ.get("SMOKE_GATE_STATE_DIR"))
        s.add_argument("--run-root", default=os.environ.get("SMOKE_GATE_RUN_ROOT"))
        s.add_argument("--poll-json")
        s.add_argument("--receipts-json")
        s.add_argument("--tasks-json")
        s.add_argument("--pr-heads-json")
        s.add_argument("--now")
        s.add_argument("--fire")
        s.add_argument("--lock-timeout", type=float, default=30.0)
    args = p.parse_args(argv)
    journal = None
    try:
        mode = resolve_mode(args)
        if mode == "off":
            print(json.dumps({"ok": True, "mode": "off", "wakeAgent": False}))
            return 0
        out_dir = args.out_dir or (os.path.join(args.gate_state_dir, "controller-shadow") if args.gate_state_dir else None)
        if not out_dir:
            raise ControllerError("no --out-dir and no SMOKE_GATE_STATE_DIR")
        journal = Journal(out_dir)
        if not journal.lock(args.lock_timeout):
            print(json.dumps({"ok": True, "mode": mode, "wakeAgent": False, "skipped": "control.lock busy"}))
            return 0
        if args.command == "init":
            journal.init()
            print(json.dumps({"ok": True, "mode": mode, "initialized": journal.path}))
            return 0
        effects = EffectLayer(mode)
        journal.load()
        now = parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        if now is None:
            raise ControllerError("--now {!r} is not ISO-8601".format(args.now))
        gate = GateView(args.gate_state_dir)
        ctl = Controller(args, journal, gate, effects, now, args.fire or iso(now))
        summary = ctl.fire_once()
        print(json.dumps({"ok": True, "mode": mode, "wakeAgent": False, "fire": ctl.fire, "runs": summary,
                          "decisions": len(ctl.decisions), "effectsRefused": len(effects.performed),
                          "alarms": ctl.alarms, "gateStateErrors": gate.errors}, sort_keys=True))
        return 0
    except ControllerError as exc:
        alarm = "controller_journal_error" if isinstance(exc, JournalError) else "controller_error"
        print(json.dumps({"ok": False, "wakeAgent": False, "alarm": alarm, "error": str(exc)}))
        return 3
    finally:
        if journal is not None:
            journal.unlock()


if __name__ == "__main__":
    sys.exit(main())
