#!/usr/bin/env python3
"""Controller finding issues against a repo's real label set (#1107).

XZO #2126 wedged its finish for an hour: an owner wrote `labels: ["P3"]`, the
repo has no `P3` (its convention is `severity:p3`), GitHub refused the whole
`gh issue create`, and the controller threw gh's stderr away -- so the
decision said `effect: unknown` and the overdue alarm said nothing about why.
Runs the real Effects._gh and Controller.github against the gh fake."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("controller", HERE / "smoke-campaign-controller.py")
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
RUN = "xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"
FAKES = HERE / "testdata" / "controller-live-fakes.py"


class ResolveLabels(unittest.TestCase):
    def test_maps_severity_shorthand_drops_unknown_keeps_repo_spelling(self):
        kept, mapped, dropped = ctl.resolve_labels(["smoke-finding", "P3", "UI", "nope", "ui"],
                                                   ["severity:p3", "ui", "bug"])
        self.assertEqual(kept, ["smoke-finding", "severity:p3", "ui"])
        self.assertEqual(mapped, ["P3->severity:p3"])
        self.assertEqual(dropped, ["nope"])

    def test_shorthand_without_a_severity_label_is_dropped_and_an_exact_p_label_is_kept(self):
        self.assertEqual(ctl.resolve_labels(["P1"], ["bug"]), ([], [], ["P1"]))
        self.assertEqual(ctl.resolve_labels(["P1"], ["P1", "severity:p1"]), (["P1"], [], []))

    def test_listing_failed_sends_labels_unchanged(self):
        self.assertEqual(ctl.resolve_labels(["smoke-finding", "P3"], None), (["smoke-finding", "P3"], [], []))


class FindingIssue(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "fake"
        self.state.mkdir()
        os.environ["FAKE_STATE"] = str(self.state)
        os.environ["FAKE_LOG"] = str(root / "calls.ndjson")
        issues = root / "runs" / RUN / "controller" / "issues"
        issues.mkdir(parents=True)
        (issues / "CF-1.json").write_text(json.dumps(
            {"title": "Upload preview missing", "body": "Seen on B1.", "labels": ["smoke-finding", "P3", "nope"]}))
        journal = root / "journal"
        journal.mkdir()
        gh = "{} {} gh".format(sys.executable, FAKES)
        self.fx = ctl.EffectLayer("live", {"repo": "org/xzo", "send_to": "x", "gate_cmd": "/unused",
                                       "enqueue_cmd": "/unused", "gh_cmd": gh, "ncl_cmd": "/unused"})
        c = ctl.Controller.__new__(ctl.Controller)
        c.journal = ctl.Journal.__new__(ctl.Journal)
        c.journal.records, c.journal._obs, c.journal.dir = [], {}, str(journal)
        c.journal.append = lambda rec: c.journal._fold(rec)
        c.args = SimpleNamespace(run_root=str(root / "runs"))
        c.gate = SimpleNamespace(active_claims=lambda: {}, pr_for_run=lambda run_id: 7)
        c.now = dt.datetime(2026, 9, 23, 15, 51, tzinfo=dt.timezone.utc)
        c.fire, c.planned, c.decisions, c.alarms = "fire-one", set(), [], []
        c.decide = lambda run_id, phase, dtype, cls, reason, **extra: c.decisions.append(dict(extra, type=dtype))
        c.ensure_alarm = lambda run_id, trigger, fp, detail, **kw: c.alarms.append((trigger, detail)) or True
        c.effects = self.fx
        self.fx.bind(c)
        c.record(RUN, "run", "claim", "claimed", detail={"pr": 7, "sha": "a" * 40})
        self.c = c

    def tearDown(self):
        self.tmp.cleanup()

    def gh(self, **db):
        (self.state / "gh.json").write_text(json.dumps(dict({"comments": {}, "issues": [], "prs": {}}, **db)))

    def filed(self):
        return json.loads((self.state / "gh.json").read_text())["issues"]

    def test_unknown_label_is_dropped_shorthand_mapped_and_the_create_lands(self):
        self.gh(labels=["smoke-finding", "severity:p3", "bug"])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["smoke-finding", "severity:p3"])
        self.assertIn("dropped: `nope`", issue["body"])
        self.assertEqual(self.c.decisions[-1]["labelsDropped"], ["nope"])
        self.assertEqual(self.c.decisions[-1]["labelsMapped"], ["P3->severity:p3"])
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["state"], ob["detail"]["labelsDropped"]), ("done", ["nope"]))

    def test_repo_labels_are_listed_once_per_fire(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        (Path(self.c.args.run_root) / RUN / "controller" / "issues" / "CF-2.json").write_text(
            json.dumps({"title": "Second finding", "labels": ["P3"]}))
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.c.github(RUN, "synthesis", "issue:CF-2")
        with open(os.environ["FAKE_LOG"]) as fh:
            calls = [json.loads(line) for line in fh]
        self.assertEqual(sum(1 for x in calls if x["argv"][:2] == ["label", "list"]), 1)
        self.assertEqual(len(self.filed()), 2)

    def test_refused_create_records_ghs_stderr_in_the_decision_and_the_overdue_alarm(self):
        # The listing fails, so the owner's labels go out unchanged and GitHub
        # refuses the create -- the #2126 shape. Its stderr is the only why.
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:label-list": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        self.assertEqual(self.filed(), [])
        err = self.c.decisions[-1]["error"]
        self.assertIn("issue create rc=1", err)
        self.assertIn("could not add label: 'P3' not found", err)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual(ob["detail"]["error"], err)
        self.c.now += dt.timedelta(seconds=ctl.RECEIPT_SLA_SECONDS + 60)
        self.c._alarm_overdue(RUN, "synthesis")
        [(trigger, detail)] = self.c.alarms
        self.assertEqual(trigger, "controller_obligation_overdue")
        self.assertEqual(detail["error"], err)

    def test_a_write_that_exits_zero_but_is_not_found_keeps_the_read_back_error(self):
        self.assertIsNone(ctl.gh_write_error((0, "", "noise"), "issue create"))
        self.assertEqual(ctl.gh_write_error((None, "", "timed out after 30s"), "pr comment"),
                         "pr comment timed out: timed out after 30s")


if __name__ == "__main__":
    unittest.main()
