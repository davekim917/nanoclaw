# formatting (test-only) : v1 vs v2

## Scope

- **v1**: `/Users/gavriel/nanoclaw4/src/v1/formatting.test.ts` (316 lines)
- **v1 production sibling**: `/Users/gavriel/nanoclaw4/src/v1/router.ts` (43 lines) — `escapeXml()`, `formatMessages()`, `stripInternalTags()`, `formatOutbound()`, plus `/Users/gavriel/nanoclaw4/src/v1/config.ts` (63 lines) — `getTriggerPattern()`, `TRIGGER_PATTERN`, `buildTriggerPattern()`, `DEFAULT_TRIGGER`
- **v2 counterparts**: 
  - Inbound message formatting: `/Users/gavriel/nanoclaw4/container/agent-runner/src/formatter.ts` (228 lines) — `formatMessages()`, `categorizeMessage()`, `extractRouting()`
  - Outbound tag stripping: embedded in container delivery logic
  - Trigger patterns: moved to DB model (`messaging_group_agents.trigger_rules` JSON) — no code-level function
  - v2 tests: `/Users/gavriel/nanoclaw4/container/agent-runner/src/poll-loop.test.ts:26–84` (formatter section only)

---

## Test-case map

| v1 Test Case | v2 Formatter Handling | Status | Notes |
|---|---|---|---|
| **escapeXml: ampersands** (src/v1/formatting.test.ts:22–23) | `/container/agent-runner/src/formatter.ts:225` `escapeXml()` with `&` → `&amp;` | ✅ Preserved | Both use identical regex replacement. V2 escaping is used in `formatSingleChat()` for sender, time, text. |
| **escapeXml: less-than** (test:26–27) | `formatter.ts:225` `escapeXml()` with `<` → `&lt;` | ✅ Preserved | Used in XML attributes and content. |
| **escapeXml: greater-than** (test:30–31) | `formatter.ts:225` with `>` → `&gt;` | ✅ Preserved | Same. |
| **escapeXml: double quotes** (test:34–35) | `formatter.ts:225` with `"` → `&quot;` | ✅ Preserved | Same. |
| **escapeXml: multiple special characters** (test:38–39) | `formatter.ts:225` (regex composition) | ✅ Preserved | Single pass through all four replacements. |
| **escapeXml: passthrough clean text** (test:42–43) | `formatter.ts:225` (no-op if no specials) | ✅ Preserved | Same. |
| **escapeXml: empty string** (test:46–47) | `formatter.ts:225` (no-op on empty) | ✅ Preserved | Same. |
| **formatMessages: single message with context header & time** (test:56–62) | `/container/agent-runner/src/formatter.ts:124–158` `formatChatMessages()` & `formatSingleChat()` | ⚠️ Changed | v1 formats as `<context timezone="UTC" />\n<messages>...\n</messages>` with full timestamp in US locale. v2 uses `<message id="seq" from="dest-name" sender="..." time="HH:MM">...` with 24-hour time only. No context header. |
| **formatMessages: multiple messages** (test:64–84) | `formatter.ts:124–134` (batch wrapping in `<messages>` tag) | ⚠️ Changed | v2 wraps multiple chat messages in `<messages>` tags but structure differs: no timezone attribute, different time format, `from` attribute added. |
| **formatMessages: escape sender names** (test:86–88) | `formatter.ts:157` `sender="${escapeXml(sender)}"` | ✅ Preserved | Same escaping strategy. |
| **formatMessages: escape content** (test:91–93) | `formatter.ts:157` `${escapeXml(text)}` | ✅ Preserved | Same. |
| **formatMessages: empty array** (test:96–99) | `formatter.ts:98` — returns empty string if no messages | ❌ Incompatible | v1 returns `<context>\n<messages>\n\n</messages>` even for empty. v2 returns empty string. Different expected output. |
| **formatMessages: reply context (quoted_message)** (test:102–116) | `formatter.ts:143, 183–188` `formatReplyContext()` | ⚠️ Changed | v1 renders `reply_to="42"` attribute + `<quoted_message from="Bob">text</quoted_message>` child. v2 renders as `<reply-to sender="..." >preview</reply-to>` without message ID attribute. |
| **formatMessages: omit reply when absent** (test:119–122) | `formatter.ts:183` (conditional) | ✅ Preserved | Both check for presence before rendering. |
| **formatMessages: omit quoted_message when content missing** (test:125–136) | `formatter.ts:184` (check `replyTo.text`) | ✅ Preserved | Both guard against missing content. |
| **formatMessages: escape reply context** (test:139–151) | `formatter.ts:188` `escapeXml()` on sender and text | ✅ Preserved | Same escaping applied. |
| **formatMessages: timezone conversion** (test:154–160) | `formatter.ts:216–223` `formatTime()` — HH:MM UTC only | ❌ Incompatible | v1 uses `formatLocalTime()` (full locale string with date, month, am/pm) from `timezone.ts:26–37`. v2 uses 24-hour `HH:MM` UTC only; no timezone localization. |
| **TRIGGER_PATTERN: matches @name at start** (test:170–171) | No v2 code equivalent | ❌ Not in v2 | v2 moved trigger rules to DB; no regex pattern in code. Router evaluates `messaging_group_agents.trigger_rules` JSON. |
| **TRIGGER_PATTERN: case-insensitive** (test:174–176) | DB model (applied at runtime by router) | ❌ Not in v2 | Same behavior (case-insensitive in router) but no test coverage for trigger logic in v2. |
| **TRIGGER_PATTERN: word boundary checks** (test:179–192) | DB model (router enforces) | ❌ Not in v2 | Router evaluates trigger rules; no unit tests for pattern matching. |
| **getTriggerPattern: custom per-group trigger** (test:201–206) | `/src/router.ts` evaluates `messaging_group_agents.trigger_rules` at delivery time | ❌ Not tested in v2 | v2 has no unit test for custom trigger selection. Behavior preserved in router but untested. |
| **getTriggerPattern: regex characters literal** (test:215–219) | DB-stored rule (router uses literal match or regex) | ❌ Not tested | v2 stores trigger as string in DB; runtime evaluation depends on router implementation (not inspected here). |
| **stripInternalTags: single-line** (test:226–227) | No direct v2 function — embedded in polling | ❌ Not isolated | v1 regex `/<internal>[\s\S]*?<\/internal>/g` with `.trim()`. v2 container poll-loop does not test this; no dedicated outbound function in v2 agent-runner. |
| **stripInternalTags: multi-line** (test:230–231) | Not tested in v2 | ❌ Not isolated | v1 regex handles `[\s\S]*?` (newlines included). |
| **stripInternalTags: multiple blocks** (test:234–235) | Not tested in v2 | ❌ Not isolated | Regex global flag `/g` handles multiple. Not verified in v2 tests. |
| **stripInternalTags: only internal tags** (test:238–239) | Not tested in v2 | ❌ Not isolated | v1 returns empty after trim; behavior not verified in v2. |
| **formatOutbound: passthrough clean text** (test:244–245) | Not tested in v2 | ❌ Not isolated | v1 calls `stripInternalTags()` then returns. v2 does not have isolated test. |
| **formatOutbound: empty after strip** (test:248–249) | Not tested in v2 | ❌ Not isolated | v1 returns empty if all was internal. |
| **formatOutbound: strip tags from text** (test:252–253) | Not tested in v2 | ❌ Not isolated | v1 example: `<internal>thinking</internal>The answer is 42` → `The answer is 42`. |
| **trigger gating: main group always processes** (test:277–279) | No unit test in v2; logic in `/src/router.ts` routing decision | ❌ Not tested | v1 shows that main groups bypass trigger check. Behavior likely preserved (main group always forwards to agent) but not verified by test. |
| **trigger gating: main group ignores requiresTrigger flag** (test:282–284) | Not tested in v2 | ❌ Not tested | v1 shows `isMainGroup=true` overrides `requiresTrigger` flag. No v2 test. |
| **trigger gating: non-main needs trigger (default)** (test:287–289) | Not tested in v2 | ❌ Not tested | v1 default behavior: non-main group requires trigger unless explicitly disabled. |
| **trigger gating: custom per-group trigger enforcement** (test:302–309) | Not tested in v2 | ❌ Not tested | v1 shows per-group trigger override. Behavior in v2 DB but no test. |
| **trigger gating: requiresTrigger=false disables check** (test:312–314) | Not tested in v2 | ❌ Not tested | v1 allows opting out of trigger requirement per group. |

