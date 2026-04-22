# Spike Notes

Findings from pre-flight uncertainty-reduction spikes. Logged before Phase 2 formally starts so insights aren't lost.

## Empirical Questions Answered

### Q11: `claude` CLI on host
**Answer:** Present at `/home/ubuntu/.local/bin/claude` on current host.
**Implication:** CLI shell-out works, but we're switching to direct Anthropic SDK anyway (cleaner).

### Q6: Are v2 container mounts read-only?
**Answer:** NO. From `src/container-runner.ts:182-202`:
- `/workspace` → `readonly: false`
- `/workspace/agent` → `readonly: false`
- `/home/node/.claude` → `readonly: false`
- `/app/src` → `readonly: false`
- Only `/workspace/global` is `readonly: true`

**Implication:** Phase 2.7 (IPC git handlers) is likely skippable. Agents can make git writes to mounted directories. Confirm via Phase 3 test with `git commit` inside a container.

### Anthropic SDK availability
**Finding:** v2 host `package.json` does NOT have `@anthropic-ai/sdk`. Agent-runner has `@anthropic-ai/claude-agent-sdk` but host has no direct Anthropic dep.
**Action:** Add `@anthropic-ai/sdk` to host `package.json` during Phase 2.5 port. Used by `src/llm.ts` for Haiku calls (memory extraction, thread titles, future topic classification).

## Spike 2.5: Memory Extraction Foundations

**Status:** Code authored on `dave/migration`, pending `npm install` verification.

**Files created:**
- `src/db/migrations/009-memories.ts` — schema migration
- `src/db/memories.ts` — CRUD (insert, get, list, count, delete, update, search, recent)
- `src/memory-store.ts` — higher-level save/update/delete + `getRelevantMemories` + XML formatter
- `src/llm.ts` — Anthropic SDK-based Haiku caller
- `src/memory-extractor.ts` — full extractor ported with `ConversationMessage` abstraction
- `src/types.ts` — added `Memory` and `MemoryType`
- `src/db/migrations/index.ts` — registered migration009

**Design decisions made:**
1. **Scope key: `agent_group_id`** (not `group_folder`) — fits v2 entity model
2. **Throttle/in-flight key: `sessionId`** (not `chatJid`) — each session is an independent throttle
3. **Abstracted input:** `ConversationMessage { role, senderName, content }` — callers adapt from `MessageIn`/`MessageOut` when invoking
4. **Phase A skips embeddings** — keyword search only, sqlite-vec optional in Phase C
5. **Memory table in central `v2.db`** — not per-session — memories persist across session restarts
6. **SDK over CLI** — `src/llm.ts` uses `@anthropic-ai/sdk` directly with `claude-haiku-4-5-20251001`

**Still TODO in actual Phase 2.5 port (not spike scope):**
- Wire `extractMemoriesAsync` into `src/delivery.ts` after chat-kind message delivery
- Add 60s interval timer in `src/host-sweep.ts` (or dedicated module) per active session
- Build a "gather recent messages" helper that reads from session's `inbound.db` + `outbound.db` and produces `ConversationMessage[]`
- Inject memories into agent context — likely via `container/agent-runner/src/formatter.ts`, reading memories from a projection in the session's `inbound.db` (similar to how `writeDestinations` projects agent destinations)
- `prompts/memory-extraction.md` tunable template (optional; default prompt works)
- Tests

## Spike 2.4: Progress Update Wiring

**v2's Claude provider already emits semantic progress events:**

File `container/agent-runner/src/providers/claude.ts:249-252`:
```typescript
} else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
  const tn = message as { summary?: string };
  yield { type: 'progress', message: tn.summary || 'Task notification' };
}
```

