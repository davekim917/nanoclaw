#!/usr/bin/env python3
"""Offer the existing cause/day alarm once, through durable scoped task admission."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


def admit(payload, config, request):
    data = payload.get("data", {})
    if not config.get("failureDispatch", config.get("enabled", False)) or not data.get("failure"):
        return payload
    alarm = dict(data.get("alarm") or {})
    alarm_id = alarm.get("id", "")
    if not re.fullmatch(r"ctl\.failure\.[A-Za-z0-9._:-]{1,64}\.(\d{8})#1", alarm_id):
        raise ValueError("failure alarm identity invalid")
    day = alarm_id.rsplit(".", 1)[1][:8]
    # Existing public identity/text already mean cause/day. Normalize only the
    # audit fire timestamp so a replay has the same immutable prompt bytes.
    alarm["fire"] = "{}-{}-{}T00:00:00Z".format(day[:4], day[4:6], day[6:8])
    prompt = ("A smoke controller fire failed closed. This task owns only the existing operator alarm. "
              "Read the 'A failure wake' section of /app/skills/smoke-test/references/controller-owner-router.md. "
              "Post exactly its supplied alarm through the existing enqueue-send path; if to is null, resolve the "
              "campaign destination as that router instructs. Never source the gate env file, take campaign work, "
              "run gate verbs, create QA workers, change source, or publish a campaign verdict. The existing alarm "
              "ID/text preserve public deduplication. Record admission or failure and stop.\nAlarm:\n" +
              json.dumps(alarm, sort_keys=True, separators=(",", ":")))
    event, previous = "alarm", None
    for attempt in range(3):
        argv = ["tasks", "dispatch", "--context-key", "smoke/failure/" + alarm_id,
                "--event-key", event, "--prompt", prompt, "--isolated", "--quiet-status", "--json"]
        if previous: argv += ["--retry-of", previous]
        result = request(argv)
        if result.get("admission") not in ("inserted", "replay") or not result.get("row_id"):
            raise ValueError("failure alarm admission not proven")
        if result.get("status") not in ("failed", "expired", "completed"):
            break
        status = request(["tasks", "get", "--id", result["row_id"], "--session", result["session_id"], "--settlement", "--json"])
        settlement = status.get("settlement", {})
        failed = status.get("status") in ("failed", "expired") or settlement.get("outcome") == "error"
        if not failed or settlement.get("executionSettled") is not True:
            break
        if attempt == 2: raise ValueError("failure alarm recovery exhausted; existing script escalation applies")
        previous, event = event, "recovery-{}".format(attempt + 1)
    return {"wakeAgent": False, "data": {**data, "failureDispatch": result}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cutover", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.cutover).read_text())
    payload = json.load(sys.stdin)
    def request(argv):
        result = subprocess.run(["ncl"] + argv, text=True, capture_output=True, timeout=4, check=True)
        doc = json.loads(result.stdout)
        if doc.get("ok") is not True:
            raise ValueError("failure alarm dispatch refused")
        return doc.get("data") or {}
    print(json.dumps(admit(payload, config, request), separators=(",", ":")))


if __name__ == "__main__":
    main()
