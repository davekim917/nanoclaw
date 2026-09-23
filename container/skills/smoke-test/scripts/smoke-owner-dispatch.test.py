#!/usr/bin/env python3
"""Hermetic controller phase admission: no model, CLI, channel or gate calls."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("controller", Path(__file__).with_name("smoke-campaign-controller.py"))
ctl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ctl)
RUN = "xzo-pr-pr7-aaaaaaaaaaaa-20260918T100000Z"
HERE = Path(__file__).resolve().parent
NCL_TS = HERE.parents[3] / "container" / "agent-runner" / "src" / "cli" / "ncl.ts"


def ncl_json(doc):
    """Byte-for-byte what the real in-container `ncl --json` prints for one
    response frame (ncl.ts:286). NclFormat below proves it against node."""
    return json.dumps(dict({"id": "cli-test"}, **doc), indent=2, ensure_ascii=False) + "\n"


def node_stringify(doc):
    """The REAL formatter: node's JSON.stringify(doc, null, 2) + newline."""
    node = shutil.which("node")
    assert node, "node is required: it is the only authority on what ncl prints"
    return subprocess.run([node, "-e", "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]), null, 2) + '\\n')",
                           json.dumps(doc)], capture_output=True, text=True, check=True).stdout


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
                return 0, ncl_json({"ok": True, "data": {"admission": "inserted", "row_id": event,
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

    # pr2121 (2026-09-23): the host admitted the intake dispatch, but every
    # answer was the pretty-printed frame the controller could not parse, so
    # the obligation sat at `intent` replaying the same event, with no alarm.
    PR2121_REPLAY = {"ok": True, "data": {"admission": "replay", "row_id": "event-0000aaaa1111",
                     "series_id": "dispatch-0000bbbb2222", "session_id": "sess-0000000000000-test01",
                     "agent_group_id": "ag-00000000", "status": "completed", "attempt": 0}}
    SETTLED = {"ok": True, "data": {"status": "completed", "settlement": {
        "state": "settled", "outcome": "success", "executionSettled": True}}}

    def real_effects(self, answer):
        effect = ctl.EffectLayer.__new__(ctl.EffectLayer)
        effect.ctl, effect.ncl, effect.mode, effect.performed = self.c, ["fake-ncl"], "live", []
        effect.commands = []
        def run(argv, timeout):
            effect.commands.append(argv)
            return answer(argv)
        effect._run = run
        self.c.effects = effect
        return effect

    def stuck_intent(self):
        """The journal pr2121 was left with: an intake intent carrying the
        saved dispatch envelope, never recorded as enqueued. The route is
        recorded on the claim first, as _owner_route does in production."""
        self.assertEqual(self.c._owner_route(RUN), "phase-dispatch")
        self.c.record(RUN, "owner", "intake", "intent", 1)
        self.c.record(RUN, "owner", "intake", "intent", detail={"dispatchIntent": {
            "eventKey": "initial", "retryOf": None, "prompt": "saved intake prompt",
            "briefedToken": "tok", "briefedRefusal": "", "brief": "brief-intake.md"}})

    def test_pr2121_stuck_intent_recovers_on_replay_without_a_second_event(self):
        self.stuck_intent()
        t0 = self.c.now
        answers = {"dispatch": None, "get": ncl_json(self.SETTLED)}
        def answer(argv):
            if argv[1:3] == ["tasks", "dispatch"]:
                return (None, "", "timeout") if answers["dispatch"] is None else (0, answers["dispatch"], "")
            return 0, answers["get"], ""
        effect = self.real_effects(answer)
        unconfirmed = lambda: [a for a in self.c.alarms if a[1] == "controller_dispatch_unconfirmed"]
        # Unconfirmed, but not yet for long: replayed, not alarmed.
        self.c.now = t0 + dt.timedelta(minutes=10)
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "intent")
        self.assertEqual(unconfirmed(), [])
        # Past DISPATCH_UNCONFIRMED_ALARM_SECONDS: alarmed, under ONE fingerprint.
        for minutes in (31, 41):
            self.c.now = t0 + dt.timedelta(minutes=minutes)
            self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "intent")
        self.assertEqual(len({a[2] for a in unconfirmed()}), 1, unconfirmed())
        self.assertEqual(unconfirmed()[0][3]["eventKey"], "initial")
        # The host's real answer, as the real ncl prints it: admitted as a replay.
        answers["dispatch"] = ncl_json(self.PR2121_REPLAY)
        self.c.now = t0 + dt.timedelta(minutes=51)
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "enqueued")
        ob = self.c.obligations()[ctl.obligation_key(RUN, "owner", "intake")]
        self.assertEqual(ob["state"], "enqueued")
        self.assertEqual(ob["detail"]["dispatch"]["row_id"], "event-0000aaaa1111")
        self.assertIsNone(ob["detail"]["dispatchIntent"])
        # Next fire: the completed, settled owner row settles intake.
        self.c.now = t0 + dt.timedelta(minutes=61)
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "done")
        dispatches = [c for c in effect.commands if c[1:3] == ["tasks", "dispatch"]]
        self.assertEqual(len(dispatches), 4)  # three unconfirmed replays, one admitted
        self.assertEqual({c[c.index("--event-key") + 1] for c in dispatches}, {"initial"})
        self.assertFalse(any("--retry-of" in c for c in dispatches))
        self.assertEqual(sum(1 for c in effect.commands if c[1:3] == ["tasks", "get"]), 1)
        self.c.now = t0 + dt.timedelta(minutes=71)
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", True), "done")
        self.assertEqual(len([c for c in effect.commands if c[1:3] == ["tasks", "dispatch"]]), 4)

    def test_pretty_printed_admission_is_admitted_on_the_first_replay(self):
        self.stuck_intent()
        effect = self.real_effects(lambda argv: (0, node_stringify(dict({"id": "cli-1"}, **self.PR2121_REPLAY)), ""))
        self.assertEqual(self.c.owner_step(RUN, "intake", "intake", False), "enqueued")
        self.assertEqual(len(effect.commands), 1)
        self.assertEqual(self.c.alarms, [])