---

## Missing from v2

1. **Timezone-aware time formatting**
   - v1: `formatLocalTime(utcIso, timezone)` in `src/v1/timezone.ts:26–37` converts UTC ISO timestamp to user's local timezone with full locale formatting (date, month, am/pm).
   - v2: `formatTime()` in `container/agent-runner/src/formatter.ts:216–223` only extracts `HH:MM` in UTC, no localization.
   - **Impact**: v2 loses per-agent timezone context. Timestamps appear in UTC only, potentially confusing users in different timezones.

2. **Context header with timezone attribute**
   - v1: Every message batch includes `<context timezone="..."/>` header.
   - v2: No context header; timestamp is a message attribute only.
   - **Impact**: Agent sees no explicit timezone declaration; must infer from message times or system prompt.

3. **Reply context with message ID attribute**
   - v1: `reply_to="<message_id>"` attribute on message; separate `<quoted_message from="...">content</quoted_message>` child.
   - v2: Consolidated into `<reply-to sender="...">preview</reply-to>` without message ID; preview truncated to 100 chars.
   - **Impact**: v2 loses structured reply tracking; agent can't reference specific message IDs in follow-ups.

4. **Message ID sequence in XML**
   - v1: No `id` attribute on messages (WhatsApp-era design).
   - v2: Each message has `id="seq"` (database sequence number).
   - **Impact**: Allows agent to reference messages by ID, but v1 tests do not verify this.

