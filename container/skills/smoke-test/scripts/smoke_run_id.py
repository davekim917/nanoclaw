"""The one parser for a PR campaign's run id.

smoke-pr-gate.sh's campaign_run_id builds every PR campaign's id as
`<prefix>-pr<n>-<sha12>-<YYYYMMDDTHHMMSSZ>`. Every reader parses it here with
fullmatch (a `$` anchor would still admit a trailing newline), so a task run, a
backup directory or a prefix that itself contains `-pr<n>-` is never misread.
"""
import datetime as dt
import re

_TAIL = r"-pr(?P<pr>[0-9]+)-(?P<sha>[0-9a-f]{12})-(?P<stamp>[0-9]{8}T[0-9]{6}Z)"


def pattern(prefix=None):
    """The compiled run-id pattern, for one install's prefix or (None) any prefix."""
    head = re.escape(prefix) if prefix is not None else r"(?P<prefix>.+)"
    return re.compile(head + _TAIL)


_ANY = pattern()


def parse(run_id, prefix=None):
    """The match for a PR campaign run id, or None for anything else."""
    if not isinstance(run_id, str):
        return None
    return (_ANY if prefix is None else pattern(prefix)).fullmatch(run_id)


def pr_number(run_id, prefix=None):
    m = parse(run_id, prefix)
    return int(m.group("pr")) if m else None


def claimed_at(run_id, prefix=None):
    """The UTC claim instant stamped in a campaign run id, or None for anything else
    (including a well-shaped stamp that is no real date, such as Feb 30)."""
    m = parse(run_id, prefix)
    if not m:
        return None
    try:
        return dt.datetime.strptime(m.group("stamp"), "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def pr_tag(run_id):
    """`pr<n>-` for a campaign run id; the id itself for anything else."""
    m = parse(run_id)
    return "pr{}-".format(m.group("pr")) if m else run_id
