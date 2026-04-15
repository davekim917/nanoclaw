---
name: task-scripts
description: How to use pre-check scripts with scheduled tasks to reduce unnecessary agent invocations. Use when scheduling recurring tasks, setting up cron jobs, or when the user wants a task that checks a condition before waking the agent. Also use when advising on task frequency or API credit usage.
---

# Task Scripts

When scheduling a recurring task, consider whether a simple script can determine if the agent actually needs to wake up. Scripts run before the agent, check a condition, and only invoke the agent when action is needed. This saves API credits and avoids rate limits.

## How it works

1. Provide a bash `script` alongside the `prompt` when calling `schedule_task`
2. The script runs first on each trigger (30-second timeout)
3. Script prints JSON to stdout: `{ "wakeAgent": true/false, "data": {...} }`
4. `wakeAgent: false` — nothing happens, task waits for next run
5. `wakeAgent: true` — agent wakes up and receives the script's data + prompt

## Always test first

Run the script in your sandbox before scheduling:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

## When NOT to use scripts

Tasks that require judgment every time (daily briefings, reminders, reports) don't need a pre-check — just use a regular prompt.

## Frequency guidance

For tasks running more than ~2x daily where a script can't reduce wake-ups: explain the API credit cost, suggest restructuring with a condition check, and help find the minimum viable frequency.
