#!/usr/bin/env python3
"""Hermetic controller phase admission: no model, CLI, channel or gate calls."""
import datetime as dt
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("controller", Path(__file__).with_name("smoke-campaign-controller.py"))
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
RUN = "xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"


class Effects:
    mode = "live"
    def __init__(self):
        self.calls, self.statuses = [], {}
        self.unknown = False
    def perform(self, effect):
        self.calls.append(effect)
        if not effect.get("dispatchEvent"):
            return {"outcome": "brief_written", "brief": "brief.md"}
        if self.unknown:
            return {"outcome": "unknown"}
        key = effect["step"] + "/" + effect["dispatchEvent"]
        return {"outcome": "admitted", "dispatch": {"row_id": key, "session_id": effect["step"],
                "eventKey": effect["dispatchEvent"], "attempt": 1 if effect.get("retryOf") else 0}}
    def owner_status(self, receipt):
        return self.statuses.get(receipt["row_id"])


class PhaseDispatch(unittest.TestCase):
    def setUp(self):
        self.c = ctl.Controller.__new__(ctl.Controller)
        self.c.journal = ctl.Journal.__new__(ctl.Journal)
        self.c.journal.records, self.c.journal._obs = [], {}
        self.c.journal.append = lambda rec: self.c.journal._fold(rec)
        self.c.args = SimpleNamespace(run_root="/unused")
        self.c.effects = Effects()
        self.c.now = dt.datetime(2026, 9, 22, tzinfo=dt.timezone.utc)
        self.c.fire, self.c.live = "fire-one", True
        self.c.owner_cutover = {"enabled": True, "legacyRuns": []}
        self.c.owner_wakes, self.c.decisions, self.c.alarms = [], [], []
        self.c.decide = lambda *args, **kwargs: self.c.decisions.append((args, kwargs))
        self.c.ensure_alarm = lambda *args: self.c.alarms.append(args)
        self.c.record(RUN, "run", "claim", "claimed", detail={"pr": 7, "sha": "a" * 40})

    def status(self, step, state="settled", outcome="success"):
        self.c.effects.statuses[step + "/initial"] = {"status": "completed", "settlement": {
            "state": state, "outcome": outcome, "executionSettled": state == "settled"}}

    def test_quiet_duplicate_and_inflight_worker_never_wake_parent_or_dispatch_again(self):
        self.c.owner_step(RUN, "intake", "intake", False)
        self.status("intake", "busy")
        for _ in range(5):
            self.c.owner_step(RUN, "intake", "intake", False)
        self.assertEqual(len(self.c.effects.calls), 1)
        self.assertIsNone(self.c.pick_owner_wake())
        self.assertEqual(self.c.owner_wakes, [])

    def test_next_phase_waits_for_artifact_acceptance_and_execution_then_gets_new_context(self):
        self.c.owner_step(RUN, "intake", "intake", False)
        self.status("intake", "busy")
        self.assertNotEqual(self.c.owner_step(RUN, "intake", "intake", True), "done")
        self.status("intake")
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "done")
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.assertEqual([e["step"] for e in self.c.effects.calls], ["intake", "lanes"])
        self.assertFalse(any(e["type"] == "send" for e in self.c.effects.calls))

    def test_timeout_replays_same_event_and_never_treats_admission_as_ack(self):
        self.c.effects.unknown = True
        self.c.owner_step(RUN, "intake", "intake", False)
        self.c.effects.unknown = False
        self.c.owner_step(RUN, "intake", "intake", False)
        self.assertEqual([e["dispatchEvent"] for e in self.c.effects.calls], ["initial", "initial"])
        ob = self.c.obligations()[ctl.obligation_key(RUN, "owner", "intake")]
        self.assertEqual(ob["state"], "enqueued")
        self.assertNotIn("checkpoint", ob["detail"])

    def test_existing_campaign_stays_legacy_and_saved_route_survives_rollback(self):
        self.c.owner_cutover["legacyRuns"] = [RUN]
        self.c.owner_step(RUN, "intake", "intake", False)
        self.assertNotIn("dispatchEvent", self.c.effects.calls[0])
        self.assertEqual(self.c.pick_owner_wake()["runId"], RUN)
        self.c.owner_cutover = None
        self.assertEqual(self.c._owner_route(RUN), "legacy")

    def test_unlisted_but_preexisting_owner_cannot_be_migrated(self):
        self.c.record(RUN, "owner", "intake", "enqueued", detail={"outcome": "brief_written"})
        self.assertEqual(self.c._owner_route(RUN), "legacy")

    def test_missing_artifact_after_success_alarms_without_new_model(self):
        self.c.owner_step(RUN, "intake", "intake", False)
        self.status("intake")
        self.c.owner_step(RUN, "intake", "intake", False)
        self.assertEqual(len(self.c.effects.calls), 1)
        self.assertTrue(self.c.alarms)

    def test_provider_failure_recovers_same_phase_only_after_idle(self):
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.c.effects.statuses["lanes/initial"] = {"status": "completed", "settlement": {
            "state": "unknown", "outcome": "error", "executionSettled": True}}
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.assertEqual(self.c.effects.calls[-1]["retryOf"], "initial")
        self.assertEqual(self.c.effects.calls[-1]["dispatchEvent"], "recovery-1")
        self.assertEqual(self.c.effects.calls[-1]["step"], "lanes")


if __name__ == "__main__":
    unittest.main()
