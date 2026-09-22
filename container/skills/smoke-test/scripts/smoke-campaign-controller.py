#!/usr/bin/env python3
"""Durable PR smoke-campaign controller: shadow or live.

One fire = one `step`: read gate state, run artifacts and the obligation
journal; derive each run's phase; decide the next mechanical action; journal
the intent BEFORE the action; hand the action to the effect layer; journal the
outcome. The model is woken only for judgment (owner steps, fresh critic).
Spec: jev-smoke-sweep/CONTROLLER-SPEC.md rev 3 (s2 design, s3 shadow).

ONE EFFECT LAYER, TWO MODES. Every external effect -- a chat send, a GitHub
write, an `ncl tasks create`, a gate verb, an owner brief -- goes through
EffectLayer.perform(). In shadow it refuses every effect and returns
`shadow_refused`; in live it performs it. The step engine above it is the same
code in both modes: every journal, obligation, GO and BLOCKED rule is shared,
and live changes only what perform() does and what its outcome records.
SMOKE_CONTROLLER_MODE is off|shadow|live (default off); `--shadow` forces
shadow whatever the env says. A journal written in one mode is refused by the
other (JournalError), so a shadow journal can never drive live effects.

Subprocesses start at ONE call site, spawn(), against an allowlist: in shadow
only READ_ONLY_COMMANDS (the evidence barrier, which only reads --
smoke-evidence-barrier.sh has no write path, and the `smoke-journeys.py
barrier` it calls reads only; its sole writer `_write_atomic` serves
`pin-run`/`match`). Live adds the configured gate wrapper, gh, ncl and the
enqueue-send helper, and only EffectLayer's live methods pass that list. The
controller's own writes are its journal, decisions log and lock file under
--out-dir; live adds send payloads there and owner briefs under
<run-root>/<runId>/controller/.

Live (s2): gate verbs via the deployed gate wrapper with the claim's owner
token; GitHub writes carry `<!-- smoke-ctl:<key> -->` and are search -> act ->
read back; chat via enqueue-send (id key#attempt, threadKey = runId, its own
send budget); critic/adjudicator one-shots via `ncl tasks create` (dispatch
intent journaled before create, an ambiguous one held); owner steps via a
brief file plus the wrapper's wakeAgent. Cutover: the first live fire writes
<out-dir>/cutover.json naming every run already claimed; those finish under
the legacy coordinator and this controller never acts on them. A run claimed
after the flip is claimed by the gate `poll` inside the live wrapper, whose
wake (and owner token) reaches only this controller, so `finish` refuses
anyone else (smoke-pr-gate.sh:4090-4095).

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
import shlex
import signal
import stat
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BARRIER = os.path.join(SCRIPT_DIR, "smoke-evidence-barrier.sh")
PAIR_IDENTITY = os.path.join(SCRIPT_DIR, "smoke-pair-identity.sh")
READ_ONLY_COMMANDS = {("bash", BARRIER)}
MODES = ("off", "shadow", "live")
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

# The CLOSED allowlist of step outcomes. A step that answers anything else --
# "unknown", a malformed gate artifact, an unforeseen exception -- is a silent
# failure, and the boundary below alarms on it. A new phase is added HERE; a
# path that forgets to alarm is caught rather than lost.
STEP_OUTCOMES = frozenset((None, "released", "held", "intake", "lanes", "preliminary",
                           "await_challenger", "synthesis", "verdict", "finished"))
TERMINAL_VERBS = ("finish", "challenger-timeout")
POST_FINISH_SLOTS = ("freeze-close",)
# Journal kinds whose obligations must all be receipted before a GO finish.
PRE_FINISH_KINDS = ("send", "gh", "dispatch")
OWNER_STEP_SLA_SECONDS = 3600
# A send awaiting its delivery receipt, or a GitHub write awaiting its marker
# read-back, older than this raises controller_obligation_overdue (once). It
# never resends: a missing receipt is ambiguous and keeps its message id.
RECEIPT_SLA_SECONDS = 1800
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
# Journal run ids for sends that belong to no campaign: gate alarms (one
# budget per UTC day) and cutover holds. Never a gate run id (those carry the
# deployment's run prefix), never stepped as a campaign.
PSEUDO_PREFIX = "ctl."
# Consecutive helper/GitHub failures of ONE attempt before it goes terminal.
MAX_EFFECT_FAILURES = 3
# Wakes offered for one owner brief before the controller stops re-offering
# it (the owner acks with controller/brief-<step>.ack as its first act).
OWNER_WAKE_OFFERS = 3


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


def is_alarm_send(run_id, slot):
    """An alarm post: a run's `alarm:*` slot, or any send of a pseudo-run
    (gate alarms, cutover holds). Alarms ride their own budget lane."""
    return str(slot).startswith("alarm:") or str(run_id).startswith(PSEUDO_PREFIX)


def gate_alarm_ids(wake, now):
    """(pseudo run, fingerprint, send slot) for one gate alarm wake. Shared by
    the controller and the live worker's queue drain, so "is this queued
    alarm journaled yet" asks the same question the controller answers. The
    day comes from when the wake was queued, not when it was drained."""
    day = (parse_iso(wake.get("queuedAt")) or now).strftime("%Y%m%d")
    fp = wake.get("fingerprint") or wake.get("runId") or hashlib.sha256(
        json.dumps({k: v for k, v in wake.items() if k not in ("schemaVersion", "queuedAt")},
                   sort_keys=True).encode()).hexdigest()[:16]
    fp = re.sub(r"[^A-Za-z0-9._:-]", "-", "{}:{}".format(wake.get("trigger"), fp))[:150]
    return PSEUDO_PREFIX + "gate." + day, fp, "gate:{}".format(fp)


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


def refusal_digest(doc):
    """A stable id for THE REFUSAL, from a published barrier report (or None).

    `invalid[]` AND `invalidReasons[]`, in the barrier's own order and never
    `missing[]`. Each half of that is deliberate:

    - `missing[]` is the owner's own progress -- markers it is in the middle of
      writing. Folding it in would wake the owner on every marker it banks,
      which trains it to ignore the wake that matters.
    - the reasons, not just the file names, because a repair commonly moves the
      refusal without moving the file: run pr2055's scope-dispositions.json went
      from `dispositions[3]/[30]/[31]` to `[3]/[30]/[32]` between fires, one
      file throughout. Keying on `invalid[]` alone would call that unchanged and
      leave the owner working against a stale diagnosis.
    - the barrier's own order, not sorted: it is deterministic for a given tree
      (requiredLaneMarkers in contract order, then the journeys and visual
      checks in fixed sequence), so sorting would only hide a genuine change.

    "" means nothing is refused -- which is never a reason to wake anyone."""
    if not isinstance(doc, dict):
        return ""
    invalid = doc.get("invalid") or []
    reasons = doc.get("invalidReasons") or []
    if not invalid and not reasons:
        return ""
    return hashlib.sha256(json.dumps([invalid, reasons], sort_keys=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()[:32]


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


_ROOT_IDENTITY = {}


def _open_root(root):
    """Open the containment root, pinned to ONE identity per process: the
    first open records (st_dev, st_ino) and every later open of the same path
    must match it. The root open cannot use O_NOFOLLOW (an install may
    legitimately reach the out-dir through a symlinked parent), so without
    this a root replaced between two calls would simply be followed to its new
    target and every containment check below it would pass against the WRONG
    directory (Codex PR #945 round 6). Returns an fd the caller owns."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        st = os.fstat(fd)
        ident = (st.st_dev, st.st_ino)
        first = _ROOT_IDENTITY.setdefault(root, ident)
        if first != ident:
            raise ControllerError(
                "refusing controller root {}: it is no longer the directory first validated".format(root))
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_contained(root, parts, flags, mode=0o644, make_dirs=False):
    """Open root/<parts...> without following a symlink at any component
    below root, and verify the result resolves under root. Returns an fd."""
    for part in parts:
        if not part or part in (".", "..") or "/" in part:
            raise ControllerError("refusing unsafe path component {!r}".format(part))
    dfd = _open_root(root)
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


def _open_dir_contained(root, parts, make_dirs):
    """fd of root/<parts...>, every component opened O_NOFOLLOW, verified under root."""
    for part in parts:
        if not part or part in (".", "..") or "/" in part:
            raise ControllerError("refusing unsafe path component {!r}".format(part))
    dfd = _open_root(root)
    try:
        for part in parts:
            if make_dirs:
                try:
                    os.mkdir(part, 0o755, dir_fd=dfd)
                except FileExistsError:
                    pass
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
            except OSError as exc:
                # The errno rides along: a caller has to tell "this directory
                # is not there" (ENOENT) from "I could not look" (EACCES,
                # ELOOP, ENOTDIR), and the message alone cannot (round 6).
                err = ControllerError("refusing controller path {}/{}: {}".format(root, part, exc))
                err.errno = exc.errno
                raise err
            os.close(dfd)
            dfd = nxt
        _contained(dfd, root)
    except BaseException:
        os.close(dfd)
        raise
    return dfd


def write_contained_atomic(root, parts, data):
    """Replace root/<parts...> atomically: a fresh O_EXCL|O_NOFOLLOW temp in the
    same verified directory, fsync, rename. A rename replaces a symlink or a
    hard link at the name rather than writing through it, so an existing
    link can never carry the write outside root (an O_TRUNC open would
    truncate the link target before any check could run)."""
    dfd = _open_dir_contained(root, parts[:-1], make_dirs=True)
    try:
        tmp = ".{}.{}.tmp".format(parts[-1], os.getpid())
        try:
            os.unlink(tmp, dir_fd=dfd)
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        try:
            view = memoryview(data.encode("utf-8") if isinstance(data, str) else data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, parts[-1], src_dir_fd=dfd, dst_dir_fd=dfd)
        os.fsync(dfd)
    finally:
        os.close(dfd)
    return os.path.join(root, *parts)


def write_contained_once(root, parts, data):
    """Create root/<parts...> exactly once (O_EXCL); return (path, created).
    An existing file is kept -- it is the payload an earlier attempt already
    committed to, and a replay must send the same bytes."""
    path = os.path.join(root, *parts)
    dfd = _open_dir_contained(root, parts[:-1], make_dirs=True)
    try:
        # Written in full to a temp, then link()ed into place: link() fails
        # with EEXIST instead of replacing, so the name only ever holds a
        # complete payload and a crash mid-write leaves just a stray temp.
        tmp = ".{}.{}.tmp".format(parts[-1], os.getpid())
        try:
            os.unlink(tmp, dir_fd=dfd)
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        try:
            view = memoryview(data.encode("utf-8") if isinstance(data, str) else data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tmp, parts[-1], src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
            created = True
        except FileExistsError:
            created = False
        os.unlink(tmp, dir_fd=dfd)
        os.fsync(dfd)
    finally:
        os.close(dfd)
    if not created:
        # The existing entry must still be a regular single-link file under root.
        os.close(open_contained(root, parts, os.O_RDONLY))
    return path, created


def unlink_contained(root, parts):
    """Remove root/<parts...> through the same O_NOFOLLOW walk as the writes:
    the leaf is unlinked relative to a directory fd no symlinked component
    could have redirected, so a swapped directory cannot carry a delete
    outside root (Codex PR #945 round 5, finding 4). An absent leaf, or an
    absent/refused parent, is not an error -- there is nothing to remove."""
    try:
        dfd = _open_dir_contained(root, parts[:-1], make_dirs=False)
    except (OSError, ControllerError):
        return False
    try:
        os.unlink(parts[-1], dir_fd=dfd)
        return True
    except (FileNotFoundError, IsADirectoryError):
        return False
    finally:
        os.close(dfd)


def listdir_contained(root, parts):
    """Sorted names in root/<parts...>, listed through the O_NOFOLLOW walk.
    ONLY a genuine ENOENT is []; every other errno RAISES -- a symlinked
    component (ELOOP), a permission refusal anywhere in the ancestry
    (EACCES), a non-directory (ENOTDIR). Reading "empty" off a directory
    nobody could look into is how live state silently disappears: this lists
    the gate's alarm queue (round 5 finding 3; round 6 corrected the test for
    absence, which `os.path.lexists` also fails on an unreadable ancestor,
    reporting "not there" for "could not look")."""
    try:
        dfd = _open_dir_contained(root, parts, make_dirs=False)
    except ControllerError as exc:
        if getattr(exc, "errno", None) == errno.ENOENT:
            return []
        raise
    try:
        return sorted(os.listdir(dfd))
    finally:
        os.close(dfd)


# ---------------------------------------------------------------------------
# journal


class Journal:
    def __init__(self, out_dir, mode=None):
        self.mode = mode
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
        if self.mode:
            # The mode a journal was created in (journal.mode, written by
            # init). An empty journal has no records to carry it. A journal
            # with no sidecar predates it, and every such journal was shadow.
            born = self._born_mode()
            if born != self.mode:
                raise JournalError("journal {} was created in {} mode; refusing to run it in {} mode".format(
                    self.path, born, self.mode))
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
            if self.mode and rec.get("mode") not in (None, self.mode):
                # A shadow journal records assumed outcomes (shadowAssumed): read
                # by live, they would read as effects that already happened.
                raise JournalError("journal {} line {} was written in {} mode; refusing to run it in {} mode".format(
                    self.path, n, rec.get("mode"), self.mode))
            records.append(rec)
        self.records = []
        self._obs = {}
        for rec in records:
            self._fold(rec)

    def _born_mode(self):
        try:
            fd = open_contained(self.dir, ["journal.mode"], os.O_RDONLY)
            with os.fdopen(fd, "rb") as fh:
                return fh.read(64).decode("utf-8", "replace").strip()
        except FileNotFoundError:
            return "shadow"
        except (OSError, ControllerError) as exc:
            raise JournalError("journal mode file under {} refused: {}".format(self.dir, exc))

    def init(self):
        os.makedirs(self.dir, exist_ok=True)
        if os.path.lexists(self.path):
            # Checked before the mode file is touched, so an init against an
            # existing journal can never relabel it (init holds control.lock).
            raise JournalError("journal already exists at {} -- init never truncates".format(self.path))
        if self.mode:
            # Before the journal: a crash between the two leaves no journal,
            # and the next init rewrites the same mode.
            write_contained_atomic(self.dir, ["journal.mode"], self.mode + "\n")
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


def spawn(argv, timeout, allowed, env=None):
    """THE subprocess call site. (rc, stdout, stderr); rc None = not run or
    timed out. argv must start with one of the `allowed` prefixes. The child
    gets its own process group and the whole group is killed on timeout, so
    a grandchild holding the pipes open cannot outlive the budget."""
    argv = [str(a) for a in argv]
    if not any(tuple(argv[:len(p)]) == tuple(p) for p in allowed):
        raise ControllerError("refusing to run non-allowlisted command: {}".format(argv[:2]))
    if timeout < 1:
        return None, "", "no time left in this fire"
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=env, start_new_session=True)
    except OSError as exc:
        return None, "", str(exc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return None, "", "timed out after {:.0f}s".format(timeout)
    return proc.returncode, out, err


def last_json_line(text):
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                doc = json.loads(line)
            except ValueError:
                return None
            return doc if isinstance(doc, dict) else None
    return None


def run_read_only(argv, timeout=60):
    rc, out, err = spawn(argv, timeout, READ_ONLY_COMMANDS)
    if rc is None:
        return None, err
    doc = last_json_line(out)
    if doc is None:
        return None, "unparsable output (rc={})".format(rc)
    return doc, None


# Chat language for the machine verdicts (SKILL.md s8): a human never reads a
# bare token.
VERDICT_CHAT = {
    "GO": "Safe to ship",
    "NO_GO": "Do not ship this build",
    "HUMAN_DECISION": "Needs a human call (holds promotion until answered)",
    "BLOCKED": "Could not test honestly",
}
GATE_ALARM_TEXT = {
    "gate_misconfigured": "The PR smoke watcher is blocked: the gate is misconfigured (missing: {missing}).",
    "gate_fetch_failed": "The PR smoke watcher is blocked: listing PRs on GitHub failed {consecutiveFailures} times in a row.",
    "pr_migrations_refused": ("PR #{pr} changes backend migrations, so its preview can never be booted safely "
                              "against the shared dev database. No campaign."),
    "pr_warmup_stuck": ("PR #{pr}'s backend preview is live but /healthz has not turned healthy in time. "
                        "No campaign yet; the watcher settles it once the preview is ready."),
    "pr_run_stalled": ("The smoke campaign {runId} on PR #{pr} stopped stamping progress. Resume or abandon it: "
                       "that is a human call."),
    "pr_preflight_failed": "PR #{pr}'s preflight check failed ({reason}); no campaign.",
    "coordinator_lease_unavailable": "The PR smoke watcher could not take the coordinator lease.",
}
ALARM_WORDS = {
    "controller_send_failed": "a chat post could not be delivered after its retries",
    "controller_send_budget": "the controller's chat budget for this run is spent",
    "controller_dispatch_ambiguous": "a judgment task may or may not have started; it is held for a human",
    "controller_obligation_overdue": "a step is past its deadline",
    "controller_verdict_superseded": "a GO no longer holds, so the run finishes BLOCKED",
    "controller_gh_failed": "a GitHub write failed",
    "controller_gate_refused": "the gate refused a terminal verb",
    "controller_no_authority": "this run's claim token is not held by the controller",
    "controller_dispatch_failed": "a judgment task could not be created",
    "controller_foreign_finish": "someone other than the controller finished this run",
    "controller_cutover_legacy_run": "a run claimed before the cutover surfaced; it stays with the legacy coordinator",
    "controller_run_released": "this run lost its gate slot without a verdict; its open steps were abandoned",
    "controller_step_failed": "a step for this run ended in a way the controller does not know how to act on",
    "controller_finish_unconfirmed": "verdict.json exists but the gate's completed state does not confirm the finish",
}
ONESHOT_TEXT = {
    "critic": (
        "Fresh design check for smoke run {runId} (PR #{pr}, build {sha12}). Dispatch a fresh provider-native "
        "`qa-design-critic` (model and effort from its agent definition) in the foreground with the graded "
        "viewport PNGs in {run}/contact-sheet/, the {run}/contact-sheet/design-system/ folder and, for each tile "
        "manifest.json marks `changed`, its *-base.png and *-diff.png, asking what the change broke. Never grade "
        "*-full.png; an `unsettled` tile is not BROKEN evidence on its own. Then write its lines to "
        "{run}/contact-sheet/critic.json as {{\"screens\":[{{\"screen\":...,\"grade\":...,\"reason\":...}}],"
        "\"notes\":[...]}} and append each to {critic_log} as "
        "{{runId, screen, grade, reason, ts}}. Write {run}/controller/dispatch-critic.started first. Never post, "
        "finish, file issues or touch any other run file."),
    "adjudicator": (
        "Fresh dispute adjudication for smoke run {runId} (PR #{pr}, build {sha12}). Dispatch a fresh "
        "provider-native `qa-adjudicator` (model and effort from its agent definition) in the foreground on the "
        "disputed findings named in {run}/controller/adjudication-request.md, with only the evidence that file "
        "names. Write its ruling to {run}/controller/adjudication.json. Write "
        "{run}/controller/dispatch-adjudicator.started first. Never post, finish or file."),
}
ONESHOT_ARTIFACTS = {"critic": "contact-sheet/critic.json", "adjudicator": "controller/adjudication.json"}
# The owner steps a phase barrier gates. Their briefs carry a pointer to the
# barrier's published answer (_brief_notes); the others have no barrier to cite.
BARRIER_STEPS = ("lanes", "synthesis")

OWNER_BRIEF = {
    "intake": (
        "Intake for this run, as the retained technical owner (pr-campaign skill flow, steps 1-2). The gate "
        "already claimed the slot: its wake is {run}/controller/wake.json -- treat every field as frozen input "
        "and use its coordinatorOwnerToken as SMOKE_GATE_OWNER for every smoke-run-scaffold.sh writer. Pin the "
        "journeys, disposition every unmappedPaths entry, run the source search and freeze intake. When a "
        "frontend preview exists, build the contact sheet (shots, capture, design-system fetch) -- but do NOT "
        "dispatch the design critic: the controller does. Write {run}/controller/root-summary.md: one or two "
        "plain sentences saying what the build changes and what will be tested (no machine tokens). Write "
        "completion-contract.json LAST, with the scaffold `contract` command: it is the signal that intake is "
        "done, and the controller posts the root as soon as it exists."),
    "lanes": (
        "Lanes: the same retained qa-smoke-worker executes this side's declared lanes and writes markers only "
        "after evidence is durable; it does not spawn lane workers. The outer coordinator awaits that owner. "
        "If the work cannot finish in one turn, checkpoint and call continue_work before yielding; this does "
        "not prove same-child continuity after replacement. Recheck sourceSha against the PR head before "
        "each lane; if it moved, stop and write the lane markers as void (BLOCKED_BUILD_IDENTITY). "
        "PAIR IDENTITY (the pair-identity note above gives this run's exact commands): freeze the deployed PR "
        "preview pair with `smoke-pair-identity.sh start` BEFORE the first lane, and `check` it at every lane's "
        "start and end: the controller cannot publish GO without a clean record in "
        "{run}/coordinator/identity-checks.ndjson. A check "
        "that reports drift or source-mismatch is genuine: re-freeze once with `refreeze` and redispatch, or "
        "conclude BLOCKED -- never run `start` again."),
    "preliminary": (
        "Preliminary: write {run}/coordinator/preliminary.md from the lane evidence, before reading anything under "
        "{run}/challenger/."),
    "synthesis": (
        "Synthesis: record a final pair-identity `check` (labelled `synthesis`, with the frozen ids the "
        "pair-identity note above names), run the synthesis barrier, then write {run}/coordinator/synthesis.md "
        "and {run}/synthesis.json "
        "(the skill's machine-readable verdict file: your verdict, the frozen sourceSha, laneGenerations from the "
        "contract, and a disposition for every confirmed finding, every lane without a passing marker and every "
        "challenger dissent id -- leave one open rather than change the verdict to fit). Write {run}/run-record.md "
        "(the run record the controller posts as the PR comment: lane detail, design check, recovery history). Write "
        "{run}/controller/verdict-bullets.md: at most three plain-language bullets for the verdict post (what "
        "blocks or was proven; what was not challenged or not demonstrable; the next owner). For each confirmed "
        "finding write {run}/controller/issues/<findingId>.json: {{\"title\":...,\"body\":...,\"labels\":[...]}}. "
        "The controller files them, posts the verdict, comments on the PR and runs `finish`. To ask for a fresh "
        "adjudicator instead, write {run}/controller/adjudication-request.md (the disputed findings and their "
        "evidence), no synthesis.json, and stop: you are woken again as `adjudicated`."),
    "adjudicated": (
        "Adjudicated: the fresh adjudicator's ruling is in {run}/controller/adjudication.json. Apply it and finish "
        "the synthesis exactly as the `synthesis` step describes (synthesis.md, synthesis.json, run-record.md, "
        "verdict-bullets.md, issue files)."),
}


class EffectLayer:
    """The single choke point for external effects.

    shadow: perform() records the would-be effect and returns shadow_refused;
    nothing runs. live: perform() runs the effect and returns its outcome:
      send        enqueued | replay | budget | failed | unknown
      gh          done | failed | unknown
      gate        ok | refused | unknown
      ncl_create  created(taskId) | failed | unknown
      owner_wake  brief_written | failed
    `unknown` means the outcome could not be established (timeout, 5xx, a
    crash of the helper): the obligation stays open and the next fire
    reconciles it -- never a blind retry.
    """

    LIVE_REQUIRED = ("repo", "send_to", "gate_cmd", "enqueue_cmd", "gh_cmd", "ncl_cmd")

    def __init__(self, mode, cfg=None):
        if mode not in ("shadow", "live"):
            raise ControllerError("mode {!r} is not an effect mode (shadow|live)".format(mode))
        self.mode = mode
        self.cfg = dict(cfg or {})
        self.performed = []
        self.ctl = None
        if mode == "live":
            missing = [k for k in self.LIVE_REQUIRED if not self.cfg.get(k)]
            if missing:
                raise ControllerError("live mode needs {}".format(", ".join("--" + k.replace("_", "-") for k in missing)))
            self.gate = ["bash", self.cfg["gate_cmd"]]
            self.gh = shlex.split(self.cfg["gh_cmd"])
            self.ncl = shlex.split(self.cfg["ncl_cmd"])
            self.enqueue = shlex.split(self.cfg["enqueue_cmd"])
            self.allowed = [tuple(self.gate), tuple(self.gh), tuple(self.ncl), tuple(self.enqueue)]

    def bind(self, ctl):
        self.ctl = ctl

    def perform(self, effect):
        self.performed.append(effect)
        if self.mode != "live":
            # The would-be effect is recorded, never run. No subprocess, no
            # socket, no file outside --out-dir is touched on this path.
            return {"outcome": "shadow_refused"}
        handler = {"send": self._send, "gh": self._gh, "gate": self._gate, "ncl_create": self._dispatch,
                   "owner_wake": self._owner_wake, "barrier_report": self._barrier_report}.get(effect.get("type"))
        if handler is None:
            raise ControllerError("unknown effect type {!r}".format(effect.get("type")))
        try:
            return handler(effect)
        except ControllerError as exc:
            return {"outcome": "failed", "error": str(exc)[:300]}
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return {"outcome": "unknown", "error": "{}: {}".format(type(exc).__name__, exc)[:300]}

    def keepalive(self, run_id, token):
        """Live: stamp gate `progress` so the claim stays live (a run goes
        reclaimable PROGRESS_STALE_SECONDS after its last stamp,
        smoke-pr-gate.sh:1464-1478). Not an obligation and never counted as an
        effect: shadow is a no-op."""
        if self.mode != "live":
            return None
        rc, out, err = self._run(self.gate + ["progress", run_id, token], 20)
        doc = last_json_line(out) if rc is not None else None
        if doc and doc.get("ok") is True:
            return {"ok": True}
        return {"ok": False, "error": (doc or {}).get("error") or err or "rc={}".format(rc)}

    # -- plumbing -------------------------------------------------------------

    def _left(self):
        deadline = self.cfg.get("deadline")
        return (deadline - time.time() - 2) if deadline else 60

    def _run(self, argv, timeout):
        env = None
        if tuple(argv[:len(self.gate)]) == tuple(self.gate):
            # Every gate verb the controller runs is the controller's: the
            # gate refuses progress/finish/challenger-timeout on a run whose
            # recorded claimant differs (smoke-pr-gate.sh claimant_guard).
            env = dict(os.environ, SMOKE_GATE_CLAIMANT="controller")
        return spawn(argv, min(timeout, self._left()), self.allowed, env=env)

    def _claim(self, run_id):
        ob = self.ctl.obligations().get(obligation_key(run_id, "run", "claim")) or {}
        detail = ob.get("detail") or {}
        claim = self.ctl.gate.active_claims().get(run_id) or {}
        pr = detail.get("pr") or claim.get("pr") or self.ctl.gate.pr_for_run(run_id)
        sha = claim.get("sha") or detail.get("sha") or ""
        return {"pr": pr, "sha": sha, "token": detail.get("ownerToken"), "deadline": claim.get("deadline"),
                "wake": detail.get("wake")}

    def _run_dir(self, run_id):
        return os.path.join(self.ctl.args.run_root, run_id)

    def _read_text(self, path, limit=60000):
        try:
            if not nonempty_file(path):
                return None
            with open(path, "rb") as fh:
                return fh.read(limit).decode("utf-8", "replace").strip()
        except OSError:
            return None

    def _payload_dir(self, run_id):
        return ["payloads", run_id]

    # -- send -------------------------------------------------------------------

    def _render(self, effect):
        """(text, files). Deterministic from the run's artifacts; rendered once
        per attempt id and persisted, so a replay re-sends identical bytes."""
        run_id, slot = effect["runId"], effect["slot"]
        hint = effect.get("hint") or {}
        if run_id.startswith(PSEUDO_PREFIX) and hint.get("gateAlarm") is not None:
            data = hint.get("gateAlarm") or {}
            tmpl = GATE_ALARM_TEXT.get(data.get("trigger"))
            fields = {k: data.get(k) for k in ("missing", "consecutiveFailures", "pr", "runId", "reason")}
            try:
                text = tmpl.format(**fields) if tmpl else None
            except (KeyError, IndexError):
                text = None
            if not text:
                text = "The PR smoke gate raised {}: {}".format(data.get("trigger"), json.dumps(data, sort_keys=True)[:600])
            return text, []
        if run_id.startswith(PSEUDO_PREFIX):
            trig = hint.get("trigger") or "alarm"
            detail = hint.get("detail")
            return "**Smoke controller alarm — {}**\n{}".format(
                ALARM_WORDS.get(trig, trig), json.dumps(detail, sort_keys=True)[:600] if detail else ""), []
        c = self._claim(run_id)
        run = self._run_dir(run_id)
        pr_line = "PR #{} (https://github.com/{}/pull/{})".format(c["pr"], self.cfg["repo"], c["pr"])
        tail = "Run `{}` · build `{}`".format(run_id, (c["sha"] or "")[:12])
        if slot == "root":
            summary = self._read_text(os.path.join(run, "controller", "root-summary.md"), 1500) or \
                "What changed and what will be tested is in the run record."
            deadline = parse_iso(c["deadline"])
            when = deadline.astimezone().strftime("%a %H:%M %Z") if deadline else "the gate's deadline"
            lines = []
            critic, err = read_json_file(os.path.join(run, CRITIC_ARTIFACT))
            if not err and isinstance(critic, dict):
                for s in critic.get("screens") or []:
                    if isinstance(s, dict):
                        lines.append("- {} · {} — {}".format(s.get("grade"), s.get("screen"), s.get("reason")))
                for note in critic.get("notes") or []:
                    lines.append("- NOTE · {}".format(note))
            design = "\n".join(lines[:12]) if lines else "- not in by the root post; see the run record"
            text = ("**Smoke campaign started — {}**\n{}\n{} please challenge every declared lane once its evidence "
                    "lands, and file your own disposition before reading the preliminary. Deadline {}. The frozen "
                    "build identity and both preview hosts are in the run record.\nDesign check:\n{}\n{}").format(
                pr_line, summary, self.cfg.get("challenger_mention") or "Challenger:", when, design, tail)
            return text, []
        if slot == "root-sheet":
            return "", [os.path.join(run, "contact-sheet", "sheet.png")]
        if slot == "verdict":
            verdict = hint.get("verdict")
            failed = hint.get("failedChecks") or []
            bullets = []
            syn, _ = read_json_file(os.path.join(run, "synthesis.json"))
            if isinstance(syn, dict) and syn.get("verdict") == verdict:
                owned = self._read_text(os.path.join(run, "controller", "verdict-bullets.md"), 3000) or ""
                bullets = [ln.strip() for ln in owned.splitlines() if ln.strip()][:3]
            if failed:
                bullets = ["- Not cleared: {}".format("; ".join(str(f) for f in failed[:2]))] + bullets[:2]
            bullets = [b if b.startswith(("-", "*", "•")) else "- " + b for b in bullets]
            text = "**{} — {}**\n{}\n- Full run record: the run-record comment on {}\n{}".format(
                pr_line, VERDICT_CHAT.get(verdict, verdict), "\n".join(bullets), pr_line, tail).replace("\n\n", "\n")
            return text, []
        if slot.startswith("alarm:"):
            trig = hint.get("trigger") or "alarm"
            detail = hint.get("detail")
            text = "**Smoke controller alarm — {}** ({})\n{}\n{}".format(
                ALARM_WORDS.get(trig, trig), pr_line, json.dumps(detail, sort_keys=True)[:600] if detail else "",
                tail).replace("\n\n", "\n")
            return text, []
        raise ControllerError("no renderer for send slot {!r}".format(slot))

    def _send(self, effect):
        run_id, mid = effect["runId"], effect["messageId"]
        name = mid.replace("#", "-")
        root = self.ctl.journal.dir
        doc_parts = self._payload_dir(run_id) + [name + ".json"]
        doc_path = os.path.join(root, *doc_parts)
        existing, err = read_json_file(doc_path)
        if err == "missing":
            text, files = self._render(effect)
            write_contained_once(root, doc_parts, json.dumps({"text": text, "files": files}, sort_keys=True))
            existing, err = read_json_file(doc_path)
        if err or not isinstance(existing, dict):
            raise ControllerError("send payload {} unreadable: {}".format(doc_path, err))
        text_path, _ = write_contained_once(root, self._payload_dir(run_id) + [name + ".txt"], existing.get("text") or "")
        argv = self.enqueue + ["--id", mid, "--to", self.cfg["send_to"], "--text-file", text_path,
                               "--thread-key", effect["threadKey"], "--run-id", effect.get("budgetRun") or run_id,
                               "--fire", self.ctl.fire]
        if effect.get("fingerprint"):
            argv += ["--fingerprint", effect["fingerprint"]]
        for f in existing.get("files") or []:
            argv += ["--file", f]
        if self.cfg.get("outbox_root"):
            argv += ["--outbox-root", self.cfg["outbox_root"]]
        rc, out, errtext = self._run(argv, 30)
        doc = last_json_line(out) if rc is not None else None
        if not doc:
            return {"outcome": "unknown", "error": (errtext or "no output")[:300]}
        if doc.get("ok") is True and doc.get("outcome") in ("enqueued", "replay"):
            return {"outcome": doc["outcome"], "seq": doc.get("seq")}
        code = doc.get("code")
        if code == "budget":
            return {"outcome": "budget", "error": doc.get("error")}
        if code in ("invalid", "mismatch"):
            return {"outcome": "failed", "error": "{}: {}".format(code, doc.get("error"))[:300]}
        return {"outcome": "unknown", "error": str(doc.get("error"))[:300]}

    # -- GitHub -------------------------------------------------------------------

    def _gh_json_lines(self, api_path, timeout=25):
        """(objects, error) from `gh api <path> --paginate --jq '.[]'`."""
        rc, out, err = self._run(self.gh + ["api", api_path, "--paginate", "--jq", ".[]"], timeout)
        if rc != 0:
            return None, (err or "rc={}".format(rc)).strip()[:200]
        objs = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                doc = json.loads(line)
            except ValueError:
                return None, "unparsable gh api output"
            if isinstance(doc, dict):
                objs.append(doc)
        return objs, None

    def _since(self, run_id, kind, slot):
        ob = self.ctl.obligations().get(obligation_key(run_id, kind, slot))
        started = parse_iso(ob["history"][0].get("at")) if ob else None
        return iso((started or self.ctl.now) - dt.timedelta(minutes=10))

    def _gh(self, effect):
        run_id, slot, marker = effect["runId"], effect["slot"], effect["marker"]
        c = self._claim(run_id)
        repo, pr = self.cfg["repo"], c["pr"]
        if not pr:
            return {"outcome": "failed", "error": "no PR number for this run"}
        since = self._since(run_id, "gh", slot)
        root = self.ctl.journal.dir
        key = obligation_key(run_id, "gh", slot)
        if slot == "freeze-close":
            state = self._pr_state(pr)
            if state in ("CLOSED", "MERGED"):
                return {"outcome": "done", "via": "search", "state": state}
            if state is None:
                return {"outcome": "unknown", "error": "gh pr view failed"}
            self._run(self.gh + ["pr", "close", str(pr), "-R", repo], 30)
            state = self._pr_state(pr)
            if state in ("CLOSED", "MERGED"):
                return {"outcome": "done", "via": "write", "state": state}
            return {"outcome": "unknown", "error": "pr still {} after close".format(state)}
        if slot == "pr-comment":
            api = "repos/{}/issues/{}/comments?since={}&per_page=100".format(repo, pr, since)
            found, err = self._find_marker(api, marker)
            if err:
                return {"outcome": "unknown", "error": err}
            if found:
                return {"outcome": "done", "via": "search", "url": found}
            body = self._run_record(run_id, c, effect.get("hint") or {})
            path, _ = write_contained_once(root, self._payload_dir(run_id) + [key[:16] + "-pr-comment.md"],
                                           "{}\n{}\n".format(marker, body))
            self._run(self.gh + ["pr", "comment", str(pr), "-R", repo, "--body-file", path], 30)
            found, err = self._find_marker(api, marker)
            if found:
                return {"outcome": "done", "via": "write", "url": found}
            return {"outcome": "unknown", "error": err or "comment not found on read-back"}
        if slot.startswith("issue:"):
            fid = slot[len("issue:"):]
            api = "repos/{}/issues?state=all&since={}&per_page=100".format(repo, since)
            found, err = self._find_marker(api, marker)
            if err:
                return {"outcome": "unknown", "error": err}
            if found:
                return {"outcome": "done", "via": "search", "url": found}
            title, body, labels = self._issue_content(run_id, fid, c)
            # SI: dedup against open smoke-finding issues by normalized title.
            rc, out, errtext = self._run(self.gh + ["issue", "list", "-R", repo, "--label", "smoke-finding", "--state",
                                                    "open", "--limit", "500", "--json", "number,title,url"], 25)
            if rc != 0:
                return {"outcome": "unknown", "error": (errtext or "issue list rc={}".format(rc))[:200]}
            try:
                open_issues = json.loads(out or "[]")
            except ValueError:
                return {"outcome": "unknown", "error": "unparsable gh issue list output"}
            norm = normalize_title(title)
            for issue in open_issues if isinstance(open_issues, list) else []:
                if isinstance(issue, dict) and normalize_title(issue.get("title")) == norm:
                    return {"outcome": "done", "via": "dedup", "url": issue.get("url"), "duplicateOf": issue.get("number")}
            path, _ = write_contained_once(root, self._payload_dir(run_id) + [key[:16] + "-issue.md"],
                                           "{}\n{}\n".format(body, marker))
            argv = self.gh + ["issue", "create", "-R", repo, "--title", title, "--body-file", path]
            for label in labels:
                argv += ["--label", label]
            self._run(argv, 30)
            found, err = self._find_marker(api, marker)
            if found:
                return {"outcome": "done", "via": "write", "url": found}
            return {"outcome": "unknown", "error": err or "issue not found on read-back"}
        return {"outcome": "failed", "error": "no GitHub handler for slot {!r}".format(slot)}

    def _run_record(self, run_id, claim, hint):
        """The PR's run-record comment body. The owner's prose where it wrote
        any -- run-record.md, else synthesis.md (27 of the 30 replayed runs
        wrote it at the run root; the legacy prompt names coordinator/) --
        otherwise a record rendered from synthesis.json and the verdict, so a
        finished run always gets its comment."""
        run = self._run_dir(run_id)
        for rel in ("run-record.md", "synthesis.md", os.path.join("coordinator", "synthesis.md")):
            text = self._read_text(os.path.join(run, rel))
            if text:
                return text
        verdict = hint.get("verdict")
        lines = ["# Smoke run record", "", "Run `{}` on build `{}`: **{}**.".format(
            run_id, (claim["sha"] or "")[:12], VERDICT_CHAT.get(verdict, verdict or "no verdict"))]
        for f in hint.get("failedChecks") or []:
            lines.append("- Not cleared: {}".format(f))
        syn, err = read_json_file(os.path.join(run, "synthesis.json"))
        if not err and isinstance(syn, dict):
            for f in syn.get("findings") or []:
                if isinstance(f, dict):
                    lines.append("- Finding {}: {}".format(f.get("id"), f.get("disposition") or "no disposition"))
        lines += ["", "The owner wrote no prose record; lane evidence is in the run directory."]
        return "\n".join(lines)

    def _find_marker(self, api, marker):
        objs, err = self._gh_json_lines(api)
        if err:
            return None, err
        for o in objs:
            if marker in str(o.get("body") or ""):
                return o.get("html_url") or o.get("url") or "found", None
        return None, None

    def _pr_state(self, pr):
        rc, out, _ = self._run(self.gh + ["pr", "view", str(pr), "-R", self.cfg["repo"], "--json", "state"], 20)
        if rc != 0:
            return None
        try:
            return str(json.loads(out).get("state") or "").upper() or None
        except (ValueError, AttributeError):
            return None

    def _issue_content(self, run_id, fid, claim):
        run = self._run_dir(run_id)
        labels = ["smoke-finding"]
        doc, err = read_json_file(os.path.join(run, "controller", "issues", "{}.json".format(fid)))
        if safe_component(fid) and not err and isinstance(doc, dict) and isinstance(doc.get("title"), str) \
                and doc["title"].strip():
            for label in doc.get("labels") or []:
                if isinstance(label, str) and label.strip() and label not in labels:
                    labels.append(label.strip())
            return doc["title"].strip()[:250], str(doc.get("body") or "").strip() or doc["title"], labels
        # The owner did not write the finding's issue file: file the machine
        # record rather than hold the run on it.
        syn, _ = read_json_file(os.path.join(run, "synthesis.json"))
        finding = next((f for f in (syn or {}).get("findings") or [] if isinstance(f, dict) and f.get("id") == fid), {})
        title = "Smoke finding {} on PR #{}".format(fid, claim["pr"])
        body = "Confirmed by smoke run `{}` on build `{}`.\n\n```json\n{}\n```\n\nEvidence: see the run record.".format(
            run_id, (claim["sha"] or "")[:12], json.dumps(finding, sort_keys=True, indent=1)[:4000])
        return title, body, labels

    # -- gate ---------------------------------------------------------------------

    def _gate(self, effect):
        run_id, verb = effect["runId"], effect["verb"]
        token = self._claim(run_id)["token"]
        if not token:
            return {"outcome": "refused", "error": "no owner token: this controller did not receive the claim"}
        argv = self.gate + [verb] + list(effect["args"]) + [token]
        rc, out, err = self._run(argv, 60)
        doc = last_json_line(out) if rc is not None else None
        if not doc:
            return {"outcome": "unknown", "error": (err or "no output")[:300]}
        if doc.get("ok") is True:
            keep = {k: doc[k] for k in ("verdict", "finishedAt", "idempotent", "handoff", "verdictDigest") if k in doc}
            return {"outcome": "ok", "result": keep}
        error = str(doc.get("error") or "")
        if "busy" in error or "not the active run" in error or doc.get("retryable") is True:
            # Transient, or the slot moved: the next fire's derivation sees the
            # verdict / release and settles it.
            return {"outcome": "unknown", "error": error[:300]}
        return {"outcome": "refused", "error": error[:300]}

    # -- ncl one-shots ------------------------------------------------------------

    def _dispatch(self, effect):
        run_id, slot = effect["runId"], effect["slot"]
        c = self._claim(run_id)
        tmpl = ONESHOT_TEXT.get(slot)
        if not tmpl:
            return {"outcome": "failed", "error": "no one-shot brief for slot {!r}".format(slot)}
        prompt = tmpl.format(runId=run_id, pr=c["pr"], sha12=(c["sha"] or "")[:12], run=self._run_dir(run_id),
                           critic_log=self.cfg.get("critic_log") or "the workgroup design-critic log") + \
            "\n\n" + effect["marker"]
        argv = self.ncl + ["tasks", "create", "--name", effect["name"], "--prompt", prompt,
                           "--process-after", iso(self.ctl.now), "--isolated", "--mute-chat", "--json"]
        if self.cfg.get("oneshot_model"):
            argv += ["--model", self.cfg["oneshot_model"]]
        if self.cfg.get("oneshot_effort"):
            argv += ["--effort", self.cfg["oneshot_effort"]]
        rc, out, err = self._run(argv, 40)
        try:
            doc = json.loads(out) if rc is not None and out.strip() else None
        except ValueError:
            doc = None
        if not isinstance(doc, dict):
            return {"outcome": "unknown", "error": (err or "no output")[:300]}
        if doc.get("ok") is True and isinstance(doc.get("data"), dict) and doc["data"].get("series_id"):
            return {"outcome": "created", "taskId": doc["data"]["series_id"]}
        if doc.get("ok") is False:
            return {"outcome": "failed", "error": str((doc.get("error") or {}).get("message") or doc.get("error"))[:300]}
        return {"outcome": "unknown", "error": "unrecognized ncl response"}

    # -- owner briefs -------------------------------------------------------------

    def _owner_wake(self, effect):
        run_id, step = effect["runId"], effect["step"]
        prior = self.ctl.obligations().get(obligation_key(run_id, "owner", step)) or {}
        pending = (prior.get("detail") or {}).get("dispatchIntent")
        if effect.get("dispatchEvent") and pending:
            # Admission may have committed before the CLI reply was lost. Replay
            # the exact saved envelope without clearing its owner's ack again.
            return self._dispatch_owner_intent(run_id, step, pending)
        c = self._claim(run_id)
        run = self._run_dir(run_id)
        head = ("# Controller brief: {step}\n\nRun `{run_id}` · PR #{pr} · build `{sha}` · run dir {run}\n\n"
                "You are the retained owner. Do only this step, write only artifacts, then stop: never post to chat, "
                "never run a gate verb (`finish`, `challenger-timeout`, `release`), never file or comment on GitHub. "
                "The controller does all of that from what you write.\n\n").format(
            step=step, run_id=run_id, pr=c["pr"], sha=c["sha"], run=run)
        body = OWNER_BRIEF.get(step, "Step {}: see the owner router.".format(step)).format(run=run)
        root = self.ctl.args.run_root
        # THE WAKE IS THE ONLY PLACE THE OWNER LEARNS ITS OWNER TOKEN -- the
        # intake brief says so in as many words ("use its coordinatorOwnerToken
        # as SMOKE_GATE_OWNER for every smoke-run-scaffold.sh writer"). But the
        # gate mints a FRESH token on every same-run recovery poll
        # (smoke-pr-gate.sh:5312, written to lease/authority/state at :5341,
        # :5346, :5389), and reconcile_claims records the new one the wake
        # carries. Writing wake.json only at intake left the run tree naming a
        # RETIRED token while the brief still told the owner to use it: every
        # scaffold write, and `adopt` -- the verb that exists for exactly this
        # transition (smoke-run-scaffold.sh:696, and its own header says so) --
        # then dies in begin_active_run_fence's owner check
        # (smoke-run-scaffold.sh:267-269)
        # with no legitimate way back. XZO #2046, run
        # xzo-pr-pr2055-dacf01328421-20260921T193111Z. It is refreshed on EVERY
        # step so the file the brief points at always names the live token.
        # AN ACK NEVER OUTLIVES THE BRIEF IT ACKNOWLEDGED. The ack is the
        # owner's first act on a wake and the controller only tests it for
        # existence, re-offering a wake solely while it is ABSENT (owner_step,
        # :2329-2339); the renewer reads it the same way
        # (smoke-controller-renew.sh, "brief-<step>.ack absent: no owner turn
        # holds this step"). So a brief rewritten under a NEW owner token would
        # otherwise inherit the previous brief's ack and be treated as taken,
        # and never re-offered -- the second half of XZO #2046. Removing it here
        # makes that impossible by construction rather than by sequencing: this
        # function runs only when the obligation is absent or `intent`
        # (owner_step, :2306), never while a live brief is enqueued, so any ack
        # it finds belongs to a brief this write supersedes.
        try:
            dfd = _open_dir_contained(root, [run_id, "controller"], True)
        except ControllerError:
            dfd = None
        if dfd is not None:
            try:
                os.unlink("brief-{}.ack".format(step), dir_fd=dfd)
            except OSError:
                pass
            finally:
                os.close(dfd)
        if c.get("wake"):
            write_contained_atomic(root, [run_id, "controller", "wake.json"],
                                   json.dumps(c["wake"], sort_keys=True, indent=1) + "\n")
        notes = self._brief_notes(run_id, step, run, c)
        write_contained_atomic(root, [run_id, "controller", "brief-{}.md".format(step)],
                               head + notes + body + "\n")
        # briefedToken and briefedRefusal are what make the two re-offer rules
        # re-derived invariants instead of edges: both are journaled by
        # owner_step only once the brief is actually on disk, so a crash before
        # that leaves the step still owing its re-offer. The refusal is read
        # back from the published report rather than taken from the caller, so
        # what is recorded is exactly what the owner can open and read.
        brief = {"outcome": "brief_written", "briefedToken": c.get("token"),
                "briefedRefusal": refusal_digest(
                    read_json_file(os.path.join(run, "controller", "barrier-{}.json".format(step)))[0]),
                "brief": os.path.join(run, "controller", "brief-{}.md".format(step))}
        if effect.get("dispatchEvent"):
            prompt = ("Run one bounded QA phase in this coordinator context. Read /app/skills/smoke-test/SKILL.md "
                      "and /app/skills/smoke-test/references/controller-phase-owner.md before work. "
                      "Campaign records carry prior findings; never recreate an accepted phase. "
                      "Keep one native qa-smoke-worker through this phase's build/test/repair. "
                      "The controller alone publishes campaign status/verdicts. No chat or GitHub sends.\n\n" + head + notes + body)
            pending = dict(brief, eventKey=effect["dispatchEvent"], retryOf=effect.get("retryOf"), prompt=prompt)
            self.ctl.record(run_id, "owner", step, "intent", detail={"dispatchIntent": pending})
            return self._dispatch_owner_intent(run_id, step, pending)
        return brief

    def _dispatch_owner_intent(self, run_id, step, pending):
        argv = self.ncl + ["tasks", "dispatch", "--context-key", "smoke/{}/{}".format(run_id, step),
                           "--event-key", pending["eventKey"], "--prompt", pending["prompt"],
                           "--isolated", "--mute-chat", "--quiet-status", "--json"]
        if pending.get("retryOf"):
            argv += ["--retry-of", pending["retryOf"]]
        rc, out, err = self._run(argv, 40)
        doc = last_json_line(out) if rc is not None else None
        data = doc.get("data") if isinstance(doc, dict) and doc.get("ok") is True else None
        if isinstance(data, dict) and data.get("admission") in ("inserted", "replay") and \
                data.get("row_id") and data.get("session_id"):
            return {"outcome": "admitted", "dispatch": dict(data, eventKey=pending["eventKey"]),
                    "briefedToken": pending.get("briefedToken"), "briefedRefusal": pending.get("briefedRefusal", "")}
        return {"outcome": "unknown", "error": str((doc or {}).get("error") or err or "dispatch unavailable")[:300]}

    def _barrier_report(self, effect):
        """Publish the phase barrier's own answer into the run tree.

        The barrier tells the controller exactly which artifact it rejects and
        why (smoke-evidence-barrier.sh -> invalid[]/invalidReasons[]). Before
        this, the controller kept that to its own decisions journal -- truncated
        to three reasons -- and woke the owner with a STATIC brief that said
        nothing about it (XZO #2047, run
        xzo-pr-pr2055-dacf01328421-20260921T193111Z: the lanes barrier named
        journeys/scope-dispositions.json invalid on the 19:51:35Z fire and the
        owner, the only party that could repair it, first learned of it at
        20:58Z by running the barrier itself). The file is rewritten every fire
        the phase is refused and removed the moment it passes, so it is never
        stale advice."""
        run_id, phase, doc = effect["runId"], effect["phase"], effect["barrier"]
        root = self.ctl.args.run_root
        name = "barrier-{}.json".format(phase)
        if doc is None:
            # Removed through the same containment the write uses, never by a
            # joined path: an unlink is as much a write as the write is.
            try:
                dfd = _open_dir_contained(root, [run_id, "controller"], False)
            except ControllerError:
                return {"outcome": "published"}
            try:
                os.unlink(name, dir_fd=dfd)
            except OSError:
                pass
            finally:
                os.close(dfd)
            return {"outcome": "published"}
        write_contained_atomic(root, [run_id, "controller", name],
                               json.dumps(doc, sort_keys=True, indent=1) + "\n")
        return {"outcome": "published"}

    def _brief_notes(self, run_id, step, run, claim):
        """Run-specific preamble the STATIC OWNER_BRIEF template cannot carry:
        what this fire's barrier refused, and whether the owner's token was
        reissued under it. Both are things the controller already knows at the
        moment it writes the brief and used to keep to its own journal."""
        out = []
        ob = self.ctl.obligations().get(obligation_key(run_id, "owner", step)) or {}
        if (ob.get("detail") or {}).get("tokenReissued"):
            out.append(
                "**YOUR OWNER TOKEN CHANGED (XZO #2046).** A recovery `poll` re-minted this run's coordinator "
                "lease under a fresh token, so the one you have been using is retired and every "
                "`smoke-run-scaffold.sh` write will be refused by its owner fence. Re-read "
                "`{run}/controller/wake.json` (refreshed with this brief), export its `coordinatorOwnerToken` as "
                "`SMOKE_GATE_OWNER`, and run `smoke-run-scaffold.sh adopt {run} {sha}` BEFORE any further "
                "artifact write. Do NOT copy a token out of gate state or any other actor's file: the one in "
                "wake.json is issued to you, which is what makes the adoption an adoption.".format(
                    run=run, sha=claim.get("sha") or "<frozen source sha>"))
        if step in BARRIER_STEPS:
            report = os.path.join(run, "controller", "barrier-{}.json".format(step))
            # The loud lead is for CONTENT the barrier rejects -- the thing only
            # the owner can repair and the thing #2055 never heard about. A
            # barrier that is merely waiting for markers the step is about to
            # write is not news, and saying it in the same words would train the
            # owner to skim past the one line that matters.
            doc, _err = read_json_file(report)
            refusing = bool(isinstance(doc, dict) and doc.get("invalid"))
            # Stated on EVERY barrier-backed brief, not only when the file
            # happens to exist as the brief is written: a brief is written once
            # and a barrier is re-run every fire, so a refusal that starts
            # later would otherwise still be invisible. The file itself is
            # rewritten (and removed) every fire, so it is always this fire's
            # answer.
            out.append(
                "{lead} The barrier's own answer for this run is `{report}`, rewritten every controller fire and "
                "removed once the phase passes. `invalid[]` names artifacts whose CONTENT the barrier rejects — "
                "they are yours to repair and no amount of lane work clears them — and `missing[]` names what is "
                "not written yet. Read it before you start and again before you report this step done: the phase "
                "cannot pass while `invalid[]` is non-empty, and the controller will not tell you twice.".format(
                    report=report,
                    lead=("**THE BARRIER IS ALREADY REFUSING THIS PHASE.**" if refusing
                          else "**CHECK THE BARRIER, DO NOT ASSUME IT.**")))
            identity = self._identity_note(run, claim)
            if identity:
                out.append(identity)
        return "".join(n + "\n\n" for n in out)

    def _identity_note(self, run, claim):
        """This run's exact pair-identity commands, or None for a run with no
        readable pr contract.

        XZO #2092: the controller required a clean pair-identity record for GO
        (validate_synthesis) and no brief ever asked for one, so the cadence
        ran only when an owner remembered SKILL.md -- pr2081's did, pr2088's
        did not, and pr2088 published BLOCKED over a clean GO. What the owner
        cannot be expected to remember is exactly what is mechanical here: the
        PR preview ids come from the gate's own resolution (`check <pr>`
        prints frontendPreviewId/backendPreviewId, smoke-pr-gate.sh:3066-3072,
        from evaluate_pr :2816-2820), and once frozen they are in
        identity.json. They go on the command line because the gate env the
        owner sources names the DEVELOP pair (controller-phase-owner.md tells
        it to source that env first) and `check` identifies the pair from its
        env (smoke-pair-identity.sh:61-62): run with that env, it compares the
        frozen preview against the wrong services and records a drift that is
        a real BLOCKED (:153-159)."""
        contract = read_json_file(os.path.join(run, "completion-contract.json"))[0]
        if not isinstance(contract, dict) or contract.get("ownershipKind") != "pr":
            return None
        frozen = read_json_file(os.path.join(run, "coordinator", "identity.json"))[0]
        enforced = contract.get("pairIdentity") == "required"
        tail = (" This run's contract requires it, so the barrier refuses this phase until the record is clean "
                "and names what to run in `invalid[]`." if enforced else "")
        if isinstance(frozen, dict) and isinstance(frozen.get("frontend"), dict) and \
                isinstance(frozen.get("backend"), dict):
            fe, be = frozen["frontend"].get("service"), frozen["backend"].get("service")
            return ("**PAIR IDENTITY: frozen (frontend `{fe}`, backend `{be}`).** Every check passes those two ids "
                    "on the command line -- the gate env you source names the develop pair, and a check against it "
                    "records a drift that BLOCKS this run: `SMOKE_GATE_FRONTEND_SERVICE={fe} "
                    "SMOKE_GATE_BACKEND_SERVICE={be} bash {tool} check {run} <label>`.{tail}").format(
                fe=fe, be=be, tool=PAIR_IDENTITY, run=shlex.quote(run), tail=tail)
        pr = contract.get("pr") or claim.get("pr") or "<pr>"
        gate = self.cfg.get("gate_cmd") or "smoke-pr-gate.sh"
        return ("**PAIR IDENTITY: NOT FROZEN.** Before the first lane runs, take `frontendPreviewId` and "
                "`backendPreviewId` from `bash {gate} check {pr}` (the PR preview pair -- never the develop ids the "
                "gate env names) and run `SMOKE_GATE_FRONTEND_SERVICE=<frontendPreviewId> "
                "SMOKE_GATE_BACKEND_SERVICE=<backendPreviewId> bash {tool} start {run}`. If it refuses because the "
                "live pair does not serve this run's sourceSha, that is genuine: conclude BLOCKED rather than work "
                "around it (an unreadable read may simply be retried).{tail}").format(
                    gate=gate, pr=pr, tool=PAIR_IDENTITY, run=shlex.quote(run), tail=tail)

    def owner_status(self, receipt):
        """Only the host can read another task session's execution state."""
        if self.mode != "live":
            return None
        rc, out, _ = self._run(self.ncl + ["tasks", "get", "--id", receipt["row_id"],
                                         "--session", receipt["session_id"], "--settlement", "--json"], 20)
        doc = last_json_line(out) if rc is not None else None
        return doc.get("data") if isinstance(doc, dict) and doc.get("ok") is True else None


def frozen_terminal_verb(detail):
    """The gate verb a frozen verdict finishes with. Journals written before
    the verb was recorded carry it only in the failed check's wording."""
    if detail.get("terminalVerb") in TERMINAL_VERBS:
        return detail["terminalVerb"]
    if any(str(f).startswith("challenger-timeout:") for f in detail.get("failedChecks") or []):
        return "challenger-timeout"
    return "finish"


def safe_component(name):
    return isinstance(name, str) and bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", name))


def normalize_title(title):
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(title or "").lower()).split())


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
                # activeLeaseOwner is the claim's owner token (poll writes it
                # with the slot, smoke-pr-gate.sh:5362-5366); live reads it
                # only to recover a claim whose wake was lost.
                out[run] = {"pr": pr, "sha": st.get("activeSha"), "deadline": st.get("challengerDeadline"),
                            "disposition": st.get("challengerDisposition"), "owner": st.get("activeLeaseOwner"),
                            "claimant": st.get("activeClaimant")}
        return out

    def run_verdict(self, run_id):
        doc, err = read_json_file(os.path.join(self.dir, "runs", run_id, "verdict.json"))
        if err == "missing":
            return None
        if err:
            return {"error": err}
        return doc

    def finish_state(self, run_id, verdict_doc):
        """Has the gate's `finish` COMPLETED for this run, not just written
        verdict.json? The gate writes verdict.json first (smoke-pr-gate.sh:
        4160-4176), then suspend/publish/hold/ledger, and only then clears the
        slot and records completedRunId/completedVerdict/completedVerdictDigest
        in one state write (:4557-4563). So:
          "held"      the slot is still this run's: finish is partial;
          "complete"  the completed state names this run and agrees with
                      verdict.json (verdict, and digest when recorded);
          "unknown"   neither: a successor overwrote the receipt, or the slot
                      moved without one."""
        for st in self.pr_states.values():
            if st.get("activeRunId") == run_id:
                return "held"
        for st in self.pr_states.values():
            if st.get("completedRunId") != run_id:
                continue
            if st.get("completedVerdict") not in (None, verdict_doc.get("verdict")):
                return "unknown"
            digest = st.get("completedVerdictDigest")
            if digest:
                try:
                    with open(os.path.join(self.dir, "runs", run_id, "verdict.json"), "rb") as fh:
                        raw = fh.read()
                except OSError:
                    return "unknown"
                # verdict_digest hashes the compact payload; the file holds it
                # plus one newline (smoke-pr-gate.sh:205-211, :4170).
                if hashlib.sha256(raw.rstrip(b"\n")).hexdigest() != digest:
                    return "unknown"
            return "complete"
        return "unknown"

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
        self.live = effects.mode == "live"
        self.now = now
        self.fire = fire
        self.decisions = []
        self.alarms = []
        self.step_errors = []  # steps whose outcome was not on the allowlist
        self.owner_wakes = []
        self.owner_cutover = self._load_json_arg(getattr(args, "owner_dispatch_cutover_json", None), None)
        if self.owner_cutover is not None:
            if not isinstance(self.owner_cutover, dict) or not isinstance(self.owner_cutover.get("enabled"), bool) or \
                    not isinstance(self.owner_cutover.get("legacyRuns"), list):
                raise ControllerError("owner dispatch cutover must declare enabled and enumerate legacyRuns")
            if not self.owner_cutover["enabled"]:
                self.owner_cutover = None
        # Obligation keys whose intent THIS process journaled and has not yet
        # attempted. Never inferred from the journal: an intent that existed
        # when the process started may have been attempted by a fire that died
        # (same fire id or not), so it always goes through reconciliation.
        self.planned = set()
        self.fire_sends = {}
        self.driven = set()  # send keys already driven this fire (settled at most once)
        self.receipts = self._load_json_arg(args.receipts_json, {})
        self.tasks = self._load_json_arg(args.tasks_json, [])
        self.pr_heads = {str(k): v for k, v in self._load_json_arg(args.pr_heads_json, {}).items()}
        self.poll = self._load_json_arg(args.poll_json, None)
        self.queued_alarms = self._load_alarm_queue(getattr(args, "alarm_queue_dir", None))
        # Cutover (live only): runs the gate had claimed when this controller
        # first went live. They finish under the legacy coordinator; this
        # controller never records, steps, stamps or finishes them.
        self.legacy = set()
        if self.live:
            cut = self._load_json_arg(getattr(args, "cutover_json", None), None)
            if not isinstance(cut, dict) or not isinstance(cut.get("legacyRuns"), list):
                raise ControllerError("live mode needs a readable --cutover-json {legacyRuns:[...]} -- refusing to "
                                      "guess which claimed runs belong to the legacy coordinator")
            self.legacy = {r for r in cut["legacyRuns"] if isinstance(r, str)}

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

    def publish_barrier(self, run_id, phase, barrier):
        """Put this fire's barrier answer where the OWNER can read it, or take
        a stale one away once the phase passes. Not an obligation: it carries
        no promise, it is a mirror of a check that is re-run every fire. Shadow
        refuses it like every other run-tree write."""
        self.effects.perform({"type": "barrier_report", "runId": run_id, "phase": phase,
                              "barrier": None if barrier is None else {
                                  "at": iso(self.now), "phase": phase,
                                  "ready": bool(barrier.get("ready")),
                                  "missing": barrier.get("missing") or [],
                                  "invalid": barrier.get("invalid") or [],
                                  "invalidReasons": barrier.get("invalidReasons") or []}})

    def record(self, run_id, kind, slot, state, attempt=None, detail=None):
        rec = {"at": iso(self.now), "fire": self.fire, "runId": run_id, "kind": kind, "slot": slot,
               "key": obligation_key(run_id, kind, slot), "state": state, "mode": self.effects.mode}
        if attempt:
            rec["attempt"] = attempt
        if detail:
            rec["detail"] = detail
        return self.journal.append(rec)

    def _load_alarm_queue(self, qdir):
        """Gate alarm wakes the live worker queued (wrapper/alarms/*.json).
        An unreadable entry refuses the fire: dropping it would lose a one-shot
        alarm the gate has already latched."""
        if not qdir:
            return []
        out = []
        for name in sorted(os.listdir(qdir)):
            if not name.endswith(".json"):
                continue
            doc, err = read_json_file(os.path.join(qdir, name))
            wake = doc.get("data") if isinstance(doc, dict) else None
            if err or not isinstance(wake, dict) or not wake.get("trigger"):
                raise ControllerError("queued gate alarm {} unreadable: {}".format(name, err or "no data.trigger"))
            out.append(wake)
        return out

    def decide(self, run_id, phase, dtype, cls, reason, **extra):
        d = {"at": iso(self.now), "fire": self.fire, "runId": run_id, "phase": phase, "type": dtype,
             "class": cls, "reason": reason, "mode": self.effects.mode}
        d.update(extra)
        self.decisions.append(d)
        # Appended and fsync'd as it is made, so a fire killed mid-way still
        # leaves the decisions it reached (the shadow's whole output).
        append_decision(self.journal.dir, d)
        return d

    def ensure_alarm(self, run_id, trigger, fingerprint, detail, slot=None, hint=None, thread_key=None):
        """The ONLY way an alarm is raised.

        1. Its send obligation is JOURNALED first, unconditionally: an intent
           at attempt 0 (no message id minted yet), outside every budget. A
           caller that is about to terminalize a source calls this first, so
           no terminal state is ever written without its alarm on record.
        2. Delivery is a separate step (send()), metered by the ALARM lane of
           the budget -- its own per-fire slots, and its own helper budget id
           (<runId>.alarms), so ordinary sends cannot starve it. A delivery
           the lane refuses this fire rolls to the next, where open alarms are
           drained before any run is stepped.
        Called on EVERY fire its condition holds, and never gated on a flag:
        the obligation, not a flag, is what settles it. True when raised now."""
        slot = slot or "alarm:" + fingerprint
        key = obligation_key(run_id, "send", slot)
        raised = key not in self.obligations()
        if raised:
            self.alarms.append({"trigger": trigger, "runId": run_id, "fingerprint": fingerprint, "detail": detail})
            self.decide(run_id, None, "alarm", "mechanical", trigger, fingerprint=fingerprint, detail=detail)
            rec = {"fingerprint": fingerprint, "hint": hint or {"trigger": trigger, "detail": detail}, "alarm": True}
            if thread_key:
                rec["threadKey"] = thread_key
            crash_point("before-intent", "send", slot)
            self.record(run_id, "send", slot, "intent", None, rec)
            crash_point("after-journal", "send", slot)
        if key not in self.driven:
            self.send(run_id, "alarm", slot)
        return raised

    # -- effects ------------------------------------------------------------

    def _budget_refusal(self, run_id, fingerprint, lane):
        """(scope, reason) or None, within one LANE (alarm or ordinary): each
        lane has the helper's limits on its own, so the two never starve each
        other. scope `fire` clears next fire; `run` and `fingerprint` never."""
        obs = [o for o in self.obligations().values()
               if o["runId"] == run_id and o["kind"] == "send" and is_alarm_send(run_id, o["slot"]) == lane]
        sent_attempts = sum(o["attempt"] for o in obs)
        if self.fire_sends.get((run_id, lane), 0) >= BUDGET_PER_FIRE:
            return "fire", "per-fire budget {} reached".format(BUDGET_PER_FIRE)
        if sent_attempts >= BUDGET_PER_RUN:
            return "run", "per-run budget {} reached".format(BUDGET_PER_RUN)
        if fingerprint:
            same = [o for o in obs if o["detail"].get("fingerprint") == fingerprint]
            if sum(o["attempt"] for o in same) >= BUDGET_PER_FINGERPRINT:
                return "fingerprint", "per-fingerprint budget {} reached for {}".format(BUDGET_PER_FINGERPRINT,
                                                                                         fingerprint)
        return None

    def _budget_refused(self, run_id, phase, slot, attempt, scope, reason):
        """Over budget: no delivery. A per-fire refusal waits for the next fire
        (an alarm's journaled intent stays open and is drained first). A
        per-run or per-fingerprint one never clears, so the obligation goes
        failed_terminal -- which permits only finish BLOCKED (spec rev 3) --
        and, for an ordinary send, its alarm is journaled BEFORE that."""
        self.decide(run_id, phase, "alarm", "mechanical", "controller_send_budget", slot=slot, detail=reason)
        if scope == "fire":
            if not is_alarm_send(run_id, slot):
                self.alarms.append({"trigger": "controller_send_budget", "runId": run_id, "detail": reason,
                                    "slot": slot})
            return "budget"
        key = obligation_key(run_id, "send", slot)
        if not is_alarm_send(run_id, slot):
            self.ensure_alarm(run_id, "controller_send_budget", "send-budget:{}".format(key[:12]),
                              {"slot": slot, "reason": reason})
        self.record(run_id, "send", slot, "failed_terminal", attempt or None,
                    {"reason": "controller_send_budget: {}".format(reason)})
        return "failed_terminal"

    def _effect_failed(self, run_id, kind, slot, attempt, result, trigger):
        """A failed/unknown effect leaves the SAME attempt open (its re-run is
        idempotent: enqueue-send replays by id, GitHub searches its marker).
        MAX_EFFECT_FAILURES in a row make it terminal."""
        ob = self.obligations().get(obligation_key(run_id, kind, slot)) or {"detail": {}}
        n = int(ob["detail"].get("effectFailures") or 0) + 1
        detail = {"effectFailures": n, "outcome": result.get("outcome"), "error": result.get("error")}
        if n >= MAX_EFFECT_FAILURES:
            # Alarm intent BEFORE the terminal record: a kill between the two
            # re-runs this path next fire (the obligation is still open),
            # never a terminal state with no alarm behind it.
            if not is_alarm_send(run_id, slot):
                self.ensure_alarm(run_id, trigger, "{}:{}".format(trigger, obligation_key(run_id, kind, slot)[:12]),
                                  {"slot": slot, "error": result.get("error")})
            self.record(run_id, kind, slot, "failed_terminal", attempt, dict(detail, reason="{} failures".format(n)))
            return "failed_terminal"
        self.record(run_id, kind, slot, "intent", attempt, detail)
        return "intent"

    def _send_exhausted(self, run_id, slot, key, attempt):
        if not is_alarm_send(run_id, slot):
            self.ensure_alarm(run_id, "controller_send_failed", "send-failed:{}".format(key[:12]),
                              {"slot": slot, "attempts": attempt})
        self.record(run_id, "send", slot, "failed_terminal", attempt, {"reason": "{} attempts failed".format(attempt)})
        return "failed_terminal"

    def send(self, run_id, phase, slot, fingerprint=None, hint=None, thread_key=None):
        """Chat send obligation with attempt-scoped ids and receipt recovery."""
        key = obligation_key(run_id, "send", slot)
        self.driven.add(key)
        ob = self.obligations().get(key)
        if ob and ob["state"] in TERMINAL_OK | {"abandoned", "failed_terminal"}:
            return ob["state"]
        attempt = ob["attempt"] if ob else 0
        if ob and ob["state"] == "failed" and attempt >= MAX_SEND_ATTEMPTS:
            # Killed between journaling the last attempt's failed receipt and
            # its failed_terminal: finish that path, never a new attempt.
            return self._send_exhausted(run_id, slot, key, attempt)
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
                return self._send_exhausted(run_id, slot, key, attempt)
            ob = self.obligations().get(key)
        lane = is_alarm_send(run_id, slot)
        if ob:
            # An intent (a replayed attempt, or a journaled alarm) carries its
            # journaled payload; otherwise the caller's wins where it gave one.
            replay = ob["state"] == "intent"
            if replay or hint is None:
                hint = ob["detail"].get("hint", hint)
            if replay or thread_key is None:
                thread_key = ob["detail"].get("threadKey", thread_key)
            if replay or fingerprint is None:
                fingerprint = ob["detail"].get("fingerprint", fingerprint)
        if ob and ob["state"] == "intent" and attempt > 0:
            # Latest record is the intent itself, so no outcome was journaled:
            # killed between intent and enqueue. The helper is idempotent on
            # key#attempt (INSERT ... ON CONFLICT(id) DO NOTHING + read-back),
            # so re-running the SAME attempt is safe and is not a new send.
            next_attempt = attempt
        else:
            # A new attempt: nothing yet, a definitive failed receipt, or a
            # journaled alarm (intent at attempt 0) not yet delivered.
            next_attempt = attempt + 1
            refusal = self._budget_refusal(run_id, fingerprint, lane)
            if refusal:
                return self._budget_refused(run_id, phase, slot, attempt, *refusal)
            detail = {}
            if not ob:
                if fingerprint:
                    detail["fingerprint"] = fingerprint
                if hint:
                    detail["hint"] = hint
                if thread_key:
                    detail["threadKey"] = thread_key
                crash_point("before-intent", "send", slot)
            self.record(run_id, "send", slot, "intent", next_attempt, detail or None)
            crash_point("after-intent", "send", slot)
        mid = send_id(key, next_attempt)
        self.fire_sends[(run_id, lane)] = self.fire_sends.get((run_id, lane), 0) + 1
        result = self.effects.perform({"type": "send", "runId": run_id, "slot": slot, "messageId": mid,
                                       "threadKey": thread_key or run_id, "fingerprint": fingerprint,
                                       "hint": hint or {}, "budgetRun": (run_id + ".alarms") if lane else run_id})
        self.decide(run_id, phase, "send", "mechanical", "obligation due", slot=slot, key=key, attempt=next_attempt,
                    messageId=mid, effect=result["outcome"])
        crash_point("after-effect", "send", slot)
        if result["outcome"] == "shadow_refused":
            # Shadow assumes the enqueue and the delivery succeeded, so the
            # decision stream keeps moving; the journal says it was assumed.
            self.record(run_id, "send", slot, "done", next_attempt, {"outcome": "shadow_refused", "shadowAssumed": True})
            return "done"
        if result["outcome"] in ("enqueued", "replay"):
            self.record(run_id, "send", slot, "enqueued", next_attempt, {"messageId": mid, "outcome": result["outcome"]})
            if result["outcome"] == "replay" and self.receipts.get(mid) in ("delivered", "failed"):
                # A replay after a crash: the row was already there, and its
                # receipt may be too -- settle it now rather than a fire later.
                return self.send(run_id, phase, slot, fingerprint=fingerprint, hint=hint, thread_key=thread_key)
            return "enqueued"
        if result["outcome"] == "budget":
            # The helper's own budget (same limits, same transaction as the
            # insert) refused: its per-fire count clears next fire.
            scope = "fire" if "per-fire" in str(result.get("error")) else "run"
            return self._budget_refused(run_id, phase, slot, next_attempt, scope, result.get("error"))
        return self._effect_failed(run_id, "send", slot, next_attempt, result, "controller_send_failed")

    def github(self, run_id, phase, slot, hint=None):
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
        result = self.effects.perform({"type": "gh", "runId": run_id, "slot": slot, "hint": hint or {},
                                       "marker": "<!-- smoke-ctl:{} -->".format(key),
                                       "writeOnlyIfMarkerAbsent": reconcile})
        self.decide(run_id, phase, "gh", "mechanical", "obligation due", slot=slot, key=key, effect=result["outcome"],
                    afterReconcile=reconcile)
        crash_point("after-effect", "gh", slot)
        if result["outcome"] == "shadow_refused":
            self.record(run_id, "gh", slot, "done", 1, {"outcome": result["outcome"], "shadowAssumed": True})
            return "done"
        if result["outcome"] == "done":
            self.record(run_id, "gh", slot, "done", 1, {k: result[k] for k in ("outcome", "via", "url", "state",
                                                                                "duplicateOf") if k in result})
            return "done"
        if result["outcome"] == "unknown":
            # Stays a bare intent: the next fire reconciles by marker search.
            self.record(run_id, "gh", slot, "intent", 1, {"outcome": "unknown", "error": result.get("error")})
            return "intent"
        return self._effect_failed(run_id, "gh", slot, 1, result, "controller_gh_failed")

    def gate_verb(self, run_id, phase, verb, argv_tail, verdict, effect_verb=None):
        key = obligation_key(run_id, "gate", verb)
        ob = self.obligations().get(key)
        if ob and ob["state"] in TERMINAL_OK | {"failed_terminal"}:
            return ob["state"]
        if not ob:
            self.record(run_id, "gate", verb, "intent", 1, {"args": argv_tail, "verdict": verdict})
            crash_point("after-intent", "gate", verb)
        # Both terminal verbs are crash-safe on retry: `finish` holds a
        # finishIntent and writes verdict.json once (smoke-pr-gate.sh:4108-4135),
        # and `challenger-timeout` refuses once the slot is gone or a
        # disposition exists (smoke-pr-gate.sh:4575-4625) -- so an intent with
        # no recorded outcome is simply re-offered.
        result = self.effects.perform({"type": "gate", "runId": run_id, "verb": effect_verb or verb,
                                       "args": argv_tail})
        self.decide(run_id, phase, "gate", "mechanical", "obligation due", verb=verb, args=argv_tail,
                    effect=result["outcome"])
        crash_point("after-effect", "gate", verb)
        if result["outcome"] in ("shadow_refused", "ok"):
            detail = {"outcome": result["outcome"], "args": argv_tail, "verdict": verdict}
            if result["outcome"] == "shadow_refused":
                detail["shadowAssumed"] = True
            else:
                detail["result"] = result.get("result")
            self.record(run_id, "gate", verb, "done", 1, detail)
            return "done"
        if result["outcome"] == "refused":
            # The gate said no (owner mismatch, GO after no-disposition, ...):
            # never retried into the same refusal; a human owns it.
            self.ensure_alarm(run_id, "controller_gate_refused", "gate-refused:{}".format(key[:12]),
                              {"verb": verb, "verdict": verdict, "error": result.get("error")})
            self.record(run_id, "gate", verb, "failed_terminal", 1, {"error": result.get("error"), "verdict": verdict})
            self.decide(run_id, phase, "escalate", "coordination_model", "controller_gate_refused", verb=verb)
            return "failed_terminal"
        self.record(run_id, "gate", verb, "intent", 1, {"outcome": result["outcome"], "error": result.get("error")})
        return "intent"

    def dispatch(self, run_id, phase, slot, artifact_rel, run):
        """Fresh judgment one-shot (critic/adjudicator) via `ncl tasks create`.

        Journals dispatch intent BEFORE create. An intent with no recorded
        outcome is AMBIGUOUS: `ncl tasks list` shows only pending/paused tasks,
        so absence there does not prove absence. It is reconciled from a live
        task with the ctl-<key8> slug or the one-shot's start/output file,
        and otherwise never recreated: escalated.
        """
        key = obligation_key(run_id, "dispatch", slot)
        slug = "ctl-{}".format(key[:8])
        started_rel = "controller/dispatch-{}.started".format(slot)
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
            live = [t for t in self.tasks if isinstance(t, dict) and (t.get("name") or "").startswith(slug)]
            if live or run.has(started_rel):
                self.record(run_id, "dispatch", slot, "enqueued", 1, {
                    "taskId": live[0].get("id") if live else None, "reconciled": True,
                    "via": "task" if live else started_rel})
                return "enqueued"
            if any(h.get("fire") == self.fire for h in ob["history"]):
                # The intent was journaled in THIS fire: the task listing was
                # captured before it, so its silence proves nothing yet. Judge
                # it against the next fire's listing, never recreate.
                return "intent"
            # Re-offered every fire it is reached (it is, while the intent is
            # ambiguous); the flag records the hold, it never silences the alarm.
            self.ensure_alarm(run_id, "controller_dispatch_ambiguous", "dispatch-ambiguous:{}".format(key[:12]),
                              {"slot": slot, "slug": slug})
            if not ob["detail"].get("ambiguous"):
                self.record(run_id, "dispatch", slot, "intent", 1, {"ambiguous": True})
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
        if result["outcome"] == "failed":
            # ncl answered ok:false: the host refused the create, so no task
            # exists. Terminal (never recreated blind), escalated, GO blocked.
            self.ensure_alarm(run_id, "controller_dispatch_failed", "dispatch-failed:{}".format(key[:12]),
                              {"slot": slot, "error": result.get("error")})
            self.record(run_id, "dispatch", slot, "failed_terminal", 1, {"error": result.get("error")})
            return "failed_terminal"
        # Timeout or unknown: the intent stays bare (no outcome state) and is
        # reconciled from the next fire's task listing.
        self.record(run_id, "dispatch", slot, "intent", 1, {"outcome": "unknown", "error": result.get("error")})
        return "intent"

    def _owner_route(self, run_id):
        claim = self.obligations().get(obligation_key(run_id, "run", "claim"))
        if not claim:
            return "legacy"
        route = claim["detail"].get("ownerRoute")
        if route:
            return route
        if not self.live or self.owner_cutover is None:
            return "legacy"
        already_owned = any(o["runId"] == run_id and o["kind"] == "owner" for o in self.obligations().values())
        route = "legacy" if run_id in self.owner_cutover["legacyRuns"] or already_owned else "phase-dispatch"
        self.record(run_id, "run", "claim", claim["state"], detail={"ownerRoute": route})
        return route

    def _phase_owner_step(self, run_id, phase, step, done):
        ob = self.obligations().get(obligation_key(run_id, "owner", step))
        if ob and ob["state"] in ("done", "abandoned", "failed_terminal"):
            return ob["state"]
        if done and not ob:
            return "done"  # no dispatched owner to settle; existing artifact barrier accepted this phase
        # An accepted next phase never overlaps a retained worker from the previous one.
        for prior in self.obligations().values():
            if prior["runId"] != run_id or prior["kind"] != "owner" or prior["slot"] == step or prior["state"] not in ("intent", "enqueued"):
                continue
            receipt = prior["detail"].get("dispatch")
            status = self.effects.owner_status(receipt) if receipt else None
            if prior["detail"].get("dispatchIntent") or not status or status.get("settlement", {}).get("state") != "settled":
                self.decide(run_id, phase, "wait", "wait", "previous phase owner is not settled", step=prior["slot"])
                return "intent"
            self.record(run_id, "owner", prior["slot"], "done", detail={"checkpoint": status["settlement"]})
        pending = ob["detail"].get("dispatchIntent") if ob else None
        event, retry_of = (pending["eventKey"], pending.get("retryOf")) if pending else ("initial", None)
        if ob and ob["detail"].get("dispatch") and not pending:
            receipt = ob["detail"]["dispatch"]
            status = self.effects.owner_status(receipt)
            settled = status.get("settlement", {}) if status else {}
            if done and settled.get("state") == "settled":
                accepted = {"intake": "completion-contract.json", "lanes": "lanes evidence barrier",
                            "preliminary": "coordinator/preliminary.md", "synthesis": "synthesis.json",
                            "adjudicated": "synthesis.json"}
                self.record(run_id, "owner", step, "done", detail={"checkpoint": settled,
                            "acceptedCheck": accepted.get(step, step)})
                return "done"
            failed = status and (status.get("status") in ("failed", "expired") or
                                  (status.get("status") == "completed" and settled.get("outcome") == "error"))
            if failed and settled.get("executionSettled") is True and receipt.get("attempt", 0) < 2:
                retry_of = receipt["eventKey"]
                event = "{}-recovery-{}".format(receipt["eventKey"], receipt.get("attempt", 0) + 1)
            elif settled.get("state") == "settled" and ob["state"] == "intent" and \
                    (ob["detail"].get("tokenReissued") or ob["detail"].get("refusalChanged")):
                claim = self.obligations()[obligation_key(run_id, "run", "claim")]["detail"]
                refusal = refusal_digest(read_json_file(os.path.join(
                    self.args.run_root, run_id, "controller", "barrier-{}.json".format(step)))[0])
                event = "revision-" + hashlib.sha256(json.dumps(
                    [receipt["eventKey"], claim.get("ownerToken"), refusal], separators=(",", ":")).encode()).hexdigest()[:32]
            else:
                if settled.get("state") == "settled" and not done:
                    self.ensure_alarm(run_id, "controller_owner_checkpoint_missing", "owner-checkpoint:{}".format(step),
                                      {"step": step, "rowId": receipt["row_id"]})
                started = parse_iso(ob["history"][0].get("at"))
                if started and (self.now - started).total_seconds() > OWNER_STEP_SLA_SECONDS:
                    self.ensure_alarm(run_id, "controller_obligation_overdue", "owner-dispatch:{}".format(step),
                                      {"step": step, "rowId": receipt["row_id"], "status": status.get("status") if status else "unknown"})
                self.decide(run_id, phase, "wait", "wait", "phase owner in flight or requires disposition", step=step)
                return "intent"
        if not ob:
            self.record(run_id, "owner", step, "intent", 1)
        result = self.effects.perform({"type": "owner_wake", "runId": run_id, "step": step,
                                       "dispatchEvent": event, "retryOf": retry_of})
        if result.get("outcome") == "admitted":
            self.record(run_id, "owner", step, "enqueued", 1, {
                "outcome": "admitted", "dispatch": result["dispatch"], "dispatchIntent": None,
                "briefedToken": result.get("briefedToken"), "briefedRefusal": result.get("briefedRefusal", ""),
                "tokenReissued": False, "refusalChanged": False})
        else:
            self.decide(run_id, phase, "wait", "wait", "dispatch outcome unknown; replay same event", step=step)
        return "enqueued" if result.get("outcome") == "admitted" else "intent"

    def owner_step(self, run_id, phase, step, done):
        """Judgment step for the retained owner. The wake is an effect: live
        writes <run>/controller/brief-<step>.md and the wrapper returns
        wakeAgent:true with {step, runId, brief}; shadow refuses it. A bare
        intent (a fire that died before the brief) is re-offered."""
        if self._owner_route(run_id) == "phase-dispatch":
            return self._phase_owner_step(run_id, phase, step, done)
        key = obligation_key(run_id, "owner", step)
        ob = self.obligations().get(key)
        brief = "controller/brief-{}.md".format(step)
        if done:
            if ob and ob["state"] not in ("done", "abandoned"):
                self.record(run_id, "owner", step, "done", 1)
            return "done"
        if ob and ob["state"] in ("abandoned", "failed_terminal"):
            return ob["state"]  # never re-enqueued
        if not ob or ob["state"] == "intent":
            if not ob:
                self.record(run_id, "owner", step, "intent", 1)
                crash_point("after-intent", "owner", step)
            result = self.effects.perform({"type": "owner_wake", "runId": run_id, "step": step})
            self.decide(run_id, phase, "wake_owner", "judgment", "owner step due", step=step, key=key, brief=brief,
                        wakeAgent=True, effect=result["outcome"], afterReconcile=bool(ob))
            crash_point("after-effect", "owner", step)
            if result["outcome"] in ("shadow_refused", "brief_written"):
                enqueued = {"brief": brief, "outcome": result["outcome"]}
                # Only once the brief is on disk (see _owner_wake's return):
                # _reissue_owner_token reads this to decide whether the step
                # still owes a re-offer, so recording it early would close the
                # transition a crash had not actually completed.
                if result.get("briefedToken"):
                    enqueued["briefedToken"] = result["briefedToken"]
                if "briefedRefusal" in result:
                    enqueued["briefedRefusal"] = result["briefedRefusal"]
                self.record(run_id, "owner", step, "enqueued", 1, enqueued)
                self.owner_wakes.append({"runId": run_id, "step": step, "brief": result.get("brief") or brief,
                                         "key": key, "since": iso(self.now)})
                return "enqueued"
            return "intent"
        if ob["state"] == "enqueued" and ob["detail"].get("outcome") == "brief_written" and \
                not os.path.lexists(os.path.join(self.args.run_root, run_id, "controller",
                                                 "brief-{}.ack".format(step))):
            # A written brief is only a wake once a woken owner acks it (the
            # router's first act). One wake per fire (fire_once picks); an
            # un-acked brief is re-offered up to OWNER_WAKE_OFFERS times, then
            # left to the SLA below.
            if int(ob["detail"].get("offers") or 1) < OWNER_WAKE_OFFERS:
                self.owner_wakes.append({"runId": run_id, "step": step,
                                         "brief": os.path.join(self.args.run_root, run_id, brief), "key": key,
                                         "since": ob["history"][0].get("at")})
        started = parse_iso(ob["history"][0].get("at"))
        if ob["state"] in ("intent", "enqueued") and started and \
                (self.now - started).total_seconds() > OWNER_STEP_SLA_SECONDS:
            raised = self.ensure_alarm(run_id, "controller_obligation_overdue", "overdue:{}".format(key[:12]),
                                       {"obligation": "owner:{}".format(step)})
            if not ob["detail"].get("overdue"):
                self.record(run_id, "owner", step, ob["state"], 1, {"overdue": True})
            if raised:
                # There is no timeout verdict for a silent owner (the spec's
                # only timeout is the challenger's); resume vs abandon is the
                # same human call the gate's pr_run_stalled asks for
                # (smoke-pr-gate.sh:4775-4795), so it is counted as one.
                self.decide(run_id, phase, "escalate", "coordination_model", "owner step overdue", step=step)
        self.decide(run_id, phase, "wait", "wait", "owner step in progress", step=step)
        return "intent"

    # -- per-fire reconciliation --------------------------------------------

    def _claim_detail(self, wake, origin, claim=None):
        detail = {"origin": origin, "pr": wake.get("pr") if wake else claim["pr"],
                  "sha": wake.get("sourceSha") if wake else claim["sha"]}
        if wake:
            detail["isFreezePr"] = wake.get("isFreezePr")
        if self.live:
            token = (wake or {}).get("coordinatorOwnerToken") or (claim or {}).get("owner")
            detail["ownerToken"] = token
            detail["wake"] = wake or {"trigger": "pr_build_settled", "runId": None, "pr": claim["pr"],
                                      "sourceSha": claim["sha"], "coordinatorOwnerToken": token,
                                      "recoveredFromGateState": True}
        return detail

    def _reissue_owner_token(self, run_id, token):
        """A recovery poll re-minted this run's lease under a fresh token while
        an owner step was IN FLIGHT. XZO #2046.

        The gate is right to re-mint (that is how a coordinator that died is
        recovered) and `adopt`'s fence is right to refuse a stale owner
        (smoke-run-scaffold.sh:267-269, and `adopt` adds no authority check of
        its own, :707-711). What was missing is the third party: the owner THIS
        controller dispatched holds the retired token and has no way to learn
        the new one, because `controller/wake.json` -- the only file that
        carries it, and the file the intake brief names -- was written once, at
        intake. So the owner the controller itself dispatched can never satisfy
        the fence, and stops -- which is the correct behaviour, and why run
        pr2055 banked 4 of 14 markers with the other 8 lanes' evidence complete
        on disk.

        THE INVARIANT, and why this is not the poll-reclaim edge it started as:

            An in-flight owner step must have been briefed under the token the
            gate holds now.

        `briefedToken` is journaled with the step when its brief is actually
        written (owner_step, from _owner_wake's result), so the condition is
        re-derived every fire from durable state and never from "have I already
        done this". An edge trigger on reconcile_claims' poll-reclaim branch
        was not crash-safe: the claim record is fsynced first, so a death
        between the two records left the journaled token matching the wake, the
        branch skipped forever, and the owner enqueued on the old brief and a
        stale wake.json -- the exact wedge this exists to recover from. Now a
        crash anywhere in the sequence leaves the next fire able to finish it,
        because the next fire asks the same question of the same durable state
        and gets the same answer until the brief lands. Once `briefedToken`
        equals the live token it is a no-op, so it is safe to run every fire.

        The re-offer records the step back to `intent`, which makes owner_step
        perform its wake again: that rewrites wake.json with the live token
        (the only legitimate issue path -- copying the token out of gate state
        is impersonation, not adoption), removes the stale `.ack`, and writes a
        brief whose _brief_notes preamble says to run `adopt` before anything
        else. `done`/`abandoned`/`failed_terminal` steps are left alone:
        nothing is in flight to re-offer."""
        if not token:
            return
        for ob in list(self.obligations().values()):
            if ob["runId"] != run_id or ob["kind"] != "owner" or ob["state"] not in ("intent", "enqueued"):
                continue
            briefed = (ob.get("detail") or {}).get("briefedToken")
            evidence = "journal"
            if briefed == token:
                continue
            if briefed is None:
                evidence = "run-tree"
                # Journaled by a controller that did not track it: this file is
                # a live bind mount, so a run can be mid-flight across the
                # upgrade. The journal is silent -- the RUN TREE is not.
                # `controller/wake.json` is the file the owner is told to read
                # its token from (OWNER_BRIEF["intake"]) and the only file that
                # carries one to it, so its `coordinatorOwnerToken` IS what the
                # owner holds. Backfilling the gate's current token without
                # looking would make every later fire see equality and skip the
                # reissue forever -- on a run whose pre-upgrade poll had already
                # re-minted, that is exactly the wedge this exists to end.
                briefed = self._persisted_owner_token(run_id)
                if briefed is None:
                    evidence = "none"
                if briefed == token:
                    self.record(run_id, "owner", ob["slot"], ob["state"], ob["attempt"] or 1,
                                {"briefedToken": token})
                    continue
                # Either the run tree names a DIFFERENT token (a re-mint the
                # pre-upgrade controller never carried through -- genuine, fall
                # through and re-offer), or there is no readable wake at all.
                # No wake means no issued token, so the owner cannot satisfy
                # begin_active_run_fence whatever it is holding, and the safe
                # direction is to tell it: the re-offer writes wake.json with
                # the live token and asks for an `adopt`, which is a no-op when
                # the contract already names the caller (smoke-run-scaffold.sh
                # adopt, the "exact retry" branch: no write, no history entry).
                # So a spurious re-offer costs one owner turn and can corrupt
                # nothing, while a silent backfill costs the campaign.
            if ob["state"] == "intent" and (ob.get("detail") or {}).get("tokenReissued"):
                continue  # already mid-transition; owner_step finishes it this fire
            self.ensure_alarm(run_id, "controller_owner_token_reissued",
                              "token-reissued:{}:{}".format(run_id[-24:], token[-8:]),
                              {"step": ob["slot"],
                               "reason": "a recovery poll re-minted this run's lease; the dispatched owner must "
                                         "re-read controller/wake.json and run scaffold `adopt` before writing"})
            self.record(run_id, "owner", ob["slot"], "intent", ob["attempt"] or 1, {"tokenReissued": True})
            self.decide(run_id, ob["slot"], "wake_owner", "coordination_model",
                        "owner token reissued; step re-offered for adoption", step=ob["slot"],
                        evidence=evidence)

    def _reoffer_on_new_refusal(self, run_id, step):
        """Re-offer an ACKNOWLEDGED step whose barrier refusal has changed.

        XZO #2047 again, by the likelier route. Round 1 covered first arrival:
        the barrier was already refusing when the brief was written, so the
        brief said so. The commoner order is the reverse -- the brief is issued
        while the barrier is merely waiting for markers, the owner acks it,
        then the owner writes evidence the barrier rejects. The next fire
        publishes the new refusal and returns `ownerWake: null`, because
        owner_step re-offers a wake only while the `.ack` is ABSENT
        (:2329-2339). The diagnosis is on disk and nobody is told to read it --
        the same dead end, reached the way run pr2055 actually reached it.

        THE TRIGGER IS A CHANGE IN THE REFUSAL, NOT "INVALID". Narrower than
        "the published answer changed", which would include `missing[]` and so
        wake the owner on its own marker writes; wider than "became invalid",
        which would leave an owner working against a refusal that has since
        moved on to different files or different reasons. See refusal_digest.
        A refusal that CLEARS re-offers nothing: there is nothing to say, and
        the phase advances on its own.

        Recorded against the step, so it is re-derived from durable state every
        fire exactly like `briefedToken`: a crash between the publish and the
        re-offer leaves the next fire owing the same re-offer. Re-offering does
        not extend the step's SLA -- owner_step measures from `history[0]`
        (:2340) -- so a run that keeps producing invalid evidence still ends at
        the overdue path rather than being woken forever."""
        ob = self.obligations().get(obligation_key(run_id, "owner", step))
        if not ob or ob["state"] not in ("intent", "enqueued"):
            return
        current = refusal_digest(read_json_file(
            os.path.join(self.args.run_root, run_id, "controller", "barrier-{}.json".format(step)))[0])
        if not current or current == (ob.get("detail") or {}).get("briefedRefusal"):
            return
        if ob["state"] == "intent":
            return  # a wake is already owed this fire; owner_step writes the current refusal into it
        self.record(run_id, "owner", step, "intent", ob["attempt"] or 1, {"refusalChanged": True})
        self.decide(run_id, step, "wake_owner", "coordination_model",
                    "barrier refusal changed under an acknowledged step; re-offered", step=step)

    def _persisted_owner_token(self, run_id):
        """The token the RUN TREE says the owner was issued, or None.

        `controller/wake.json` is written by _owner_wake with every brief and is
        what OWNER_BRIEF["intake"] tells the owner to take `SMOKE_GATE_OWNER`
        from, so it is the durable record of what the owner holds -- the
        evidence the journal lacks for a step briefed before `briefedToken`
        existed. Unreadable, absent, or carrying no token all answer None,
        which the caller reads as "no issued token", not as agreement."""
        doc, err = read_json_file(os.path.join(self.args.run_root, run_id, "controller", "wake.json"))
        if err or not isinstance(doc, dict):
            return None
        tok = doc.get("coordinatorOwnerToken")
        return tok if isinstance(tok, str) and tok else None

    def _legacy_hold(self, run_id, why):
        """A legacy run surfaced to the controller (a poll wake after its
        coordinator went quiet). It is never adopted: journaled under the
        cutover pseudo-run, alarmed once, left to a human. The saved wake is
        replayed every fire the run stays unjournaled (live worker, wakes/),
        so the alarm is re-offered, not gated on the hold record."""
        pseudo = PSEUDO_PREFIX + "cutover"
        key = obligation_key(pseudo, "hold", run_id)
        self.ensure_alarm(pseudo, "controller_cutover_legacy_run", "legacy:{}".format(run_id[-40:]),
                          {"legacyRunId": run_id, "reason": why})
        if key not in self.obligations():
            self.record(pseudo, "hold", run_id, "done", 1, {"reason": why})
        self.decide(pseudo, None, "escalate", "coordination_model", "legacy run left to its coordinator",
                    legacyRunId=run_id, why=why)

    def _gate_alarm(self, wake):
        trigger = wake.get("trigger")
        pseudo, fp, slot = gate_alarm_ids(wake, self.now)
        day = pseudo.rsplit(".", 1)[-1]
        # Journaled before delivery like every alarm, so a budget-refused
        # delivery still leaves the obligation (and the live worker's queue
        # entry is drained only once that obligation exists).
        if not self.ensure_alarm(pseudo, trigger, fp, None, slot=slot, hint={"gateAlarm": wake},
                                 thread_key=re.sub(r"[^A-Za-z0-9._:-]", "-", "gate-{}-{}".format(day, fp))[:120]):
            self.decide(pseudo, None, "alarm", "mechanical", trigger, fingerprint=fp)

    def _poll_alarm(self, wake, obs):
        if wake.get("trigger") == "pr_run_stalled" and wake.get("runId") and \
                wake["runId"] not in self.legacy and obligation_key(wake["runId"], "run", "claim") in obs:
            # One of OUR runs stopped stamping: the controller itself was
            # down. It is resumable only by a human (the wake's own hint).
            self.decide(wake["runId"], None, "escalate", "coordination_model", "pr_run_stalled on a controller run")
        self._gate_alarm(wake)

    def reconcile_claims(self):
        obs = self.obligations()
        claims = self.gate.active_claims()
        wake = (self.poll or {}).get("data") if isinstance(self.poll, dict) else None
        # Live: every wakeAgent:true poll result that is not a claim is an
        # alarm the legacy coordinator posted (PRP "Non-campaign triggers");
        # one the controller has no words for is posted verbatim, never dropped.
        is_alarm = isinstance(wake, dict) and wake.get("trigger") not in (None, "pr_build_settled") and \
            isinstance(self.poll, dict) and self.poll.get("wakeAgent") is True
        if self.live:
            # The live worker queues every alarm wake durably before stepping
            # (the gate latches it and will not emit it again), and passes
            # them here; each is journaled by its fingerprint, so a replay of
            # a queue entry already journaled is not a second post.
            for queued in self.queued_alarms:
                self._poll_alarm(queued, obs)
        if is_alarm and self.live:
            self._poll_alarm(wake, obs)
        elif isinstance(wake, dict) and wake.get("trigger") == "pr_build_settled" and wake.get("runId"):
            run = wake["runId"]
            if run in self.legacy:
                self._legacy_hold(run, "poll reclaimed a legacy run (resumedRunId={})".format(wake.get("resumedRunId")))
            elif RUN_ID_RE.match(run) and not run.startswith(PSEUDO_PREFIX):
                key = obligation_key(run, "run", "claim")
                if key not in obs:
                    # The gate's poll has already claimed; this is the first record
                    # of the run. A kill right here is recovered below on the next
                    # fire from gate state (controller_orphan_claim).
                    crash_point("before-run-record", "run", "claim")
                    self.record(run, "run", "claim", "enqueued", 1, self._claim_detail(wake, "poll-wake"))
                    crash_point("after-run-record", "run", "claim")
                elif self.live and wake.get("coordinatorOwnerToken") and \
                        obs[key]["detail"].get("ownerToken") != wake["coordinatorOwnerToken"] and \
                        obs[key]["state"] not in ("done", "abandoned"):
                    # Our own poll reclaimed our own stale run (the controller
                    # was down past PROGRESS_STALE_SECONDS): the wake carries the
                    # new token, and only the wake may hand one over.
                    self.record(run, "run", "claim", "enqueued", 1, dict(self._claim_detail(wake, "poll-reclaim"),
                                                                         reclaimed=True))
                    # THE WINDOW. This record is fsynced, and the gate latches
                    # the wake, so a kill here used to be unrecoverable: the
                    # journal's token already matched and nothing would ever
                    # look again. The re-offer is no longer sequenced behind it
                    # -- _reissue_owner_token re-derives what is owed from
                    # `briefedToken` on every fire -- and this seam is what the
                    # regression kills at.
                    crash_point("after-reclaim-record", "run", "claim")
                obs = self.obligations()
        for run, claim in sorted(claims.items()):
            if not RUN_ID_RE.match(run) or run.startswith(PSEUDO_PREFIX) or run in self.legacy:
                continue
            if obligation_key(run, "run", "claim") not in obs:
                self.record(run, "run", "claim", "enqueued", 1, self._claim_detail(None, "recovered", claim))
                self.alarms.append({"trigger": "controller_orphan_claim", "runId": run, "pr": claim["pr"]})
                self.decide(run, None, "log", "mechanical", "controller_orphan_claim", pr=claim["pr"])

    def _authority(self, run_id, run_ob, claim):
        """Live: may this controller act on the run? Its journaled token must
        be the one the gate holds. A token that changed without our own wake
        means someone else holds the slot: never act, alarm once. The gate
        must ALSO record the claim as the controller's (activeClaimant, set by
        a `poll` run with SMOKE_GATE_CLAIMANT=controller; smoke-pr-gate.sh
        claimant_guard): a legacy-claimed run is never ours even when its
        token is readable from a run file."""
        if not self.live:
            return True
        token = (run_ob or {}).get("detail", {}).get("ownerToken")
        holder = claim.get("owner")
        if token and holder and token == holder and claim.get("claimant") == "controller":
            return True
        self.ensure_alarm(run_id, "controller_no_authority", "no-authority:{}".format(run_id[-40:]),
                          {"journaled": bool(token), "gateHolder": bool(holder),
                           "tokenMatch": bool(token and token == holder), "claimant": claim.get("claimant")})
        if not (run_ob or {}).get("detail", {}).get("noAuthority"):
            self.record(run_id, "run", "claim", run_ob["state"] if run_ob else "enqueued", 1, {"noAuthority": True})
        self.decide(run_id, None, "escalate", "coordination_model", "controller_no_authority")
        return False

    def _finish_receipt(self, run_id, run_ob, verdict_doc):
        """complete | held | unknown. Our own terminal verb answering ok is a
        completion receipt (the gate prints ok only after its final state
        write). One observed completion is journaled, so a successor run later
        overwriting completedRunId cannot un-complete this one."""
        if (run_ob or {}).get("detail", {}).get("gateCompleted"):
            return "complete"
        obs = self.obligations()
        own_ok = any((obs.get(obligation_key(run_id, "gate", v)) or {}).get("detail", {}).get("outcome") == "ok"
                     for v in TERMINAL_VERBS + ("finish-resume",))
        fin = "complete" if own_ok else self.gate.finish_state(run_id, verdict_doc)
        if fin == "complete" and run_ob and run_ob["state"] not in ("done", "abandoned"):
            self.record(run_id, "run", "claim", run_ob["state"], 1, {"gateCompleted": True})
        return fin

    def _finish_incomplete(self, run_id, run_ob, claim, verdict_doc, fin):
        """verdict.json exists but the gate's finish has not completed. Live,
        with authority, re-run the gate's crash-safe `finish` with the verdict
        already on file: it resumes from verdict.json (smoke-pr-gate.sh:
        4002-4027, RUN_VERDICT_RESUMED) and redoes the idempotent hold/ledger
        and slot cleanup. Shadow waits. A completion that cannot be confirmed
        at all is alarmed and escalated; it never reaches post_finish. The
        alarm is re-offered on every such fire under its fixed key (the
        finishUnconfirmed flag records the state, it never silences it)."""
        verdict = verdict_doc.get("verdict")
        if fin == "unknown":
            if run_ob:
                self.ensure_alarm(run_id, "controller_finish_unconfirmed",
                                  "finish-unconfirmed:{}".format(run_id[-40:]), {"verdict": verdict})
                if not run_ob["detail"].get("finishUnconfirmed"):
                    self.record(run_id, "run", "claim", run_ob["state"], 1, {"finishUnconfirmed": True})
            self.decide(run_id, "verdict", "escalate", "coordination_model",
                        "verdict.json exists but the gate's completed state does not confirm it")
            return "verdict"
        if not self.live:
            self.decide(run_id, "verdict", "wait", "wait",
                        "gate finish partial: verdict.json written, slot still held", verdict=verdict)
            return "verdict"
        if claim is None or not self._authority(run_id, run_ob, claim):
            return "held"
        ob = self.obligations().get(obligation_key(run_id, "gate", "finish-resume"))
        if ob and ob["state"] == "done":
            # Resumed ok this fire; the next fire's state read confirms it.
            return "verdict"
        if ob and ob["state"] == "failed_terminal":
            return "verdict"
        # An unanswered resume is simply re-offered: the gate's finish is
        # idempotent on the same terminal facts.
        self.gate_verb(run_id, "verdict", "finish-resume",
                       [verdict_doc.get("sha") or claim.get("sha"), run_id, verdict], verdict, effect_verb="finish")
        return "verdict"

    def _alarm_overdue(self, run_id, phase):
        """Every pre-finish obligation stuck past its SLA raises its own alarm,
        once. A missing receipt otherwise waits silently, while the
        controller's progress stamps keep the gate's stale-run detection
        quiet. Never a resend: the obligation keeps its message id. (The
        gate's pr_run_overrun fires on claim AGE whatever the stamps say,
        smoke-pr-gate.sh:5025-5048: the run-level backstop.)"""
        obs = self.obligations()
        for ob in list(obs.values()):
            if ob["runId"] != run_id or ob["kind"] not in PRE_FINISH_KINDS or ob["slot"] in POST_FINISH_SLOTS:
                continue
            if ob["state"] not in ("intent", "enqueued") or ob["slot"].startswith("alarm:"):
                continue
            if ob["kind"] == "dispatch" and ob["detail"].get("ambiguous"):
                continue  # already escalated as ambiguous
            since = None
            for rec in reversed(ob["history"]):
                if rec.get("state") != ob["state"]:
                    break
                since = rec.get("at")
            started = parse_iso(since)
            sla = OWNER_STEP_SLA_SECONDS if ob["kind"] == "dispatch" else RECEIPT_SLA_SECONDS
            if not started or (self.now - started).total_seconds() <= sla:
                continue
            fp = "overdue:{}".format(ob["key"][:12])
            label = "{}:{}".format(ob["kind"], ob["slot"])
            if self.ensure_alarm(run_id, "controller_obligation_overdue", fp,
                                 {"obligation": label, "state": ob["state"], "since": since}):
                self.decide(run_id, phase, "escalate", "coordination_model", "obligation overdue", obligation=label)

    # -- one run ------------------------------------------------------------

    def step_run_guarded(self, run_id):
        """THE step-return boundary, and the only place a step outcome is
        judged: known-good outcomes pass, everything else journals an alarm
        (idempotent, keyed by run and cause) before it is returned. The check
        lives here rather than in the failing paths because deleting a
        per-path ensure_alarm reintroduces a silent return, while deleting
        this one fails the property test."""
        detail = None
        try:
            phase = self.step_run(run_id)
        except ControllerError as exc:
            phase, cause = "error", "step-error"
            detail = {"error": str(exc)[:300]}
        except Exception as exc:  # noqa: BLE001 -- an unforeseen step fault is still an alarm
            phase, cause = "error", "step-error"
            detail = {"error": "{}: {}".format(type(exc).__name__, str(exc)[:200])}
        else:
            if phase in STEP_OUTCOMES:
                return phase
            cause = "step-outcome"
            detail = {"outcome": str(phase)[:80]}
        self.step_errors.append(dict(detail, runId=run_id, cause=cause))
        self.ensure_alarm(run_id, "controller_step_failed",
                          "{}:{}".format(cause, run_id[-24:]), detail)
        return phase

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
            fin = self._finish_receipt(run_id, run_ob, verdict_doc)
            if fin != "complete":
                # verdict.json alone is NOT a finished run: the gate writes it
                # before hold/ledger/slot cleanup. Never post_finish (and so
                # never freeze-close) until the gate's completed state agrees.
                return self._finish_incomplete(run_id, run_ob, claim, verdict_doc, fin)
            for verb in TERMINAL_VERBS:
                own = obs.get(obligation_key(run_id, "gate", verb))
                if own and own["state"] == "intent":
                    # Our own terminal verb ran and the fire died before its
                    # outcome was journaled: verdict.json is that outcome.
                    self.record(run_id, "gate", verb, "done", 1, {
                        "outcome": "reconciled", "verdict": verdict_doc.get("verdict"),
                        "via": "gate runs/<runId>/verdict.json"})
                    self.decide(run_id, "verdict", "gate_reconcile", "mechanical",
                                "terminal verb outcome recovered from verdict.json", verb=verb,
                                verdict=verdict_doc.get("verdict"))
                    return self.post_finish(run_id, pr, verdict_doc.get("verdict"), external=False)
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
            # Not active and not finished: reclaimed or released. The alarm is
            # journaled FIRST; then pre-finish obligations are abandoned with
            # the reason on record -- except alarm posts, which still deliver.
            if self.live:
                self.ensure_alarm(run_id, "controller_run_released", "released:{}".format(run_id[-40:]),
                                  {"reason": "run no longer holds the gate slot and has no verdict"})
            obs = self.obligations()
            for ob in obs.values():
                if ob["runId"] == run_id and ob["state"] not in ("done", "delivered", "abandoned", "failed_terminal") \
                        and not (ob["kind"] == "send" and is_alarm_send(run_id, ob["slot"])):
                    self.record(run_id, ob["kind"], ob["slot"], "abandoned", ob["attempt"] or None,
                                {"reason": "run no longer holds the gate slot"})
            self.decide(run_id, "released", "log", "mechanical", "run lost the slot without a verdict")
            return "released"
        if not self._authority(run_id, run_ob, claim):
            return "held"
        if self.live:
            # Keep the claim live: a run goes reclaimable PROGRESS_STALE_SECONDS
            # after its last stamp (smoke-pr-gate.sh:1464-1478).
            ka = self.effects.keepalive(run_id, run_ob["detail"].get("ownerToken"))
            if ka and not ka.get("ok"):
                self.decide(run_id, None, "log", "mechanical", "progress stamp failed", error=ka.get("error"))

        # Checked EVERY fire, before any owner_step can run, against the token
        # _authority has just proved is the gate's. Not on the poll-reclaim
        # edge: see _reissue_owner_token.
        if self.live:
            self._reissue_owner_token(run_id, run_ob["detail"].get("ownerToken"))

        self._alarm_overdue(run_id, None)

        # -- phase derivation (derived, never stored) --
        if not run.exists or run.contract_error:
            self.owner_step(run_id, "intake", "intake", done=False)
            if run.exists and run.contract_error not in ("missing",):
                self.decide(run_id, "intake", "escalate", "coordination_model",
                            "completion contract unreadable: {}".format(run.contract_error))
            return "intake"
        if self.owner_step(run_id, "intake", "intake", done=True) != "done":
            return "intake"

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

        # A verdict validated on an earlier fire is settled from the barrier on
        # every later one, whatever the phase files now say: live receipts
        # land a fire after the send, and a late challenger disposition must
        # not park a frozen challenger-timeout BLOCKED back in `lanes` (found
        # by the live replay, pr1896: finish slipped 57h). A frozen non-GO is
        # replayed as is; a frozen GO is re-validated and can only fall.
        vob = self.obligations().get(obligation_key(run_id, "verdict", "validated"))
        if vob and vob["state"] == "done":
            frozen = vob["detail"].get("verdict")
            syn_doc, syn_err = run.synthesis()
            if frozen == "GO":
                verdict, failed = validate_synthesis(run, claim.get("sha"), self.pr_heads.get(str(pr)),
                                                     run.barrier("synthesis"), run.last_identity_check())
            else:
                verdict, failed = frozen, vob["detail"].get("failedChecks") or []
            return self.pre_finish(run_id, pr, verdict, failed, syn_doc if not syn_err else {},
                                   terminal_verb=frozen_terminal_verb(vob["detail"]))

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
            if self.owner_step(run_id, "synthesis", "synthesis", done=True) != "done":
                return "synthesis"
            return self.pre_finish(run_id, pr, verdict, failed, early)

        lanes = run.barrier("lanes")
        if not lanes.get("ready"):
            # Timeout BEFORE judgment: a run the challenger deadline ends this
            # fire must not wake its owner for a step it will never use.
            timed = self._maybe_challenger_timeout(run_id, claim, run)
            if timed:
                return timed
            # PUBLISHED BEFORE THE WAKE, not after: the brief is written by
            # owner_step's effect, and _brief_notes can only cite a file that
            # already exists.
            self.publish_barrier(run_id, "lanes", lanes)
            if self.live:
                self._reoffer_on_new_refusal(run_id, "lanes")
            self.owner_step(run_id, "lanes", "lanes", done=False)
            if lanes.get("invalid"):
                self.decide(run_id, "lanes", "escalate", "coordination_model",
                            "lane evidence invalid (redispatch is a judgment call)",
                            invalid=lanes.get("invalid"), reasons=(lanes.get("invalidReasons") or [])[:3])
            return "lanes"
        self.publish_barrier(run_id, "lanes", None)
        if self.owner_step(run_id, "lanes", "lanes", done=True) != "done":
            return "lanes"

        if not run.has("coordinator/preliminary.md"):
            timed = self._maybe_challenger_timeout(run_id, claim, run)
            if timed:
                return timed
            self.owner_step(run_id, "preliminary", "preliminary", done=False)
            return "preliminary"
        if self.owner_step(run_id, "preliminary", "preliminary", done=True) != "done":
            return "preliminary"

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
                self.publish_barrier(run_id, "synthesis", syn_barrier)
                # THE OWNER IS WOKEN HERE, not only once the barrier passes.
                # By this point every OTHER party's contribution the synthesis
                # barrier checks has already been gated above: the lanes
                # barrier is ready (:2881), coordinator/preliminary.md exists
                # (:2903) and challenger/disposition.md exists (:2912). What
                # the synthesis barrier can still report is therefore the
                # retained owner's -- `invalid[]` content it authored
                # (journeys/scope-dispositions.json, or
                # contact-sheet/dispositions.json under
                # SMOKE_VISUAL_DISPOSITIONS=1), or a `missing[]` disposition it
                # owes -- and the owner is the only judgment party the
                # controller can invoke. Returning without a wake left the
                # phase with no exit at all: the wrapper wakes on `ownerWake`
                # alone (smoke-controller-live.sh:168-175), so nobody was told;
                # and _maybe_synthesis_overdue_blocked needs the very
                # owner:synthesis obligation this branch declined to create
                # (:2997-2999), so the terminal BLOCKED safety net could not
                # fire either. This is the same blind spot as the lanes barrier
                # (XZO #2047), on the sibling path.
                timed = self._maybe_synthesis_overdue_blocked(run_id, pr, run)
                if timed:
                    return timed
                if self.live:
                    self._reoffer_on_new_refusal(run_id, "synthesis")
                self.owner_step(run_id, "synthesis", "synthesis", done=False)
                if syn_barrier.get("invalid"):
                    self.decide(run_id, "synthesis", "escalate", "coordination_model",
                                "synthesis barrier invalid", invalid=syn_barrier.get("invalid"),
                                reasons=(syn_barrier.get("invalidReasons") or [])[:3])
                else:
                    self.decide(run_id, "synthesis", "wait", "wait", "synthesis barrier not ready",
                                missing=syn_barrier.get("missing"))
                return "synthesis"
            timed = self._maybe_synthesis_overdue_blocked(run_id, pr, run)
            if timed:
                return timed
            self.publish_barrier(run_id, "synthesis", None)
            self.owner_step(run_id, "synthesis", "synthesis", done=False)
            adj = self._adjudication(run_id, run)
            return adj or "synthesis"
        if self.owner_step(run_id, "synthesis", "synthesis", done=True) != "done":
            return "synthesis"
        self._adjudication(run_id, run)

        head = self.pr_heads.get(str(pr))
        verdict, failed = validate_synthesis(run, claim.get("sha"), head, syn_barrier, run.last_identity_check())
        return self.pre_finish(run_id, pr, verdict, failed, synthesis_doc if not syn_err else {})

    def _adjudication(self, run_id, run):
        """The owner asks for a fresh adjudicator by writing
        controller/adjudication-request.md (and no synthesis.json yet). The
        controller dispatches the muted one-shot; when its ruling lands the
        owner is woken again (`adjudicated`) to finish synthesis. The request
        is a pre-finish dispatch obligation, so an unanswered one blocks GO."""
        if not run.has("controller/adjudication-request.md"):
            return None
        state = self.dispatch(run_id, "synthesis", "adjudicator", ONESHOT_ARTIFACTS["adjudicator"], run)
        if state == "done":
            if not run.has("synthesis.json"):
                self.owner_step(run_id, "synthesis", "adjudicated", done=False)
            else:
                self.owner_step(run_id, "synthesis", "adjudicated", done=True)
            return None
        self.decide(run_id, "synthesis", "wait", "wait", "adjudication pending", state=state)
        return "synthesis"

    def _maybe_synthesis_overdue_blocked(self, run_id, pr, run):
        """Ruling on spec gap 3: the challenger concluded BLOCKED and the owner's
        synthesis step is past its SLA -> finish BLOCKED with no model. It can
        never produce GO (the verdict is fixed here), so it is fail-safe. Seen in
        the replay (pr1945, pr1953): the historical coordinator finished BLOCKED
        straight from the challenger and never wrote a synthesis."""
        ob = self.obligations().get(obligation_key(run_id, "owner", "synthesis"))
        if not ob or ob["state"] not in ("intent", "enqueued"):
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
            self.record(run_id, "verdict", "validated", "done", 1, {"verdict": verdict, "failedChecks": failed,
                                                                    "terminalVerb": terminal_verb})
        else:
            frozen = vob["detail"].get("verdict")
            if frozen == "GO" and verdict != "GO":
                failed = failed + ["verdict changed after validation: GO no longer holds"]
                self.ensure_alarm(run_id, "controller_verdict_superseded", "verdict-superseded:{}".format(run_id[-24:]),
                                  {"failedChecks": failed})
                if not vob["detail"].get("superseded"):
                    self.record(run_id, "verdict", "validated", "done", 1, {"superseded": True})
                verdict = "BLOCKED"
            elif frozen != "GO":
                verdict, failed = frozen, vob["detail"].get("failedChecks") or []
                terminal_verb = frozen_terminal_verb(vob["detail"])
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
        states.append(("send", "verdict", self.send(run_id, phase, "verdict",
                                                    hint={"verdict": verdict, "failedChecks": failed[:4]})))
        states.append(("gh", "pr-comment", self.github(run_id, phase, "pr-comment",
                                                       hint={"verdict": verdict, "failedChecks": failed[:4]})))
        self._settle_alarm_sends(run_id)
        # failed_terminal and dispatch-ambiguous obligations keep their
        # escalation evidence and permit ONLY finish BLOCKED (spec rev 3).
        blocking = []
        for ob in self.obligations().values():
            if ob["runId"] != run_id:
                continue
            if ob["state"] == "failed_terminal" and ob["kind"] != "gate":
                blocking.append("obligation {}:{} is failed_terminal".format(ob["kind"], ob["slot"]))
            elif ob["kind"] == "dispatch" and ob["detail"].get("ambiguous"):
                # Sticky (spec rev 3): once escalated, a late artifact does not
                # clear the hold -- a human does, by finishing the run.
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
                if ob["kind"] == "dispatch" and run.has(ONESHOT_ARTIFACTS.get(ob["slot"], CRITIC_ARTIFACT)):
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
            if external and self.live:
                # Someone else finished a controller run (a person, or a legacy
                # session that ignored the cutover): say so, never silently.
                # Raised BEFORE the done record, so a kill between them
                # re-enters this path next fire.
                self.ensure_alarm(run_id, "controller_foreign_finish", "foreign-finish:{}".format(run_id[-40:]),
                                  {"verdict": verdict})
            self.record(run_id, "run", "claim", "done", 1, {"verdict": verdict, "finishedBy": "gate" if external else
                                                          "controller"})
            # Owner steps still waiting are moot once the verdict is written.
            for ob in list(self.obligations().values()):
                if ob["runId"] == run_id and ob["kind"] == "owner" and ob["state"] in ("intent", "enqueued"):
                    self.record(run_id, "owner", ob["slot"], "abandoned", 1, {"reason": "run finished"})
            crash_point("after-run-done", "run", "claim")
        if is_freeze or obligation_key(run_id, "gh", "freeze-close") in self.obligations():
            key = obligation_key(run_id, "gh", "freeze-close")
            ob = self.obligations().get(key)
            if ob and ob["state"] == "intent":
                started = parse_iso(ob["history"][0].get("at"))
                if started and (self.now - started).total_seconds() > POST_FINISH_SLA_SECONDS:
                    self.ensure_alarm(run_id, "controller_obligation_overdue", "overdue:{}".format(key[:12]),
                                      {"obligation": "gh:freeze-close"})
                    if not ob["detail"].get("overdue"):
                        self.record(run_id, "gh", "freeze-close", "intent", 1, {"overdue": True})
            self.github(run_id, "finished", "freeze-close")
        self.decide(run_id, "finished", "log", "mechanical", "run finished", verdict=verdict,
                    finishedBy="gate" if external else "controller")
        return "finished"

    # -- fire ---------------------------------------------------------------

    def _settle_open_alarms(self, match):
        """Drive every open alarm send `match` selects to its receipt: an
        intent (killed before the enqueue) replays the SAME attempt, an
        enqueued one reads its receipt, a failed receipt retries. Each key at
        most once per fire (self.driven), so a send already driven by its own
        condition this fire is not re-run."""
        for ob in list(self.obligations().values()):
            if ob["kind"] != "send" or ob["state"] not in ("intent", "enqueued", "failed") or ob["key"] in self.driven:
                continue
            if not match(ob):
                continue
            self.send(ob["runId"], "alarm", ob["slot"], fingerprint=ob["detail"].get("fingerprint"),
                      hint=ob["detail"].get("hint"), thread_key=ob["detail"].get("threadKey"))

    def _settle_alarm_sends(self, run_id):
        """A run's alarm posts, settled before the GO barrier reads them, or it
        waits on a post delivered long ago and reads its age as unreceipted."""
        self._settle_open_alarms(lambda ob: ob["runId"] == run_id and ob["slot"].startswith("alarm:"))

    def _drain_alarms(self):
        """Every open alarm post, whatever its run's phase (or a done run's):
        a journaled-undelivered alarm (intent@0), a killed-after-intent one,
        an enqueued one awaiting its receipt, a failed receipt to retry."""
        self._settle_open_alarms(lambda ob: is_alarm_send(ob["runId"], ob["slot"]) and ob["runId"] not in self.legacy)

    def fire_once(self):
        # Alarms carried over from an earlier fire go FIRST, before any run
        # can spend this fire on ordinary work.
        self._drain_alarms()
        self.reconcile_claims()
        runs = set(self.journal.runs()) | set(self.gate.active_claims())
        summary = []
        for run_id in sorted(runs):
            if not RUN_ID_RE.match(run_id) or run_id.startswith(PSEUDO_PREFIX) or run_id in self.legacy:
                continue
            phase = self.step_run_guarded(run_id)
            if phase:
                summary.append({"runId": run_id, "phase": phase})
        # ...and those raised during this fire, if a lane slot is left.
        self._drain_alarms()
        return summary

    def pick_owner_wake(self):
        """At most ONE owner wake per fire: the task's one session runs one
        judgment turn at a time. Oldest due step first; a brief written this
        fire counts as its first offer, a re-offer is journaled."""
        obs = self.obligations()

        def still_due(w):
            # Filtered against the FINAL state of the fire: a step queued
            # early may since have been abandoned, or its run finished, timed
            # out or had its verdict frozen.
            ob = obs.get(w["key"])
            if not ob or ob["state"] != "enqueued":
                return False
            run_ob = obs.get(obligation_key(w["runId"], "run", "claim"))
            if not run_ob or run_ob["state"] in ("done", "abandoned"):
                return False
            if obligation_key(w["runId"], "verdict", "validated") in obs:
                return False
            return not any(obligation_key(w["runId"], "gate", v) in obs
                           for v in TERMINAL_VERBS + ("finish-resume",))

        live = [w for w in self.owner_wakes if self.live and still_due(w)]
        if not live:
            return None
        wake = sorted(live, key=lambda w: (str(w.get("since")), w["runId"], w["step"]))[0]
        ob = self.obligations().get(wake["key"]) or {"detail": {}}
        detail = ob["detail"]
        if detail.get("offerFire") != self.fire:
            # A re-run of the SAME fire (a supervisor retry, or a fire killed
            # before the wrapper printed its line) re-emits the wake without
            # counting another offer.
            offers = 1 if detail.get("offerFire") is None else int(detail.get("offers") or 1) + 1
            self.record(wake["runId"], "owner", wake["step"], "enqueued", 1, {"offers": offers, "offerFire": self.fire})
        return {"step": wake["step"], "runId": wake["runId"], "brief": wake["brief"]}


