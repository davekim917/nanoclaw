## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id; thread-scoped loops are marked `[thread]`) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

### `scope`: where the task lives and reports

- **`scope: 'channel'` (default)** — durable. Runs in the channel-root session and posts to the channel root, surviving thread archival. Use for standing tasks (inbox pollers, daily briefings, anything that should outlive any one conversation).
- **`scope: 'thread'`** — an opt-in recurring **loop bound to the current thread**. It runs in this thread's session and reports **in this thread**, and it lives and dies with the thread. Use it when a user, talking to you *in a thread*, asks you to "run a loop" / "keep checking and report here" — e.g. "loop every 10 min until the PR is approved, report in this thread". When the loop's stop-condition is met, `cancel_task` it. From the channel root (not a thread) it falls back to `'channel'`.

When a request to "run a loop" comes from inside a thread and the intent is to watch something and report back **here**, prefer `scope: 'thread'` so iterations thread under the conversation instead of posting to the parent channel.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
