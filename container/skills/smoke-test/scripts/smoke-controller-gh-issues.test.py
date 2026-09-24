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
                                                   ["smoke-finding", "severity:p3", "ui", "bug"])
        self.assertEqual(kept, ["smoke-finding", "severity:p3", "ui"])
        self.assertEqual(mapped, ["P3->severity:p3"])
        self.assertEqual(dropped, ["nope"])

    def test_shorthand_without_a_severity_label_is_dropped_and_an_exact_p_label_is_kept(self):
        self.assertEqual(ctl.resolve_labels(["P1"], ["bug"]), ([], [], ["P1"]))
        self.assertEqual(ctl.resolve_labels(["P1"], ["P1", "severity:p1"]), (["P1"], [], []))

    def test_smoke_finding_is_dropped_like_any_label_the_repo_lacks(self):
        self.assertEqual(ctl.resolve_labels(["smoke-finding", "P3"], ["severity:p3"]),
                         (["severity:p3"], ["P3->severity:p3"], ["smoke-finding"]))

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

    def test_a_repo_without_smoke_finding_still_gets_its_issue(self):
        self.gh(labels=["severity:p3"])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["severity:p3"])
        self.assertIn("`smoke-finding`", issue["body"])

    def test_a_repo_without_smoke_finding_dedups_across_runs_unlabelled(self):
        # An earlier campaign filed this finding unlabelled; the marker cannot
        # see it (its key carries that run's id), so title dedup must.
        prior = {"number": 5, "title": "Upload preview missing", "body": "earlier run", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["severity:p3"], issues=[prior])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 1)
        ob = self.c.obligations()[ctl.obligation_key(RUN, "gh", "issue:CF-1")]
        self.assertEqual((ob["detail"]["via"], ob["detail"]["duplicateOf"]), ("dedup", 5))

    def test_a_repo_with_smoke_finding_keeps_dedup_scoped_to_it(self):
        prior = {"number": 5, "title": "Upload preview missing", "body": "a human's issue", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=[prior])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(len(self.filed()), 2)

    def test_a_title_match_is_named_in_the_decision_and_the_pr_run_record(self):
        prior = {"number": 5, "title": "Upload preview missing", "body": "a human's issue", "state": "open",
                 "labels": [], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["severity:p3"], issues=[prior])
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], 5)
        self.assertEqual(self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"}), "done")
        [comment] = json.loads((self.state / "gh.json").read_text())["comments"]["7"]
        self.assertIn("Finding CF-1: matched open issue #5 by title, not filed again", comment["body"])

    def test_no_match_leaves_the_run_record_as_it_was(self):
        self.gh(labels=["smoke-finding", "severity:p3"])
        self.c.github(RUN, "synthesis", "issue:CF-1")
        self.c.github(RUN, "synthesis", "pr-comment", hint={"verdict": "GO"})
        [comment] = json.loads((self.state / "gh.json").read_text())["comments"]["7"]
        self.assertNotIn("matched open issue", comment["body"])

    def test_a_match_past_the_listing_cap_is_found_by_title_search(self):
        noise = [{"number": 1000 + k, "title": "Other finding {}".format(k), "body": "", "state": "open",
                  "labels": ["smoke-finding"], "html_url": "https://github.test/issues/{}".format(1000 + k)}
                 for k in range(500)]
        match = {"number": 5, "title": "Upload preview missing", "body": "", "state": "open",
                 "labels": ["smoke-finding"], "html_url": "https://github.test/issues/5"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=noise + [match])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertEqual(self.c.decisions[-1]["duplicateOf"], 5)
        self.assertEqual(len(self.filed()), 501)

    def test_a_near_miss_from_title_search_is_not_a_match(self):
        # `in:title` search is tokenized and fuzzy: it only narrows candidates,
        # and normalized-title equality still decides the match.
        noise = [{"number": 1000 + k, "title": "Other finding {}".format(k), "body": "", "state": "open",
                  "labels": ["smoke-finding"], "html_url": "https://github.test/issues/{}".format(1000 + k)}
                 for k in range(500)]
        near = {"number": 6, "title": "Upload preview missing on mobile", "body": "", "state": "open",
                "labels": ["smoke-finding"], "html_url": "https://github.test/issues/6"}
        self.gh(labels=["smoke-finding", "severity:p3"], issues=noise + [near])
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        self.assertNotIn("duplicateOf", self.c.decisions[-1])
        self.assertEqual(self.filed()[-1]["title"], "Upload preview missing")
        with open(os.environ["FAKE_LOG"]) as fh:
            searched = [json.loads(line)["argv"] for line in fh if "--search" in line]
        self.assertEqual(len(searched), 1)  # the near miss really came back from the search

    def test_a_label_listing_that_is_not_a_list_or_is_at_its_cap_is_unknown(self):
        self.gh(labelListRaw='{"message": "Not Found"}')
        self.assertIsNone(self.fx._labels_of("org/xzo"))
        self.fx._repo_labels = {}
        self.gh(labels=["label-{}".format(k) for k in range(1000)])
        self.assertIsNone(self.fx._labels_of("org/xzo"))
        self.fx._repo_labels = {}
        self.gh(labels=["label-{}".format(k) for k in range(999)])
        self.assertEqual(len(self.fx._labels_of("org/xzo")), 999)

    def test_a_recovered_listing_still_puts_the_dropped_note_in_the_filed_body(self):
        # Fire 1: the listing fails, the owner's labels go out unchanged, the
        # create is refused -- and its body payload is already on disk.
        self.gh(labels=["smoke-finding", "severity:p3"])
        (self.state / "faults.json").write_text(json.dumps({"gh:label-list": ["fail-before"]}))
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "intent")
        # Fire 2 (a fresh EffectLayer, as every fire is its own process): the
        # listing recovers, `nope` is dropped, and the note reaches the issue.
        self.fx._repo_labels = {}
        self.assertEqual(self.c.github(RUN, "synthesis", "issue:CF-1"), "done")
        [issue] = self.filed()
        self.assertEqual(issue["labels"], ["smoke-finding", "severity:p3"])
        self.assertIn("dropped: `nope`", issue["body"])

    def test_a_write_that_exits_zero_but_is_not_found_keeps_the_read_back_error(self):
        self.assertIsNone(ctl.gh_write_error((0, "", "noise"), "issue create"))
        self.assertEqual(ctl.gh_write_error((None, "", "timed out after 30s"), "pr comment"),
                         "pr comment timed out: timed out after 30s")


if __name__ == "__main__":
    unittest.main()