# ---------------------------------------------------------------------------
# cli


def resolve_mode(args):
    env = os.environ.get("SMOKE_CONTROLLER_MODE", "off")
    mode = "shadow" if args.shadow else env
    if mode not in MODES:
        raise ControllerError("SMOKE_CONTROLLER_MODE={!r} is not a mode (off|shadow|live)".format(mode))
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


def live_config(args):
    return {
        "repo": args.repo, "send_to": args.send_to, "gate_cmd": args.gate_cmd, "gh_cmd": args.gh_cmd,
        "ncl_cmd": args.ncl_cmd, "enqueue_cmd": args.enqueue_cmd, "outbox_root": args.outbox_root,
        "critic_log": args.critic_log, "challenger_mention": args.challenger_mention,
        "oneshot_model": args.oneshot_model, "oneshot_effort": args.oneshot_effort,
        "deadline": args.deadline_epoch,
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)
    env = os.environ.get
    for name in ("init", "step", "validate"):
        s = sub.add_parser(name)
        s.add_argument("--shadow", action="store_true", help="force shadow mode whatever SMOKE_CONTROLLER_MODE says")
        s.add_argument("--out-dir", default=env("SMOKE_CONTROLLER_OUT_DIR") or env("SMOKE_CONTROLLER_SHADOW_DIR"))
        s.add_argument("--gate-state-dir", default=env("SMOKE_GATE_STATE_DIR"))
        s.add_argument("--run-root", default=env("SMOKE_GATE_RUN_ROOT"))
        s.add_argument("--poll-json")
        s.add_argument("--alarm-queue-dir", help="live: queued gate alarm wakes (the live worker's durable queue)")
        s.add_argument("--receipts-json")
        s.add_argument("--tasks-json")
        s.add_argument("--pr-heads-json")
        s.add_argument("--now")
        s.add_argument("--fire")
        s.add_argument("--lock-timeout", type=float, default=30.0)
        # live only
        s.add_argument("--cutover-json")
        s.add_argument("--owner-dispatch-cutover-json", default=env("SMOKE_CONTROLLER_OWNER_DISPATCH_CUTOVER_JSON"),
                       help="opt-in boundary {enabled:true,legacyRuns:[...]}; active campaigns retain their route")
        s.add_argument("--repo", default=env("SMOKE_GATE_REPO"))
        s.add_argument("--send-to", default=env("SMOKE_CONTROLLER_SEND_TO"))
        s.add_argument("--gate-cmd", default=env("SMOKE_CONTROLLER_GATE_CMD"))
        s.add_argument("--gh-cmd", default=env("SMOKE_CONTROLLER_GH_CMD") or "gh")
        s.add_argument("--ncl-cmd", default=env("SMOKE_CONTROLLER_NCL_CMD") or "ncl")
        s.add_argument("--enqueue-cmd", default=env("SMOKE_CONTROLLER_ENQUEUE_CMD") or "bun /app/src/cli/enqueue-send.ts")
        s.add_argument("--outbox-root", default=env("SMOKE_CONTROLLER_OUTBOX_ROOT"))
        s.add_argument("--critic-log", default=env("SMOKE_CONTROLLER_CRITIC_LOG"))
        s.add_argument("--challenger-mention", default=env("SMOKE_CONTROLLER_CHALLENGER_MENTION"))
        s.add_argument("--oneshot-model", default=env("SMOKE_CONTROLLER_ONESHOT_MODEL"))
        s.add_argument("--oneshot-effort", default=env("SMOKE_CONTROLLER_ONESHOT_EFFORT"))
        s.add_argument("--deadline-epoch", type=float, default=None,
                       help="live: no effect subprocess may run past this wall-clock time")
    args = p.parse_args(argv)
    journal = None
    try:
        mode = resolve_mode(args)
        if mode == "off":
            print(json.dumps({"ok": True, "mode": "off", "wakeAgent": False}))
            return 0
        out_dir = args.out_dir or (os.path.join(args.gate_state_dir, "controller-shadow" if mode == "shadow" else
                                                "controller") if args.gate_state_dir else None)
        if not out_dir:
            raise ControllerError("no --out-dir and no SMOKE_GATE_STATE_DIR")
        journal = Journal(out_dir, mode)
        if not journal.lock(args.lock_timeout):
            print(json.dumps({"ok": True, "mode": mode, "wakeAgent": False, "skipped": "control.lock busy"}))
            return 0
        if args.command == "init":
            journal.init()
            print(json.dumps({"ok": True, "mode": mode, "initialized": journal.path}))
            return 0
        if args.command == "validate":
            # The full load (torn tail, record schema, born mode, per-record
            # mode) under control.lock, with no effect: the live worker runs
            # this BEFORE any progress stamp or poll.
            journal.load()
            print(json.dumps({"ok": True, "mode": mode, "valid": True, "records": len(journal.records)}))
            return 0
        effects = EffectLayer(mode, live_config(args) if mode == "live" else None)
        if mode == "live" and not args.run_root:
            raise ControllerError("live mode needs --run-root")
        journal.load()
        now = parse_iso(args.now) if args.now else dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        if now is None:
            raise ControllerError("--now {!r} is not ISO-8601".format(args.now))
        gate = GateView(args.gate_state_dir)
        ctl = Controller(args, journal, gate, effects, now, args.fire or iso(now))
        effects.bind(ctl)
        summary = ctl.fire_once()
        owner_wake = ctl.pick_owner_wake()
        print(json.dumps({"ok": True, "mode": mode, "wakeAgent": False, "fire": ctl.fire, "runs": summary,
                          "decisions": len(ctl.decisions),
                          "effectsRefused": len(effects.performed) if mode == "shadow" else 0,
                          "effectsPerformed": len(effects.performed) if mode == "live" else 0,
                          "ownerWake": owner_wake,
                          "alarms": ctl.alarms, "stepErrors": ctl.step_errors,
                          "gateStateErrors": gate.errors}, sort_keys=True))
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