5. **Trigger pattern unit tests**
   - v1: Comprehensive tests for `getTriggerPattern()`, `TRIGGER_PATTERN`, case-insensitivity, word boundaries, regex escaping.
   - v2: No unit tests; trigger logic moved to DB and router. Untested.
   - **Impact**: Trigger matching behavior not verified by tests; regression risk if router changes.

6. **Internal tag stripping tests**
   - v1: `stripInternalTags()` and `formatOutbound()` tested for single-line, multi-line, multiple blocks, edge cases.
   - v2: No isolated tests for outbound tag stripping.
   - **Impact**: No verification that internal tags are reliably removed before delivery.

7. **Trigger gating (requiresTrigger flag) tests**
   - v1: Detailed tests of main-group bypass, per-group override, default behavior, flag combinations.
   - v2: No tests; logic moved to DB schema and router evaluation.
   - **Impact**: Trigger enforcement behavior not verified.

8. **Empty message batch handling**
   - v1: Explicitly returns `<context>\n<messages>\n\n</messages>` for empty array.
   - v2: Returns empty string.
   - **Impact**: No clear protocol for "no messages to process" signals.

---

## Behavioral discrepancies

### 1. Message XML structure (formatMessages)
- **v1**: `<context timezone="..."/>\n<messages>\n<message sender="..." time="...">content</message>\n</messages>`
- **v2**: `<message id="seq" from="dest-name" sender="..." time="HH:MM">content</message>` (no wrapper for single message)
- **v1 line**: `src/v1/router.ts:9–23`
- **v2 line**: `container/agent-runner/src/formatter.ts:124–158`

### 2. Time formatting
- **v1**: Full locale string (e.g., "Jan 1, 2024, 1:30 PM") using `Intl.DateTimeFormat` with timezone localization (`src/v1/timezone.ts:26–37`)
- **v2**: 24-hour UTC only (e.g., "13:30") without timezone info (`container/agent-runner/src/formatter.ts:216–223`)
- **Impact**: v2 loses timezone awareness; agent cannot distinguish between user's local time and server time.

### 3. Reply context structure
- **v1**: Two-part — `reply_to="<id>"` attribute + `<quoted_message from="...">text</quoted_message>` child element
- **v2**: Single element — `<reply-to sender="...">100-char preview</reply-to>` (no ID, preview truncated)
- **v1 line**: `src/v1/router.ts:12–16`
- **v2 line**: `container/agent-runner/src/formatter.ts:143, 183–188`
- **Impact**: v2 cannot support message-ID-based threading; loses structured reply metadata.

### 4. Trigger pattern matching
- **v1**: Implemented as regex returned by `getTriggerPattern()` with word-boundary enforcement (`config.ts:40–49`)
- **v2**: Stored in DB as JSON in `messaging_group_agents.trigger_rules`; evaluated by router at delivery time
- **v1 line**: `src/v1/config.ts:40–49`
- **v2 line**: `/src/router.ts` (router logic, not inspected in detail here)
- **Impact**: v1 enforces word boundaries via regex (`\b`); v2 implementation unknown (DB-driven).

### 5. Empty message handling
- **v1**: Returns `<context>\n<messages>\n\n</messages>` — preserves structure
- **v2**: Returns empty string
- **v1 line**: `src/v1/router.ts:22`
- **v2 line**: `container/agent-runner/src/formatter.ts:98`

### 6. Internal tag stripping
- **v1**: Regex-based, `.trim()` called after removal
- **v2**: Not isolated; no dedicated function or test in v2 formatter
- **v1 line**: `src/v1/router.ts:25–26`
- **v2 line**: No equivalent

---

## Worth preserving?

**Partially.** The v1 formatting test suite is **essential for documenting lost functionality**, not for v2 regression. Key behaviors that should be preserved in v2 but are currently missing:

1. **Timezone-aware message timestamps** — v2 should restore `formatLocalTime()` from `src/v1/timezone.ts` and include timezone context in the XML header. Without this, agents cannot reason about when messages arrived relative to the user's clock.

2. **Reply context with message IDs** — v2's truncated reply preview is lossy. Consider restoring the `reply_to="<id>"` attribute so agents can reference prior messages by sequence number for structured threading.

3. **Trigger pattern unit tests** — v2 moved trigger logic to the DB but lost test coverage. The DB schema and router must enforce the same invariants (word boundaries, case-insensitivity, custom per-group overrides) that v1 tested. Recommend adding integration tests to `src/router.ts` or `src/channels/adapter.ts` to verify trigger matching.

4. **Internal tag stripping tests** — v2 agent-runner should include unit tests for `stripInternalTags()` (if the skill applies) to prevent regression when Claude adds `<internal>` thinking tags.

The v1 test file serves as a **specification document** for channel formatting and trigger gating that v2 partially refactored away. Keeping it in the repo (even unpowered) documents the intended semantics.

