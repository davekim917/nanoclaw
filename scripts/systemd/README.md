# Design-loop drift-check timer

Monthly check for drift between our vendored Open Design assets / ported technique and
upstream `nexu-io/open-design`. See `scripts/check-design-drift.sh` for what it does.

It notifies only when something is actionable (vendored data changed, new systems
available, or the LLM technique review flags genuine drift) — otherwise it's silent.
The report is posted to the Discord **#axie-dev** channel (where the operator's other
drift checks report), via the CLI-socket inbound transport. That transport wakes the
channel's Claude agent to relay the report, so the injected text is framed relay-only
(advisory — the agent is told not to auto-implement the recommendations).

## Install (host, system systemd — matches the OneCLI drift timer)

```bash
sudo cp scripts/systemd/design-drift-check.service /etc/systemd/system/
sudo cp scripts/systemd/design-drift-check.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now design-drift-check.timer
systemctl list-timers | grep design-drift   # confirm scheduled
```

## Manual run / preview

```bash
bash scripts/check-design-drift.sh --dry-run   # compose + print, no DM, no state write
bash scripts/check-design-drift.sh             # real run (DM only if drift)
journalctl -u design-drift-check.service --no-pager   # last run logs
```

State (`data/design-drift-last-check`, an ISO date) scopes the LLM's commit/changelog
review window and advances on every successful run.