File `container/agent-runner/src/poll-loop.ts:305-315` — `handleEvent`:
```typescript
function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':    log(`Session: ${event.continuation}`); break;
    case 'result':  log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`); break;
    case 'error':   log(`Error: ${event.message} (retryable: ${event.retryable}...)`); break;
    case 'progress': log(`Progress: ${event.message}`); break;
  }
}
```

**The port is minimal:** add `writeMessageOut` call in the `progress` case.

**Container-side change (~5 lines):**
```typescript
case 'progress':
  log(`Progress: ${event.message}`);
  writeMessageOut({
    id: generateId(),
    kind: 'status',
    content: JSON.stringify({ text: event.message }),
  });
  break;
```

**Host-side change needed (`src/delivery.ts`):**
- In `deliverMessage` (or `deliverSessionMessages`), add a case for `content.kind === 'status'` (or check the message_out row's `kind` column equals `'status'`)
- Per-session `statusTracking` map: `Map<sessionId, platformMessageId>`
- First status for session → `adapter.deliver()` (sendMessage) → save returned `platform_message_id`
- Subsequent status → `adapter.deliver()` with `operation: 'edit', messageId: savedId`
- On regular chat-kind delivery → clear statusTracking for session

**Uncertainty remaining:**
- Do `task_notification` events fire often enough to be useful? (Q9)
- Is there a way to derive sender/thread context for status message destination from the kind:'status' row? YES — `messages_out` rows have `platform_id/channel_type/thread_id` columns already (set by container when writing).

**NOT written as actual code yet** — this is a sketch. Actual implementation lands in Phase 2.4.

## Spike 2.1: SDK Model Drift Detection

**Finding:** More complex than first scoped. v2's `ProviderEvent` types don't surface per-turn model usage:

```typescript
export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

v1's drift detection works by inspecting `modelsUsedThisTurn` from SDK system messages. To port to v2, we'd need to:
1. Extend `ProviderEvent` with a `model_used` variant (or fold into `result`/`activity` metadata)
2. Inspect SDK messages for a `model` field (assistant messages have this)
3. Track per-turn in `ClaudeProvider.query`'s `translateEvents` generator
4. Recovery logic: `setModel()` on the next turn + env var update

**Additional complication:** v2 doesn't set `CLAUDE_CODE_USE_MODEL` as prominently. Need to verify whether v2 uses that env var or configures the model through a different path.

**Recommendation:** Keep 2.1 as a Phase 2 task, but expect it to require a small provider API extension (new event type or metadata). Not a 10-line change.

**Port order adjustment:** Do 2.1 AFTER 2.4 (which doesn't require extending the event type). 2.4 proves the `handleEvent → writeMessageOut` path; 2.1 then extends the provider event types and follows the same delivery path for recovery notices.

## Open Questions (Updated After Spikes)

- **Q1 (OneCLI 429):** Still empirical, test during Phase 2.3.
- **Q6 (git commits):** Partially answered — mounts aren't read-only. Needs Phase 3 test to confirm Claude Code can commit inside containers.
- **Q11 (claude CLI):** Answered — available on host but we're switching to SDK anyway.
- **Q9 (task_notification frequency):** Still empirical, verify during Phase 3.
- **NEW Q13: Does v2 use `CLAUDE_CODE_USE_MODEL` env var?** Affects 2.1 drift detection port. Check before Phase 2.1.

## Confidence Summary After Pre-Flight

| Phase 2 item | Pre-flight outcome | Confidence |
|--------------|---------------------|------------|
| 2.1 Model drift | Sketched; more complex than scoped; requires provider event extension | Medium |
| 2.2 Secret scrubbing | Not spiked; straightforward port of `scrubSecrets` | High |
| 2.3 API key rotation | Gated on Q1 empirical test | Unknown |
| 2.4 Progress updates | Insertion points identified exactly; host + container changes sketched | High |
| 2.5 Memory extraction | Full skeleton authored; integration TODO clear | High |
| 2.6 Attachment downloader | Not spiked; mostly forward-port of v1 module | Medium |
| 2.7 IPC git handlers | Likely skippable (mounts RW); confirm Phase 3 | High (skip likely) |
| 2.8 Auto-dream | Not spiked; small SDK option change | Medium |
