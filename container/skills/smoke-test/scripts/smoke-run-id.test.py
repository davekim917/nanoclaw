#!/usr/bin/env python3
"""The canonical PR campaign run-id parser (smoke_run_id.py) and its readers."""
import importlib.util
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # smoke-acceptance.test.sh rejects __pycache__ beside the scripts
sys.path.insert(0, HERE)
import smoke_run_id  # noqa: E402

spec = importlib.util.spec_from_file_location("replay", os.path.join(HERE, "smoke-campaign-replay.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

RUN = "acme-pr-pr42-0123456789ab-20260910T000000Z"


class RunIds(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(smoke_run_id.pr_number(RUN), 42)
        self.assertEqual(smoke_run_id.pr_number(RUN, "acme-pr"), 42)
        self.assertIsNone(smoke_run_id.pr_number(RUN, "other"))

    def test_claim_instant_comes_from_the_stamp(self):
        self.assertEqual(smoke_run_id.claimed_at(RUN).isoformat(), "2026-09-10T00:00:00+00:00")
        self.assertIsNone(smoke_run_id.claimed_at(RUN + "-copy"))
        self.assertIsNone(smoke_run_id.claimed_at("acme-maintenance-20260911T000000Z"))

    def test_tag_is_the_campaign_segment(self):
        self.assertEqual(smoke_run_id.pr_tag(RUN), "pr42-")

    def test_prefix_containing_a_pr_segment(self):
        rid = "lab-pr7-blue-pr42-0123456789ab-20260910T000000Z"
        self.assertEqual(smoke_run_id.pr_tag(rid), "pr42-")
        self.assertEqual(smoke_run_id.pr_number(rid, "lab-pr7-blue"), 42)

    def test_anchored_at_both_ends(self):
        for bad in (RUN + "-copy", "x" + RUN[4:].replace("0123456789ab", "0123456789a"),
                    "acme-maintenance-20260911T000000Z", "run-manual-13", "acme-pr-pr42-0123456789ab-20260910T0000Z"):
            self.assertIsNone(smoke_run_id.parse(bad), bad)
        self.assertEqual(smoke_run_id.pr_tag("run-manual-13"), "run-manual-13")

    def test_replay_reads_only_canonical_campaign_runs(self):
        names = ["acme-pr7-0123456789ab-20260910T000000Z", "acme-maintenance-20260911T000000Z",
                 "acme-pr8-0123456789ab-20260801T000000Z", "other-pr9-0123456789ab-20260910T000000Z",
                 "acme-pr7-0123456789ab-20260910T000000Z-copy"]
        self.assertEqual(replay.campaign_runs(names, "acme", "20260901"),
                         ["acme-pr7-0123456789ab-20260910T000000Z"])

    def test_the_gate_builds_what_this_parses(self):
        gate = os.path.join(HERE, "smoke-pr-gate.sh")
        body = open(gate, encoding="utf8").read()
        start = body.index("campaign_run_id() {")
        fn = body[start:body.index("\n}\n", start) + 3]
        out = subprocess.run(["bash", "-c", 'RUN_PREFIX=acme-pr; ' + fn + ' campaign_run_id 42 0123456789abcdef0123 1789000000'],
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(smoke_run_id.pr_number(out, "acme-pr"), 42, out)
        self.assertEqual(smoke_run_id.claimed_at(out).timestamp(), 1789000000, out)


if __name__ == "__main__":
    unittest.main()
