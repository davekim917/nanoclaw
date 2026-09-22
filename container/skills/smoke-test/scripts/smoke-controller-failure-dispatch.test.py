#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("failure", Path(__file__).with_name("smoke-controller-failure-dispatch.py"))
failure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(failure)


class FailureDispatch(unittest.TestCase):
    def payload(self, cause="fire-killed", at="2026-09-22T12:00:00Z"):
        return {"wakeAgent": True, "data": {"failure": cause, "fire": at, "detail": at,
                "alarm": {"id": "ctl.failure.{}.20260922#1".format(cause), "to": None,
                          "fire": at, "text": "Existing stable cause alarm " + cause}}}

    def test_same_cause_day_replays_quietly_but_new_cause_has_new_identity(self):
        events = {}
        def request(args):
            key, prompt = args[args.index("--context-key") + 1], args[args.index("--prompt") + 1]
            if key in events:
                self.assertEqual(events[key], prompt)
                return {"admission": "replay", "row_id": key}
            events[key] = prompt
            self.assertNotIn("--model", args)
            self.assertNotIn("--effort", args)
            return {"admission": "inserted", "row_id": key}
        for payload in [self.payload(), self.payload(at="2026-09-22T12:10:00Z"), self.payload("step-error")]:
            result = failure.admit(payload, {"enabled": True}, request)
            self.assertFalse(result["wakeAgent"])
        self.assertEqual(len(events), 2)

    def test_unproven_admission_fails_into_existing_backoff_without_parent_wake(self):
        with self.assertRaises(ValueError):
            failure.admit(self.payload(), {"enabled": True}, lambda args: {})

    def test_terminal_failure_recovers_in_same_context_with_bounded_event_chain(self):
        calls = []
        def request(args):
            calls.append(args)
            if args[1] == 'get':
                return {'status': 'completed', 'settlement': {'executionSettled': True, 'outcome': 'error'}}
            event = args[args.index('--event-key') + 1]
            return {'admission': 'replay' if event == 'alarm' else 'inserted', 'row_id': event,
                    'session_id': 'same-phase', 'status': 'completed' if event == 'alarm' else 'pending'}
        result = failure.admit(self.payload(), {'enabled': True}, request)
        self.assertFalse(result['wakeAgent'])
        self.assertIn('--retry-of', calls[-1])
        self.assertEqual(calls[-1][calls[-1].index('--event-key') + 1], 'recovery-1')

    def test_disabled_and_nonfailure_paths_remain_legacy(self):
        def forbidden(args):
            self.fail("unexpected CLI admission")
        payload = self.payload()
        self.assertEqual(failure.admit(payload, {"enabled": False}, forbidden), payload)
        quiet = {"wakeAgent": False, "data": {}}
        self.assertEqual(failure.admit(quiet, {"enabled": True}, forbidden), quiet)


if __name__ == "__main__":
    unittest.main()
