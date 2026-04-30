# mnemon-rearchitecture — follow-up items (post-ship)

> Captured 2026-04-30 before context compaction. The mnemon-rearchitecture is committed (`8ae875f`) and live in production across 11 agent groups. Three items deferred from the main PR are tracked here.

## Production state at handoff

- Latest commit: `8ae875f feat(memory): mnemon-rearchitecture` pushed to `davekim917/nanoclaw:main`
- Memory daemon: active (`systemctl is-active nanoclaw-memory-daemon`)
- Insights: 415+ across 11 groups (illysium has the bulk; others accumulating)
- Dead-letters: ~43 and draining (was 123 peak); zero poisoned
- processed_pairs: 199+; idempotency_keys: 1122+
- All 11 groups: `memory.enabled=true`, agentGroupId in container.json, mnemon store created, pending synth task scheduled
- Wiki synth first-fires already executed today for most groups (first staggered run); next daily cycle 03:03–03:53 local with per-group offsets
- Two groups (video-agent, xerus) reverted to default `0 3 * * *` cron when individually re-enabled — minor; can re-run `bulk-enable-memory.ts` to restore stagger

## Live test recipe

1. From Discord/Slack, send a memorable assertion to any memory-enabled agent: *"FYI my favorite hobby is rock climbing"*
2. Wait ~60s for the daemon sweep (host classifier turn-pair detection)
3. Verify the fact landed: `mnemon recall "hobby" --store <agent_group_id> --limit 3`
   - agent_group_id from `sqlite3 data/v2.db "SELECT id, folder FROM agent_groups WHERE folder='<name>'"`
4. In a fresh chat or after some delay: ask the agent *"what's my hobby?"* — recall context will be injected as a `[Recalled context]` system message before the user turn; agent should answer correctly without being told again
5. Check daemon health: `cat data/memory-health.json` (after first sweep flush) and `sqlite3 data/mnemon-ingest.db "SELECT COUNT(*) FROM processed_pairs"`

## Item 1 — Pocket REST capture (SMALLEST)

**Problem**: Pocket MCP (`mcp__pocket__get_pocket_conversation`) returns only transcript segments. The LLM-generated summary lives at Pocket's REST API: `/api/v1/public/recordings/{id}?include_summarizations=true&include_transcript=true`. The current memory layer captures the transcript but misses the summary.

**Backlog ID**: `bl-1777562569-pocket-mcp-notes` (central DB, main group)

**Decision** (architecture-advisor + Codex both confirmed): **Option B** — first-party wrapper script.

