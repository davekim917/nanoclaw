#!/usr/bin/env python3
"""Hermetic controller phase admission: no model, CLI, channel or gate calls."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
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
        self.assertEqual(self.c.effects.calls[-1]["dispatchEvent"], "initial-recovery-1")
        self.assertEqual(self.c.effects.calls[-1]["step"], "lanes")

    def test_changed_refusal_waits_for_worker_then_admits_new_event_in_same_phase(self):
        with tempfile.TemporaryDirectory() as root:
            self.c.args.run_root = root
            report = Path(root, RUN, "controller", "barrier-lanes.json")
            report.parent.mkdir(parents=True)
            report.write_text(json.dumps({"invalid": ["artifact.json"], "invalidReasons": ["missing evidence"]}))
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.status("lanes", "busy")
            self.c._reoffer_on_new_refusal(RUN, "lanes")
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(self.c.effects.calls), 1)
            self.status("lanes")
            self.c.owner_step(RUN, "lanes", "lanes", False)
            event = self.c.effects.calls[-1]
            self.assertEqual(event["step"], "lanes")
            self.assertTrue(event["dispatchEvent"].startswith("revision-"))
            self.assertIsNone(event["retryOf"])
            ob = self.c.obligations()[ctl.obligation_key(RUN, "owner", "lanes")]
            self.c.record(RUN, "owner", "lanes", "enqueued", detail={"briefedRefusal": ctl.refusal_digest(json.loads(report.read_text()))})
            for _ in range(3):
                self.c._reoffer_on_new_refusal(RUN, "lanes")
                self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(self.c.effects.calls), 2)
            self.assertEqual(ob["detail"]["dispatch"]["session_id"], "lanes")
            self.assertEqual(self.c.owner_wakes, [])

    def test_token_reissue_waits_for_worker_and_reaches_same_phase(self):
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.c.record(RUN, "owner", "lanes", "enqueued", detail={"briefedToken": "old-token"})
        self.c.record(RUN, "run", "claim", "claimed", detail={"ownerToken": "new-token"})
        self.c._reissue_owner_token(RUN, "new-token")
        self.status("lanes", "busy")
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.assertEqual(len(self.c.effects.calls), 1)
        self.status("lanes")
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.assertTrue(self.c.effects.calls[-1]["dispatchEvent"].startswith("revision-"))
        self.assertIsNone(self.c.effects.calls[-1]["retryOf"])

    def test_unresolved_new_event_admission_cannot_be_skipped_by_later_artifact_success(self):
        self.c.owner_step(RUN, "lanes", "lanes", False)
        self.status("lanes")
        self.c.record(RUN, "owner", "lanes", "intent", detail={
            "dispatchIntent": {"eventKey": "revision-pending", "retryOf": None, "prompt": "saved"}})
        self.assertEqual(self.c.owner_step(RUN, "lanes", "lanes", True), "enqueued")
        self.assertEqual(self.c.effects.calls[-1]["dispatchEvent"], "revision-pending")

    def test_real_effect_preserves_notes_token_and_ack_across_timeout_replay(self):
        with tempfile.TemporaryDirectory() as root:
            self.c.args.run_root = root
            run = Path(root, RUN)
            (run / "controller").mkdir(parents=True)
            barrier = run / "controller/barrier-lanes.json"
            barrier.write_text(json.dumps({"invalid": ["artifact.json"], "invalidReasons": ["broken"]}))
            claim = {"pr": 7, "sha": "a" * 40, "token": "new-token", "wake": {"coordinatorOwnerToken": "new-token"}}
            effect = ctl.EffectLayer.__new__(ctl.EffectLayer)
            effect.ctl, effect.ncl = self.c, ["fake-ncl"]
            effect._claim = lambda _: claim
            effect._run_dir = lambda _: str(run)
            commands = []
            effect._run = lambda argv, timeout: (commands.append(argv) or (None, "", "timeout"))
            self.c.record(RUN, "owner", "lanes", "intent", detail={"tokenReissued": True})
            request = {"runId": RUN, "step": "lanes", "dispatchEvent": "revision-test"}
            self.assertEqual(effect._owner_wake(request)["outcome"], "unknown")
            ack = run / "controller/brief-lanes.ack"
            ack.write_text("accepted after admission")
            claim["token"] = "later-token"
            barrier.write_text(json.dumps({"invalid": ["changed.json"]}))
            result = effect._owner_wake(request)
            self.assertEqual(result["outcome"], "unknown")
            self.assertEqual(commands[0], commands[1])
            self.assertTrue(ack.exists())
            prompt = commands[0][commands[0].index("--prompt") + 1]
            self.assertIn("YOUR OWNER TOKEN CHANGED", prompt)
            self.assertIn("THE BARRIER IS ALREADY REFUSING", prompt)
            self.assertEqual(json.loads((run / "controller/wake.json").read_text())["coordinatorOwnerToken"], "new-token")

    def test_real_phase_path_carries_new_diagnoses_once_without_replacing_busy_owner(self):
        with tempfile.TemporaryDirectory() as root:
            self.c.args.run_root = root
            run = Path(root, RUN)
            (run / "controller").mkdir(parents=True)
            barrier = run / "controller/barrier-lanes.json"
            barrier.write_text('{}')
            claim = {"pr": 7, "sha": "a" * 40, "token": "old-token", "wake": {"coordinatorOwnerToken": "old-token"}}
            effect = ctl.EffectLayer.__new__(ctl.EffectLayer)
            effect.ctl, effect.ncl, effect.mode, effect.performed = self.c, ["fake-ncl"], "live", []
            effect._claim = lambda _: claim
            effect._run_dir = lambda _: str(run)
            commands = []
            def dispatch(argv, timeout):
                commands.append(argv)
                event = argv[argv.index("--event-key") + 1]
                return 0, json.dumps({"ok": True, "data": {"admission": "inserted", "row_id": event,
                    "session_id": "same-phase", "attempt": 0}}), ""
            effect._run = dispatch
            current = {"status": "completed", "settlement": {"state": "busy", "executionSettled": False}}
            effect.owner_status = lambda _: current
            self.c.effects = effect
            self.c.owner_step(RUN, "lanes", "lanes", False)
            barrier.write_text(json.dumps({"invalid": ["artifact.json"], "invalidReasons": ["first refusal"]}))
            self.c._reoffer_on_new_refusal(RUN, "lanes")
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 1)
            current["settlement"] = {"state": "settled", "executionSettled": True, "outcome": "success"}
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 2)
            for _ in range(3):
                self.c._reoffer_on_new_refusal(RUN, "lanes")
                self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 2)
            barrier.write_text(json.dumps({"invalid": ["artifact.json"], "invalidReasons": ["different refusal"]}))
            self.c._reoffer_on_new_refusal(RUN, "lanes")
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 3)
            claim.update(token="new-token", wake={"coordinatorOwnerToken": "new-token"})
            self.c.record(RUN, "run", "claim", "claimed", detail={"ownerToken": "new-token"})
            self.c._reissue_owner_token(RUN, "new-token")
            current["settlement"] = {"state": "busy", "executionSettled": False}
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 3)
            self.assertEqual(json.loads((run / "controller/wake.json").read_text())["coordinatorOwnerToken"], "old-token")
            current["settlement"] = {"state": "settled", "executionSettled": True, "outcome": "success"}
            self.c.owner_step(RUN, "lanes", "lanes", False)
            self.assertEqual(len(commands), 4)
            self.assertIn("YOUR OWNER TOKEN CHANGED", commands[-1][commands[-1].index("--prompt") + 1])
            self.assertEqual(len({c[c.index("--event-key") + 1] for c in commands}), 4)
            self.assertEqual(len({c[c.index("--context-key") + 1] for c in commands}), 1)
            self.assertFalse(any("--retry-of" in c for c in commands))
            self.assertEqual(self.c.owner_wakes, [])


if __name__ == "__main__":
    unittest.main()
