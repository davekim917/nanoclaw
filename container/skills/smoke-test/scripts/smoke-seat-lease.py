#!/usr/bin/env python3
import datetime as dt
import fcntl
import json
import os
import re
import stat
import subprocess
import sys

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


def open_ledger(create=False):
    root = os.environ.get("SMOKE_GATE_SHARED_ROOT", "/workspace/workgroup")
    try:
        mounted = subprocess.run(["mountpoint", "-q", root], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        mounted = False
    if not mounted:
        raise Refusal("no-ledger", detail="shared root {} is not a mounted filesystem".format(root))
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    except OSError as e:
        raise Refusal("no-ledger", detail="{}: {}".format(root, e.__class__.__name__))
    for part in ("qa-coordinator", "seat-leases"):
        try:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        except FileNotFoundError:
            return None
        except OSError as e:
            raise Refusal("no-ledger", detail="{}/{}: {}".format(root, part, e.__class__.__name__))
        finally:
            os.close(fd)
        fd = child
    return fd


def read_lease(dfd, seat):
    if dfd is None:
        return None
    try:
        lfd = os.open(seat + ".json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Refusal("unreadable-lease", seat=seat, detail=e.__class__.__name__)
    try:
        with os.fdopen(lfd) as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise ValueError("not a regular file")
            lease = json.load(f)
        if lease.get("seat") != seat:
            raise ValueError("names another seat")
        if not isinstance(lease.get("holder"), str) or not GROUP_RE.fullmatch(lease["holder"]):
            raise ValueError("no usable holder")
        lease["_until"] = parse_time(lease.get("until"))
    except (OSError, ValueError, AttributeError, TypeError) as e:
        raise Refusal("unreadable-lease", seat=seat, detail=str(e))
    return lease


def live(lease):
    return lease is not None and lease["_until"] > now()


def check(seat):
    me = identity()
    dfd = open_ledger()
    try:
        lease = read_lease(dfd, seat)
    finally:
        if dfd is not None:
            os.close(dfd)
    if live(lease) and lease["holder"] != me:
        raise Refusal("leased-elsewhere", seat=seat, holder=lease["holder"], until=iso(lease["_until"]), caller=me)
    return 0


def status(seat):
    dfd = open_ledger()
    if seat:
        seats = [seat]
    elif dfd is not None:
        seats = sorted(n[:-5] for n in os.listdir(dfd) if n.endswith(".json"))
    else:
        seats = []
    for s in seats:
        try:
            lease = read_lease(dfd, s)
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
    dfd = open_ledger(create=True)
    if dfd is None:
        raise Refusal("no-ledger", detail="the ledger disappeared while it was being created")
    lock = None
    try:
        lock = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        fcntl.flock(lock, fcntl.LOCK_EX)
        lease = read_lease(dfd, seat)
        name = seat + ".json"
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
            os.unlink(name, dir_fd=dfd)
            print(json.dumps({"seat": seat, "state": "unleased", "releasedBy": me}))
            return 0
        record = {"seat": seat, "holder": to, "until": iso(until), "grantedBy": me, "at": iso(now())}
        tmp = ".{}.{}".format(name, os.getpid())
        tfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dfd)
        with os.fdopen(tfd, "w") as f:
            json.dump(record, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        print(json.dumps(record))
        return 0
    finally:
        if lock is not None:
            os.close(lock)
        os.close(dfd)


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
