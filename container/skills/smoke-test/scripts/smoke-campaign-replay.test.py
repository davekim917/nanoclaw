#!/usr/bin/env python3
"""smoke-campaign-replay.py run-id handling, for any install's prefix."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("replay", os.path.join(HERE, "smoke-campaign-replay.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class RunIds(unittest.TestCase):
    def test_tag_is_the_campaign_segment(self):
        self.assertEqual(replay.pr_tag("acme-pr-pr42-0123456789ab-20260910T000000Z"), "pr42-")

    def test_prefix_containing_a_pr_segment(self):
        self.assertEqual(replay.pr_tag("lab-pr7-blue-pr42-0123456789ab-20260910T000000Z"), "pr42-")

    def test_only_canonical_campaign_runs_are_read(self):
        names = ["acme-pr7-0123456789ab-20260910T000000Z", "acme-maintenance-20260911T000000Z",
                 "acme-pr8-0123456789ab-20260801T000000Z", "other-pr9-0123456789ab-20260910T000000Z"]
        self.assertEqual(replay.campaign_runs(names, "acme", "20260901"),
                         ["acme-pr7-0123456789ab-20260910T000000Z"])

    def test_pr_number_from_a_prefix_containing_a_pr_segment(self):
        m = replay.campaign_re("lab-pr7-blue").match("lab-pr7-blue-pr42-0123456789ab-20260910T000000Z")
        self.assertEqual(m.group(1), "42")


if __name__ == "__main__":
    unittest.main()