**Why B**:
- Cleaner agent UX than raw curl (architecture decision was: agents shouldn't know vendor REST URLs)
- Owns URL construction, retries, output formatting, schema-change resilience
- Bash hook captures the named command via existing regex pattern

**Implementation steps**:
1. Create `container/scripts/pocket-get-recording.sh`:
   ```bash
   #!/usr/bin/env bash
   # Wrapper for Pocket REST API. Auth handled by OneCLI proxy MITM
   # (Pocket secret host pattern = public.heypocketai.com, injection
   # = Authorization: Bearer {value}).
   set -euo pipefail
   recording_id="${1:?recording_id required}"
   curl -sS \
     "https://public.heypocketai.com/api/v1/public/recordings/${recording_id}?include_summarizations=true&include_transcript=true" \
     -H "Authorization: Bearer placeholder"
   ```
   Note: agent never has the real token. OneCLI proxy substitutes "placeholder" Bearer at the wire. Verified pattern via prior smoke test against api.anthropic.com.

2. Dockerfile (`container/Dockerfile`): add `COPY container/scripts/pocket-get-recording.sh /usr/local/bin/pocket-get-recording` and `RUN chmod +x /usr/local/bin/pocket-get-recording`. Place near other CLI installs (gws, mmdc, etc.).

3. Extend `container/agent-runner/src/mcp-tools/memory-capture.ts` Bash hook regex:
   ```typescript
   const POCKET_REST_RE = /\bpocket-get-recording\s+([a-zA-Z0-9_-]+)/;
   ```
   In `createMemoryCaptureBashHook`, after `GWS_CAPTURE_RE` check add a `POCKET_REST_RE` branch with `prefix: 'pocket-summary'`, hash on `recording_id + sha8(stdout)` (per Codex F-content-hash).

4. Update agent prompt context — when `pocket` MCP is mounted, instruct in `container/CLAUDE.md` or via the relevant skill: *"For full Pocket recording content (transcript + AI summary), use `pocket-get-recording <id>`. The MCP `mcp__pocket__get_pocket_conversation` returns transcript only."*

5. Tests: extend `memory-capture.test.ts` with a Bash hook test for the new pattern (mirror the gws test).

6. Update backlog item to status=resolved when shipped.

**Codex caveats from earlier review**:
- Output ordering: ensure summary fields appear BEFORE transcript fields in the response so the 50KB byte cap doesn't truncate the high-value content
- Test that `pocket-get-recording <id> --dry-run` is skipped (mirror gws DRY_RUN_RE)
- Hash should be on `recording_id + sha8(stdout)`, NOT just on the command (so the same recording fetched after a summary update produces a new file — see Item 2 for the broader pattern)

**Estimated**: 30-60 min including container rebuild + tests.

---

## Item 2 — Content-aware capture (BIGGEST — was Codex's recommended PR-2)

**Problem**: `MCP_CAPTURE_TOOLS[].hashOf(input, output)` currently hashes only on the request shape (issue ID, URL, meeting ID). If a Linear issue gets new comments, re-fetching captures the same hash → file already exists → write skipped → mnemon misses the new content. Stale facts fail silently at recall time.

**Codex's recommendation** (verbatim from the LLM-engineer perspective consultation):

> "Move away from input-hashed idempotence. Keep resource identity, but make observations versioned by content. The real invariant should be 'don't classify identical payloads twice', not 'don't ever revisit the same resource.'"

> "Use a compound identity: `source_type / resource_id / content_sha / fetched_at`. Also keep a manifest: `resource_id -> latest_content_sha, latest_fetched_at`. Then: (1) if the stable response hash is identical, skip classification; (2) if it changed, persist a new snapshot and classify."

**Implementation steps**:

1. Update `hashOf` signatures in `container/agent-runner/src/mcp-tools/memory-capture.ts`. Most entries currently ignore `output`. Change each to:
   ```typescript
   hashOf: (input, output) => {
     const id = /* extract resource id from input */;
     const contentSha = sha8(stableSerialize(output));
     return `${id}|${contentSha}`;
   }
   ```
   Affected entries (all of `MCP_CAPTURE_TOOLS`):
   - `mcp__granola__get_meeting` — id from input, content sha from output
   - `mcp__pocket__get_pocket_conversation` — recording_id + content sha
   - `mcp__linear__get_issue` — issue id + content sha (most important — issues mutate often)
   - `mcp__github__get_pr` — owner/repo/pull_number + content sha
   - All 7 `mcp__exa__*` — query/url + content sha (for crawl/search results)

2. Update `createMemoryCaptureWebFetchHook` similarly: hash on `url + sha8(content)`, not just url.

3. Update `createMemoryCaptureBashHook` (gws + pocket-rest): hash on `command_normalized + sha8(stdout)`.

4. Add a test category: `test_content_aware_dedup` — same input, same output → same file (idempotent skip); same input, different output → new file (re-classification fires).

5. **NOT changing**: mnemon's insight schema. The graph already dedupes identical fact content via its own deterministic id derivation. Provenance fields (observed_at, source_id, content_sha) would require schema migration in mnemon — out of scope for our wrapper. We rely on mnemon's existing dedup + the inbox's per-file timestamp.

6. **Cost analysis** (sanity check before shipping):
   - Re-classification cost: Haiku 4.5 ≈ $0.005-0.01 per call. With prompt caching on the system prompt, ~80% of input tokens are cached. Realistically: 100-500 re-classifications/group/month → $1-5/month worst case at the entire fleet level. Not the binding constraint.
   - Disk: inbox files dated under `processed/<date>/`. With re-fetches typical of active work (~2-5 per artifact per week), processed/ grows ~50-200 files/group/week. Manageable; archive cleanup is a separate hygiene task.
   - Recall improvement: catches comment additions, status changes, edited issue descriptions, decision revisions, new attendees, evolved meeting notes. The single biggest value-add for the memory layer.

**Codex caveat from earlier review (don't lose this)**:
> "The chat-capture mitigation [user's argument that chat captures comments anyway] helps, but I would not rely on it. Slack/Discord is conversational evidence, not the source of truth. It will miss label changes, status transitions, edited issue descriptions, final decisions recorded only in Linear/Granola, and cases where the user never discusses the update in chat. Worse, it creates asymmetric memory: the assistant remembers what was talked about, not what is true."

**Estimated**: 60-90 min including tests + careful per-tool hashOf logic.

---

## Item 3 — Per-group sweep parallelization (drain throughput)

**Problem**: `runSweep` in `src/memory-daemon/index.ts` iterates `enabledGroups` sequentially. Each group's `runChatStreamSweep([group], store, health)` blocks on Haiku API calls (~1-2s each). High-volume groups starve other groups during the same sweep window.

**Observed during bulk-enable**: illysium had ~80 historical pairs to classify on first sweep; took ~10 minutes (multiple sweep cycles) to drain. During that drain, the OTHER 10 groups got proportionally less daemon attention.

**Fix**: Parallelize the per-group iteration with a concurrency cap.

**Implementation**:

1. In `src/memory-daemon/index.ts`, replace:
   ```typescript
   for (const group of enabledGroups) {
     await runChatStreamSweep([group], store, health);
   }
   ```
   With a bounded-parallelism version. Inline semaphore (no new dep) — cap=3 concurrent groups (prevents Haiku rate burst):
   ```typescript
   const CONCURRENCY = 3;
   async function runWithLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
     const queue = [...items];
     const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
       while (queue.length > 0) {
         const item = queue.shift();
         if (item) await fn(item);
       }
     });
     await Promise.all(workers);
   }
   await runWithLimit(enabledGroups, CONCURRENCY, (g) => runChatStreamSweep([g], store, health));
   ```

2. Same pattern for the dead-letter retry loop further down in the same function.

3. **Concurrency cap rationale**: 3 groups × ~1-3 concurrent Haiku calls each = up to 9 simultaneous classifier requests. At Haiku's typical concurrency limit (Anthropic's per-org TPS varies but 9 should be safely under for most accounts), this is defensible. If we see throttling, drop to 2.

4. **Tests**: 
   - Mock `runChatStreamSweep` to track concurrent execution count; assert max concurrent ≤ CONCURRENCY
   - Assert order doesn't matter — works regardless of iteration order
   - Verify ingest DB writes don't conflict (better-sqlite3 has internal locking; should be a no-op test but worth asserting)

**Caveats**:
- The mnemon CLI is a subprocess spawn per `remember` call. With 9 concurrent classifications, we'd have up to 9 concurrent mnemon spawns. Each is short-lived (~50-200ms) but processes pile up briefly. Consider per-store mnemon-CLI lock if we see issues.
- Each Haiku call is async; promise interleaving fine.
- The undici ProxyAgent in anthropic-client.ts is module-level (one instance for all calls). Already concurrent-safe.

**Estimated**: 20-30 min.

---

## Sequencing recommendation

In order from simplest to riskiest:

1. **Item 3 (parallelization)** first — surgical, observable improvement, low risk, no schema changes
2. **Item 1 (Pocket REST)** second — small isolated addition, verifiable end-to-end via container rebuild + smoke test
3. **Item 2 (content-aware)** last — biggest behavior change, needs comprehensive testing for re-fetch dedup edge cases

Each can be its own commit. Or one combined "feat(memory-daemon): post-soak improvements" commit if they ship together.

After all three: run `pnpm test`, `cd container/agent-runner && bun test`, `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, `pnpm run build`. Push to main.

## Item 4 (live-discovered): mnemon recall timeout budget too tight (FIXED 2026-04-30)

**Symptom:** Host-side passive recall (`maybeInjectRecall`) returned 0 facts in production for nearly every Discord/Slack inbound, despite mnemon CLI returning 10+ results when invoked manually with the same query+store.

**Root cause:** Spec C5 budgeted `recall p50 ≤ 750ms warm; hard 1500ms` based on embed-only benchmark (Ollama nomic-embed-text 60-216ms warm). Actual mnemon CLI runtime on the host:
- 28-char query: ~1.1s (CLI spawn + DB open + graph traversal dominate)
- 800-char query: ~1.7-1.85s (embed scales with input length)

Both routinely cross 1500ms under load (live test: 28-char Discord query took 1620ms and got killed mid-flight). The AbortController fired SIGTERM, the spawn promise resolved with empty stdout + code 1, and `mnemon-impl.ts:recall` returned `empty()` per fail-open semantics. This was correct behavior given the budget — the budget was just wrong.

**Fix shipped:**
- `src/modules/memory/mnemon-impl.ts:43` — `DEFAULT_TIMEOUT_MS` 1500 → 3000
- `src/modules/memory/recall-injection.ts:254` — explicit override 1500 → 3000
- `src/modules/memory/recall-injection.ts` — added `log.info` at entry, each early return, before/after `store.recall`, and after row insert (so future regressions are diagnosable from logs without code changes)

**Spec deviation:** Spec C5 says "hard 1500ms" — that constraint is now violated. Update C5 in `design.md` and `plan.md` to "hard 3000ms" with the empirical rationale, OR ship a follow-up that brings real latency back under 1500ms (mnemon-as-daemon — eliminates CLI spawn cost; ~700ms savings would put short queries comfortably under budget). Daemon-mode is the right long-term fix; the timeout bump is the right short-term fix.

**Verification:** After 21:13:54 UTC restart, look for `recall-injection: row inserted` log lines with `factCount > 0` for chat-sdk inbound messages. **VERIFIED at 21:52:00 UTC** — Discord test thread `1499528766513352724` returned 10 facts in 1666ms; row inserted at seq=2, user message at seq=4, both completed in agent reply.

## Item 5 (live-discovered): Ollama embedding model unloads after 5 min idle (FIXED 2026-04-30)

**Symptom:** First recall after a quiet period took 3+ seconds and timed out, even with the 3000ms cap. Subsequent recalls were fast.

**Root cause:** Ollama's default `OLLAMA_KEEP_ALIVE` is 5 minutes. After idle, nomic-embed-text-v1.5 (565MB) unloads. The next embed request triggers a cold model reload — observed in `journalctl -u ollama` as: `starting runner` → `loading model` → `waiting for llama runner to start responding` → ~3s wall time. With Ollama warm, the embed call alone is **~57ms** (matches design.md C5 expectation of "60-216ms warm"). With it cold, the embed is the bulk of mnemon's latency.

**Fix shipped:** Systemd drop-in pinning the model permanently:
```
/etc/systemd/system/ollama.service.d/keep-alive.conf
[Service]
Environment="OLLAMA_KEEP_ALIVE=-1"
```

After `systemctl daemon-reload && systemctl restart ollama`, an explicit warmup `curl /api/embeddings` ensures the model is loaded immediately. `/api/ps` confirms `expires_at: 2318-08-10` (Ollama's "never" sentinel). The 565MB pinned RAM is trivial on the 23GB host.

**Note:** Mnemon currently only supports Ollama as an embedding backend (`internal/embed/ollama.go` is the only embed source). If mnemon ever ships an OpenAI/Voyage adapter, this concern moves to "managing API costs vs. local RAM tradeoff" rather than "managing cold-start latency."

## Item 6 (live-discovered): Absolute-ceiling container sweep starves recall budget

**Symptom:** A user @mention at 17:30:35 EDT crossed the 3000ms timeout (returned 0 facts, latencyMs=3003) despite Ollama being warm. Solo `mnemon recall` for the same query takes ~1.1s.

**Root cause:** The host's "absolute-ceiling" container lifecycle policy was killing 9+ stale (8-day-old) containers in a 9-second window. Each `docker stop` blocks the host briefly for forced shutdown. The user's recall fired exactly mid-sweep — host CPU/IO was saturated by parallel `docker stop` syscalls, mnemon CLI fork+exec inflated from ~50ms to seconds, and the recall blew the budget.

**Why this is a follow-up, not a blocker:** This was a one-off — the 8-day cohort all hit ceiling simultaneously, won't repeat for ~8 days. The next test 22 minutes later (21:52:00 UTC) ran clean: 1666ms latency, 10 facts.

**Recommended fix:** Pace the sweep — kill at most N (e.g. 2-3) containers per second instead of bursting through them in parallel. Or run the sweep on a separate worker so it doesn't compete with the request hot path. Search `Killing container` + `reason="absolute-ceiling"` in `src/host-sweep.ts` for the loop.

## Other latent items observed but NOT blocking

- video-agent + xerus have synth cron `0 3 * * *` instead of staggered values (43 / 48 minute) — re-run `pnpm exec tsx scripts/bulk-enable-memory.ts` to reconcile (script is idempotent and applies the staggered cron via `synthCronForIndex(i)`)
- 17+ orphan mnemon stores from dev/test runs (timestamps 1777570*) take up disk; manual cleanup with `mnemon store delete <id>` if the operator cares
- The earlier installed system cron at `23 9 7 5 *` (May 7 9:23am) for `scripts/memory-soak-check.sh` is still scheduled — runs as a 1-week post-deploy soak check; outputs to `logs/memory-soak.log` and can DM via `MEMORY_SOAK_DISCORD_WEBHOOK` env var if anomalies. No action needed; will fire automatically.

## Files most relevant for the three items

- `container/agent-runner/src/mcp-tools/memory-capture.ts` — main surface for items 1 + 2
- `container/agent-runner/src/mcp-tools/memory-capture.test.ts` — test file for both
- `container/Dockerfile` — pocket-get-recording COPY + chmod (item 1)
- `container/scripts/pocket-get-recording.sh` — new wrapper file (item 1)
- `container/CLAUDE.md` — agent guidance update (item 1)
- `src/memory-daemon/index.ts` — sweepLoop parallelization (item 3)
- `src/memory-daemon/index.test.ts` — concurrency tests (item 3, may need to create)

After ship: update `docs/specs/mnemon-rearchitecture/qa-report.md` to mark all three items resolved, close `bl-1777562569-pocket-mcp-notes` backlog item.
