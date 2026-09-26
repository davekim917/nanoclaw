#!/usr/bin/env python3
"""Print a scheduled task script's final stdout line: its observation.

    python3 task_observation.py --kind empty --evidence "no new PRs" --bound 4h
    python3 task_observation.py --kind unfinished --evidence-json '{"pr": 12}' \
        --bound 4h --since 2026-09-26T08:00:00Z
    python3 task_observation.py --wake --data '{"pr": 12}'

--data reaches the agent's prompt when the fire wakes it. A fire that does not
wake the agent records its observation and nothing else: its data is not
stored anywhere, so put what the operator needs to see in the evidence.

or, from Python, after putting this directory on sys.path:

    from task_observation import observation_line
    print(observation_line("empty", "no new PRs", "4h"))

An invalid observation prints nothing on stdout and exits 2, so the fire
records a script error that names the problem instead of a quiet success.

The rules mirror the host judge (src/modules/scheduling/observation.ts); both
are tested against cases.json in this directory.
"""

import argparse
import calendar
import json
import re
import sys
import time

KINDS = ("empty", "unreadable", "blocked", "unfinished")
MINUTE_MS = 60_000
MIN_BOUND_MS = 15 * MINUTE_MS
MAX_BOUND_MS = 7 * 24 * 60 * MINUTE_MS
SINCE_MAX_FUTURE_MS = 5 * MINUTE_MS
BOUND_UNIT_MS = {"m": MINUTE_MS, "h": 60 * MINUTE_MS, "d": 24 * 60 * MINUTE_MS}

# [0-9], never \d: Python's \d also matches non-ASCII digits.
BOUND_PATTERN = re.compile(r"([1-9][0-9]*)([mhd])")
SINCE_PATTERN = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})"
    r"(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?(?:(Z)|([+-])([0-9]{2}):([0-9]{2}))"
)


class ObservationError(ValueError):
    """The observation does not satisfy the contract."""


def parse_bound(bound):
    """'90m' | '4h' | '2d' -> milliseconds clamped to [15m, 7d], or None."""
    if not isinstance(bound, str):
        return None
    match = BOUND_PATTERN.fullmatch(bound)
    if not match:
        return None
    ms = int(match.group(1)) * BOUND_UNIT_MS[match.group(2)]
    return min(MAX_BOUND_MS, max(MIN_BOUND_MS, ms))


def parse_since(since):
    """ISO-8601 with an explicit zone -> epoch milliseconds, or None."""
    if not isinstance(since, str):
        return None
    m = SINCE_PATTERN.fullmatch(since)
    if not m:
        return None
    year, month, day, hour, minute = (int(m.group(i)) for i in range(1, 6))
    second = int(m.group(6)) if m.group(6) is not None else 0
    if year < 1 or not 1 <= month <= 12:
        return None
    if not 1 <= day <= calendar.monthrange(year, month)[1]:
        return None
    if hour > 23 or minute > 59 or second > 59:
        return None
    offset_ms = 0
    if m.group(8) is None:
        off_hours, off_minutes = int(m.group(10)), int(m.group(11))
        if off_hours > 23 or off_minutes > 59:
            return None
        offset_ms = (-1 if m.group(9) == "-" else 1) * (off_hours * 60 + off_minutes) * MINUTE_MS
    millis = int(m.group(7).ljust(3, "0")[:3]) if m.group(7) is not None else 0
    return calendar.timegm((year, month, day, hour, minute, second)) * 1000 + millis - offset_ms


def _has_evidence(evidence):
    if isinstance(evidence, str):
        return evidence.strip() != ""
    if isinstance(evidence, (list, dict)):
        return len(evidence) > 0
    return False


def observation_problem(observation, now_ms=None):
    """Why an observation is not a valid declaration, or None when it is one."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    if not isinstance(observation, dict):
        return "observation is not an object"
    if observation.get("kind") not in KINDS:
        return "kind must be one of " + ", ".join(KINDS)
    if not _has_evidence(observation.get("evidence")):
        return "evidence must be a non-empty string, object or array"
    if parse_bound(observation.get("bound")) is None:
        return "bound must look like 90m, 4h or 2d"
    if "since" in observation:
        since_ms = parse_since(observation["since"])
        if since_ms is None:
            return "since must be an ISO-8601 timestamp with a zone"
        if since_ms > now_ms + SINCE_MAX_FUTURE_MS:
            return "since is more than 5 minutes in the future"
    elif observation["kind"] == "unfinished":
        return "unfinished requires since"
    return None


def observation_line(kind, evidence, bound, since=None, data=None):
    """The final stdout line for a fire that does not wake the agent. Only the
    observation is recorded; `data` is not."""
    observation = {"kind": kind, "evidence": evidence, "bound": bound}
    if since is not None:
        observation["since"] = since
    problem = observation_problem(observation)
    if problem is not None:
        raise ObservationError(problem)
    return json.dumps(
        {"wakeAgent": False, "observation": observation, "data": {} if data is None else data},
        separators=(",", ":"),
        allow_nan=False,
    )


def wake_line(data=None):
    """The final stdout line for a fire that wakes the agent."""
    return json.dumps(
        {"wakeAgent": True, "data": {} if data is None else data}, separators=(",", ":"), allow_nan=False
    )


def _reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def _json_arg(text, name):
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except ValueError as err:
        raise ObservationError(f"{name} is not valid JSON: {err}") from err


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--wake", action="store_true", help="wake the agent; no observation")
    parser.add_argument("--kind", choices=KINDS)
    evidence = parser.add_mutually_exclusive_group()
    evidence.add_argument("--evidence", help="evidence as text")
    evidence.add_argument("--evidence-json", help="evidence as a JSON object or array")
    parser.add_argument("--bound", help="how long a non-empty result may stand: 90m, 4h, 2d")
    parser.add_argument("--since", help="ISO-8601 start of the open work; required for unfinished")
    parser.add_argument(
        "--data",
        help="JSON for the agent's prompt on --wake; not recorded on a fire that does not wake,"
        " so put what the operator needs in the evidence",
    )
    args = parser.parse_args(argv)
    try:
        data = _json_arg(args.data, "--data") if args.data is not None else None
        if args.wake:
            if args.kind or args.evidence is not None or args.evidence_json is not None or args.bound or args.since:
                raise ObservationError("--wake takes only --data")
            print(wake_line(data))
            return 0
        if args.kind is None:
            raise ObservationError("--kind is required unless --wake")
        ev = _json_arg(args.evidence_json, "--evidence-json") if args.evidence_json is not None else args.evidence
        print(observation_line(args.kind, ev, args.bound, args.since, data))
        return 0
    except ObservationError as err:
        print(f"task_observation: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
