#!/usr/bin/env python3
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile

USAGE = """usage:
  smoke-seat-lease.py check <seat>
  smoke-seat-lease.py status [<seat>]
  smoke-seat-lease.py grant <seat> --to <group> --until <ISO-8601 UTC>
  smoke-seat-lease.py transfer <seat> --to <group> --until <ISO-8601 UTC>
  smoke-seat-lease.py release <seat>

A seat is the account's login address. A lease binds it to one agent group
(the groupName in the host-owned /workspace/agent/container.json) until
--until. `check` exits 0 when this group may be issued the seat's credential
and 69 when it may not, printing SEAT_LEASE_REFUSED on stderr. A missing lease
or one past --until leaves the seat unleased; anything unreadable refuses."""

REFUSED = 69
NOT_PERMITTED = 3
SEAT_RE = re.compile(r"[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+")
GROUP_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


class Refusal(Exception):
    def __init__(self, reason, **fields):
        super().__init__(reason)
        self.reason = reason
        self.fields = fields


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(value):
    t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError("timestamp has no zone")
    return t


def seat_arg(raw):
    seat = (raw or "").lower()
    if not SEAT_RE.fullmatch(seat):
        usage("not a seat address: {!r}".format(raw))
    return seat


def usage(message=None):
    if message:
        print("smoke-seat-lease: " + message, file=sys.stderr)
    print(USAGE, file=sys.stderr)
    sys.exit(2)


def identity():
    path = os.environ.get("SMOKE_SEAT_LEASE_IDENTITY_FILE", "/workspace/agent/container.json")
    try:
        with open(path) as f:
            group = json.load(f).get("groupName")
    except (OSError, ValueError, AttributeError) as e:
        raise Refusal("no-identity", detail="{}: {}".format(path, e.__class__.__name__))
    if not isinstance(group, str) or not GROUP_RE.fullmatch(group):
        raise Refusal("no-identity", detail="{} has no usable groupName".format(path))
    return group


def ledger_dir():
    root = os.environ.get("SMOKE_GATE_SHARED_ROOT", "/workspace/workgroup")
    try:
        mounted = subprocess.run(["mountpoint", "-q", root], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        mounted = False
    if not mounted:
        raise Refusal("no-ledger", detail="shared root {} is not a mounted filesystem".format(root))
    real_root = os.path.realpath(root)
    path = os.path.join(root, "qa-coordinator", "seat-leases")
    real = os.path.realpath(path)
    if os.path.commonpath([real_root, real]) != real_root:
        raise Refusal("no-ledger", detail="{} resolves outside the shared root".format(path))
    if os.path.lexists(path) and not (os.path.isdir(path) and os.access(path, os.R_OK | os.X_OK)):
        raise Refusal("no-ledger", detail="{} is not a readable directory".format(path))
    return path


def read_lease(directory, seat):
    path = os.path.join(directory, seat + ".json")
    if not os.path.lexists(path):
        return None
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            raise ValueError("not a regular file")
        with open(path) as f:
            lease = json.load(f)
        if lease.get("seat") != seat:
            raise ValueError("names another seat")
        if not isinstance(lease.get("holder"), str) or not GROUP_RE.fullmatch(lease["holder"]):
            raise ValueError("no usable holder")
        lease["_until"] = parse_time(lease.get("until"))
    except (OSError, ValueError, AttributeError, TypeError) as e:
        raise Refusal("unreadable-lease", seat=seat, detail="{}: {}".format(path, e))
    return lease


def live(lease):
    return lease is not None and lease["_until"] > now()


def check(seat):
    me = identity()
    lease = read_lease(ledger_dir(), seat)
    if live(lease) and lease["holder"] != me:
        raise Refusal("leased-elsewhere", seat=seat, holder=lease["holder"], until=iso(lease["_until"]), caller=me)
    return 0


def status(seat):
    directory = ledger_dir()
    if seat:
        seats = [seat]
    elif os.path.isdir(directory):
        seats = sorted(n[:-5] for n in os.listdir(directory) if n.endswith(".json"))
    else:
        seats = []
    for s in seats:
        try:
            lease = read_lease(directory, s)
        except Refusal as r:
            print(json.dumps({"seat": s, "state": "unreadable", "detail": r.fields.get("detail")}))
            continue
        if lease is None:
            print(json.dumps({"seat": s, "state": "unleased"}))
            continue
        print(json.dumps({"seat": s, "state": "live" if live(lease) else "expired", "holder": lease["holder"],
                          "until": iso(lease["_until"])}))
    return 0


def write(seat, verb, to, until):
    me = identity()
    directory = ledger_dir()
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lease = read_lease(directory, seat)
        path = os.path.join(directory, seat + ".json")
        if verb == "grant" and live(lease):
            return refuse_op("{} is leased to {} until {}; only its holder can transfer it".format(
                seat, lease["holder"], iso(lease["_until"])))
        if verb in ("transfer", "release"):
            if not live(lease):
                return refuse_op("{} has no live lease to {} ({})".format(
                    seat, verb, "expired " + iso(lease["_until"]) if lease else "unleased"))
            if lease["holder"] != me:
                return refuse_op("{} is held by {}, not {}".format(seat, lease["holder"], me))
        if verb == "release":
            os.unlink(path)
            print(json.dumps({"seat": seat, "state": "unleased", "releasedBy": me}))
            return 0
        record = {"seat": seat, "holder": to, "until": iso(until), "grantedBy": me, "at": iso(now())}
        fd, tmp = tempfile.mkstemp(dir=directory, prefix="." + seat + ".")
        with os.fdopen(fd, "w") as f:
            json.dump(record, f)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        print(json.dumps(record))
        return 0


def refuse_op(message):
    print("smoke-seat-lease: " + message, file=sys.stderr)
    return NOT_PERMITTED


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        usage()
    verb, rest = argv[0], argv[1:]
    opts, args = {}, []
    while rest:
        a = rest.pop(0)
        if a in ("--to", "--until"):
            if not rest:
                usage(a + " needs a value")
            opts[a] = rest.pop(0)
        else:
            args.append(a)
    try:
        if verb == "check" and len(args) == 1 and not opts:
            return check(seat_arg(args[0]))
        if verb == "status" and len(args) <= 1 and not opts:
            return status(seat_arg(args[0]) if args else None)
        if verb == "release" and len(args) == 1 and not opts:
            return write(seat_arg(args[0]), verb, None, None)
        if verb in ("grant", "transfer") and len(args) == 1 and set(opts) == {"--to", "--until"}:
            if not GROUP_RE.fullmatch(opts["--to"]):
                usage("not a group name: {!r}".format(opts["--to"]))
            try:
                until = parse_time(opts["--until"])
            except ValueError:
                usage("--until must be an ISO-8601 time with a zone")
            if until <= now():
                usage("--until is not in the future")
            return write(seat_arg(args[0]), verb, opts["--to"], until)
    except Refusal as r:
        fields = " ".join("{}={}".format(k, v) for k, v in r.fields.items())
        print("SEAT_LEASE_REFUSED reason={} {}".format(r.reason, fields).rstrip(), file=sys.stderr)
        if verb != "check":
            return NOT_PERMITTED
        print("This group may not be issued this seat's credential. It is seat-unavailable, not a login "
              "failure: record the check blocked, and do not retry the login.", file=sys.stderr)
        return REFUSED
    usage()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