class NclFormat(unittest.TestCase):
    """The fakes must print what the real `ncl --json` prints, and the parser
    must read that. Every assertion here compares against node itself or
    ncl.ts's own source, never against another Python rendering."""

    def test_ncl_still_pretty_prints_its_frame(self):
        # If this fails, ncl's output changed: update ncl_json, the shared fake
        # (testdata/controller-live-fakes.py ncl_out), the inline fakes in
        # smoke-controller-live.test.sh and smoke-controller-shadow.test.sh, and
        # re-check last_json_line -- then this line.
        self.assertIn("process.stdout.write(JSON.stringify(resp, null, 2) + '\\n');", NCL_TS.read_text())

    def test_the_test_formatter_is_node_byte_for_byte(self):
        for doc in (PhaseDispatch.PR2121_REPLAY, PhaseDispatch.SETTLED,
                    {"ok": False, "error": {"message": "refusé \u2014 \"quoted\""}}, {"ok": True, "data": []}):
            self.assertEqual(ncl_json(doc), node_stringify(dict({"id": "cli-test"}, **doc)))

    def test_shared_fake_prints_what_ncl_prints(self):
        fakes = HERE / "testdata" / "controller-live-fakes.py"
        with tempfile.TemporaryDirectory() as state:
            env = dict(os.environ, FAKE_STATE=state)
            for argv in (["tasks", "create", "--name", "ctl-x", "--prompt", "p", "--json"],
                         ["tasks", "list", "--json"],
                         ["tasks", "dispatch", "--context-key", "smoke/r/intake", "--event-key", "initial",
                          "--prompt", "p", "--json"],
                         ["tasks", "get", "--id", "no-such-row", "--json"],
                         ["tasks", "nonsense", "--json"]):
                res = subprocess.run(["python3", str(fakes), "ncl"] + argv, env=env, capture_output=True, text=True)
                self.assertEqual(res.returncode, 0, (argv, res.stderr))  # --json never sets an exit code
                self.assertEqual(res.stdout, node_stringify(json.loads(res.stdout)), argv)

    def test_parser_reads_what_ncl_prints(self):
        frame = dict({"id": "cli-0000000000000-test01"}, **PhaseDispatch.PR2121_REPLAY)
        printed = node_stringify(frame)
        self.assertGreater(printed.count("\n"), 5)
        self.assertEqual(ctl.last_json_line(printed), frame)
        self.assertEqual(ctl.last_json_line("ncl: warning\n" + printed), frame)
        # The one-object-per-line shape the gate prints is unchanged.
        self.assertEqual(ctl.last_json_line('progress line\n{"ok": false}\n{"ok": true}\n'), {"ok": True})
        self.assertIsNone(ctl.last_json_line('{"ok": true}\n{"ok": tr'))
        self.assertIsNone(ctl.last_json_line(""))


if __name__ == "__main__":
    unittest.main()
