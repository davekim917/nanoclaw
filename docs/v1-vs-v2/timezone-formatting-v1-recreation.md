# v1 Timezone + Formatting — Recreation Spec

## Source commits

**Parent of deletion**: `86becf8^ = 27c52205f9fdeac0483600b2663f1c4d80aba45d`

**Deletion commit**: `86becf8` (chore: delete v1 reference code)

### Relevant v1 files at commit 27c5220 (v1^):
- `src/v1/router.ts` — message formatting logic (escapeXml, formatMessages, stripInternalTags, formatOutbound)
- `src/v1/timezone.ts` — timezone utility functions (isValidTimezone, resolveTimezone, formatLocalTime)
- `src/v1/config.ts` — configuration and trigger patterns (buildTriggerPattern, getTriggerPattern, TIMEZONE resolution)
- `src/v1/task-scheduler.ts` — scheduled task timezone handling (computeNextRun with cron-parser)
- `src/v1/types.ts` — data structures (NewMessage interface)
- `src/v1/formatting.test.ts` — comprehensive test suite for all formatting behavior
- `src/v1/timezone.test.ts` — timezone utility tests
- `src/v1/task-scheduler.test.ts` — scheduler tests

---

## 1. Timestamp formatting on inbound messages

### v1 behavior (exact)

**Function**: `formatLocalTime()` in `src/v1/timezone.ts:26-36`

```typescript
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
```

**Input**: UTC ISO 8601 timestamp (e.g., `'2024-01-01T00:00:00.000Z'`) + timezone name (e.g., `'America/New_York'`)

**Output format example**:
- Input: `'2024-01-01T18:30:00.000Z'` with timezone `'America/New_York'` (EST, UTC-5)
- Output: `'1:30 PM'` (with additional date components: month short name, day, year, hour, 2-digit minute, 12-hour format)
- Full example output: `"Jan 1, 2024, 1:30 PM"` (exact format depends on browser/Node locale)

**Critical Details**:
- Uses JavaScript's `Intl.DateTimeFormat` API with `en-US` locale
- Format options: `{ year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }`
- Handles invalid timezone gracefully by calling `resolveTimezone(timezone)` which falls back to UTC
- No external dependencies (no moment.js, date-fns, or day.js)

**Where it's called**:
- `src/v1/router.ts:11` in `formatMessages()` function to convert each message's `m.timestamp` to display time
- The display time is then placed in the `time="..."` attribute of the XML message element

### Test coverage

From `src/v1/formatting.test.ts:51-84`:

1. **Basic formatting with context header**
   - Input: Single message with timestamp `'2024-01-01T00:00:00.000Z'`, timezone `'UTC'`
   - Asserts: `result.toContain('Jan 1, 2024')` and `'<context timezone="UTC" />'`
   - File:line: `src/v1/formatting.test.ts:51-56`

2. **Timezone conversion to local time**
   - Input: Timestamp `'2024-01-01T18:30:00.000Z'` with timezone `'America/New_York'` (EST)
   - Asserts: Result contains `'1:30'` and `'PM'` (correct EST conversion, UTC-5)
   - File:line: `src/v1/formatting.test.ts:74-78`

From `src/v1/timezone.test.ts:10-30`:

3. **formatLocalTime with timezone conversion**
   - Input: `'2026-02-04T18:30:00.000Z'` with `'America/New_York'`
   - Asserts: Contains `'1:30'`, `'PM'`, `'Feb'`, `'2026'`
   - File:line: `src/v1/timezone.test.ts:10-16`

4. **Multiple timezones comparison**
   - Input: Same UTC time with different timezones (`'America/New_York'`, `'Asia/Tokyo'`)
   - Asserts: NY shows `'8:00'` (EDT, UTC-4 in summer), Tokyo shows `'9:00'` (UTC+9)
   - File:line: `src/v1/timezone.test.ts:18-26`

5. **Invalid timezone fallback**
   - Input: Invalid timezone `'IST-2'`
   - Asserts: Does not throw, formats as UTC (falls back)
   - File:line: `src/v1/timezone.test.ts:28-33`

---

## 2. Context timezone header

### v1 behavior (exact)

**Location**: Prepended at the START of the formatted message block in `src/v1/router.ts:20-22`

**Format**:
```xml
<context timezone="<TIMEZONE_NAME>" />
```

**Code**:
```typescript
const header = `<context timezone="${escapeXml(timezone)}" />\n`;
return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
```

**What it includes**:
- Only the timezone name (IANA identifier, e.g., `'UTC'`, `'America/New_York'`)
- **NOT** the current time (that's in each individual message's `time="..."` attribute)
- XML-escaped to prevent injection (via `escapeXml()`)

**Per-message vs per-turn**:
- The header appears **once per call to `formatMessages()`**, which formats a batch of messages
- The entire batch (header + all messages) is passed to the agent as a single unit
- The `timezone` parameter is passed in from the caller (`src/v1/router.ts:9` line signature)

**Where it's wired**:
- `src/v1/router.ts:9` — `formatMessages(messages: NewMessage[], timezone: string)` accepts timezone as a parameter
- This function is called from the channel message processing loop (inbound message handler)
- The caller supplies the `TIMEZONE` constant from `src/v1/config.ts:62`

### Test coverage

From `src/v1/formatting.test.ts:51-56`:

1. **Context header is included in output**
   - Input: Any message list with timezone `'UTC'`
   - Asserts: `result.toContain('<context timezone="UTC" />')`
   - File:line: `src/v1/formatting.test.ts:51-56`

2. **Context header with non-UTC timezone**
   - Input: Timezone `'America/New_York'`
   - Asserts: `result.toContain('<context timezone="America/New_York" />')`
   - File:line: `src/v1/formatting.test.ts:74-78`

3. **Context header with empty message list**
   - Input: Empty array with timezone `'UTC'`
   - Asserts: `result.toContain('<context timezone="UTC" />')` even when no messages
   - File:line: `src/v1/formatting.test.ts:80-83`

---

## 3. Reply-to handling with message IDs

### v1 behavior (exact)

**Location**: In the message formatting loop in `src/v1/router.ts:10-18`

**Code**:
```typescript
const replyAttr = m.reply_to_message_id ? ` reply_to="${escapeXml(m.reply_to_message_id)}"` : '';
const replySnippet =
  m.reply_to_message_content && m.reply_to_sender_name
    ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
    : '';
return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
```

**Format of reply-to**:
- Attribute: `reply_to="<MESSAGE_ID>"` on the `<message>` tag (if `m.reply_to_message_id` is present)
- The ID is XML-escaped via `escapeXml()`
- Nested element: `<quoted_message from="<SENDER_NAME>"><MESSAGE_CONTENT></quoted_message>` (if both sender and content are present)
- Both sender name and content are XML-escaped

**What it contains**:
- `reply_to="<id>"` attribute with the exact message ID from `m.reply_to_message_id`
- Sender name from `m.reply_to_sender_name`
- Original message content from `m.reply_to_message_content`
- **No timestamp** of the referenced message

**Conditional rendering**:
1. If `m.reply_to_message_id` is present: include `reply_to="<id>"` attribute
2. If `m.reply_to_message_id` is present but content/sender missing: include attribute only, no `<quoted_message>` element
3. If only content and sender (no ID): only `<quoted_message>` element, no attribute

**Example output**:
```xml
<message sender="Alice" time="Jan 1, 2024, 12:00 PM" reply_to="42">
  <quoted_message from="Bob">Are you coming tonight?</quoted_message>
Yes, on my way!</message>
```

### Test coverage

From `src/v1/formatting.test.ts:96-139`:

1. **Reply with both ID and quoted content**
   - Input: Message with `reply_to_message_id: '42'`, `reply_to_sender_name: 'Bob'`, `reply_to_message_content: 'Are you coming tonight?'`, content: `'Yes, on my way!'`
   - Asserts:
     - `result.toContain('reply_to="42"')`
     - `result.toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>')`
     - `result.toContain('Yes, on my way!</message>')`
   - File:line: `src/v1/formatting.test.ts:96-112`

2. **No reply context when missing**
   - Input: Message without reply fields
   - Asserts:
     - `result.not.toContain('reply_to')`
     - `result.not.toContain('quoted_message')`
   - File:line: `src/v1/formatting.test.ts:114-119`

3. **ID present but content missing**
   - Input: `reply_to_message_id: '42'`, `reply_to_sender_name: 'Bob'`, but NO `reply_to_message_content`
   - Asserts:
     - `result.toContain('reply_to="42"')`
     - `result.not.toContain('quoted_message')`
   - File:line: `src/v1/formatting.test.ts:121-130`

4. **XML escape in reply context**
   - Input: `reply_to_message_id: '1'`, `reply_to_sender_name: 'A & B'`, `reply_to_message_content: '<script>alert("xss")</script>'`
   - Asserts:
     - `result.toContain('from="A &amp; B"')`
     - `result.toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')`
   - File:line: `src/v1/formatting.test.ts:131-139`

---

## 4. Internal tag stripping

### v1 behavior (exact)

**Function name**: `stripInternalTags()` in `src/v1/router.ts:25-27`

**Implementation**:
```typescript
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
```

**Regex pattern**: `/<internal>[\s\S]*?<\/internal>/g`
- `<internal>` — literal opening tag
- `[\s\S]*?` — match any character (whitespace or non-whitespace) non-greedily
- `<\/internal>` — literal closing tag
- `g` flag — global (all matches)

**Post-processing**: `.trim()` removes leading/trailing whitespace after all tags are stripped

**Where it's called**:
- `src/v1/router.ts:30` in `formatOutbound()` function
- Called AFTER the tag removal to clean the output before returning

**Used for**: Stripping internal thinking/reasoning from outbound messages before sending to channel

**Input/Output examples**:

1. Single-line internal tag:
   - Input: `'hello <internal>secret</internal> world'`
   - Output: `'hello  world'` (then `.trim()` would be `'hello world'`)

2. Multi-line internal tags:
   - Input: `'hello <internal>\nsecret\nstuff\n</internal> world'`
   - Output: `'hello  world'`

3. Multiple blocks:
   - Input: `'<internal>a</internal>hello<internal>b</internal>'`
   - Output: `'hello'`

4. Only internal content:
   - Input: `'<internal>only this</internal>'`
   - Output: `''` (empty after trim)

### Test coverage

From `src/v1/formatting.test.ts:163-181`:

1. **Single-line tag stripping**
   - Input: `'hello <internal>secret</internal> world'`
   - Asserts: Result is `'hello  world'` (two spaces, then `.trim()` removes outer whitespace)
   - Expected (with trim): `'hello world'`
   - File:line: `src/v1/formatting.test.ts:163-165`

2. **Multi-line tag stripping**
   - Input: `'hello <internal>\nsecret\nstuff\n</internal> world'`
   - Asserts: Result is `'hello  world'` (after trim)
   - File:line: `src/v1/formatting.test.ts:167-169`

3. **Multiple internal blocks**
   - Input: `'<internal>a</internal>hello<internal>b</internal>'`
   - Asserts: Result is `'hello'`
   - File:line: `src/v1/formatting.test.ts:171-173`

4. **Only internal content**
   - Input: `'<internal>only this</internal>'`
   - Asserts: Result is `''` (empty string)
   - File:line: `src/v1/formatting.test.ts:175-177`

From `src/v1/formatting.test.ts:183-194`:

5. **formatOutbound with no internal tags**
   - Input: `'hello world'`
   - Asserts: Result is `'hello world'`
   - File:line: `src/v1/formatting.test.ts:183-185`

6. **formatOutbound with all internal content**
   - Input: `'<internal>hidden</internal>'`
   - Asserts: Result is `''` (returns early after strip)
   - File:line: `src/v1/formatting.test.ts:187-189`

7. **formatOutbound strips and returns remaining**
   - Input: `'<internal>thinking</internal>The answer is 42'`
   - Asserts: Result is `'The answer is 42'`
   - File:line: `src/v1/formatting.test.ts:191-194`

---

## 5. Timezone handling for scheduled tasks

### v1 behavior (exact)

**Location**: `src/v1/task-scheduler.ts:20-49`

**Key function**: `computeNextRun(task: ScheduledTask): string | null`

**Cron timezone handling**:
```typescript
if (task.schedule_type === 'cron') {
  const interval = CronExpressionParser.parse(task.schedule_value, {
    tz: TIMEZONE,
  });
  return interval.next().toISOString();
}
```

**Critical details**:
- Uses `cron-parser` library's `CronExpressionParser.parse()` method
- Passes timezone option as `{ tz: TIMEZONE }` (e.g., `{ tz: 'America/New_York' }`)
- `TIMEZONE` is imported from `src/v1/config.ts:62` and resolved via `resolveConfigTimezone()`
- The cron expression is interpreted in the **user's timezone**, not UTC
- Example: cron `'0 9 * * *'` with `tz: 'America/New_York'` means 9 AM ET every day

**Interval task handling**:
```typescript
if (task.schedule_type === 'interval') {
  const ms = parseInt(task.schedule_value, 10);
  if (!ms || ms <= 0) {
    logger.warn({ taskId: task.id, value: task.schedule_value }, 'Invalid interval value');
    return new Date(now + 60_000).toISOString();
  }
  let next = new Date(task.next_run!).getTime() + ms;
  while (next <= now) {
    next += ms;
  }
  return new Date(next).toISOString();
}
```

**Interval specifics**:
- Intervals are timezone-agnostic (pure millisecond-based)
- Anchored to the task's `next_run` time to prevent cumulative drift
- If intervals have been missed, the loop skips forward to land in the future while maintaining the original schedule grid

**Once-only tasks**:
```typescript
if (task.schedule_type === 'once') return null;
```

**MCP tool description**: 
- v1 did not expose cron task scheduling directly to the agent (it was a server-side feature)
- The scheduling was configured in group config files, not via agent tool calls

### Test coverage

From `src/v1/task-scheduler.test.ts:33-60`:

1. **computeNextRun returns null for once-tasks**
   - Input: Task with `schedule_type: 'once'`
   - Asserts: `computeNextRun(task)` returns `null`
   - File:line: `src/v1/task-scheduler.test.ts:40-49`

2. **Interval task anchoring to prevent drift**
   - Input: Task scheduled 2s ago with interval `60000` (1 minute)
   - Asserts: Next run = `scheduledTime + 60s`, not `now + 60s`
   - Expected: Exact alignment to the scheduled time grid
   - File:line: `src/v1/task-scheduler.test.ts:33-39`

3. **Interval task catches up without infinite loop**
   - Input: Task with 10 missed intervals (missed by 10 * 60000ms)
   - Asserts: Next run is in the future and aligned to original schedule grid
   - File:line: `src/v1/task-scheduler.test.ts:51-60`

---

## 6. Complete test inventory (formatting.test.ts)

### All test cases from src/v1/formatting.test.ts (lines 1-254):

#### Block 1: escapeXml tests (lines 22-46)

| Test name | Input | Expected output |
|-----------|-------|-----------------|
| escapes ampersands | `'a & b'` | `'a &amp; b'` |
| escapes less-than | `'a < b'` | `'a &lt; b'` |
| escapes greater-than | `'a > b'` | `'a &gt; b'` |
| escapes double quotes | `'"hello"'` | `'&quot;hello&quot;'` |
| handles multiple special characters together | `'a & b < c > d "e"'` | `'a &amp; b &lt; c &gt; d &quot;e&quot;'` |
| passes through strings with no special chars | `'hello world'` | `'hello world'` |
| handles empty string | `''` | `''` |

#### Block 2: formatMessages tests (lines 48-159)

| Test name | Input | Key asserts |
|-----------|-------|------------|
| formats a single message as XML with context header (line 51) | Single message with timestamp `'2024-01-01T00:00:00.000Z'`, TZ `'UTC'` | Contains `'<context timezone="UTC" />'`, `'<message sender="Alice"'`, `'>hello</message>'`, `'Jan 1, 2024'` |
| formats multiple messages (line 59) | 2 messages: Alice at 00:00, Bob at 01:00 | Contains both sender names and contents |
| escapes special characters in sender names (line 72) | Sender `'A & B <Co>'` | Contains `'sender="A &amp; B &lt;Co&gt;"'` |
| escapes special characters in content (line 79) | Content `'<script>alert("xss")</script>'` | Contains escaped script tags `'&lt;script&gt;...'` |
| handles empty array (line 85) | Empty message list, TZ `'UTC'` | Contains header and `'<messages>\n\n</messages>'` |
| renders reply context as quoted_message element (line 96) | Message with `reply_to_message_id: '42'`, `reply_to_sender_name: 'Bob'`, `reply_to_message_content: 'Are you coming tonight?'` | Contains `'reply_to="42"'`, `'<quoted_message from="Bob">Are you coming tonight?</quoted_message>'` |
| omits reply attributes when no reply context (line 114) | Message without reply fields | Does NOT contain `'reply_to'` or `'quoted_message'` |
| omits quoted_message when content is missing but id is present (line 121) | Message with `reply_to_message_id: '42'` but no `reply_to_message_content` | Contains `'reply_to="42"'` but NOT `'<quoted_message'` |
| escapes special characters in reply context (line 131) | Sender `'A & B'`, content `'<script>alert("xss")</script>'` | Contains `'from="A &amp; B"'` and escaped script |
| converts timestamps to local time for given timezone (line 140) | Timestamp `'2024-01-01T18:30:00.000Z'` with TZ `'America/New_York'` (EST, UTC-5) | Contains `'1:30'`, `'PM'`, header has `'America/New_York'` |

#### Block 3: TRIGGER_PATTERN tests (lines 146-169)

| Test name | Input | Expected result |
|-----------|-------|-----------------|
| matches @name at start of message (line 152) | `'@Andy hello'` (assuming ASSISTANT_NAME='Andy') | `true` |
| matches case-insensitively (line 156) | `'@andy hello'` or `'@ANDY hello'` | `true` |
| does not match when not at start of message (line 160) | `'hello @Andy'` | `false` |
| does not match partial name like @NameExtra (word boundary) (line 164) | `'@Andyextra hello'` | `false` |
| matches with word boundary before apostrophe (line 168) | `'@Andy\'s thing'` | `true` |
| matches @name alone (end of string is a word boundary) (line 172) | `'@Andy'` | `true` |
| matches with leading whitespace after trim (line 175) | `'  @Andy hey'` (after `.trim()`) | `true` |

#### Block 4: getTriggerPattern tests (lines 177-196)

| Test name | Input | Expected behavior |
|-----------|-------|-------------------|
| uses the configured per-group trigger when provided (line 180) | `getTriggerPattern('@Claw')` | Matches `'@Claw hello'`, does NOT match `'@Andy hello'` |
| falls back to the default trigger when group trigger is missing (line 186) | `getTriggerPattern(undefined)` | Matches default trigger `'@Andy hello'` |
| treats regex characters in custom triggers literally (line 192) | `getTriggerPattern('@C.L.A.U.D.E')` | Matches literal dots, NOT wildcard (does NOT match `'@CXLXAUXDXE'`) |

#### Block 5: stripInternalTags tests (lines 198-210)

| Test name | Input | Expected output |
|-----------|-------|-----------------|
| strips single-line internal tags (line 199) | `'hello <internal>secret</internal> world'` | `'hello  world'` (then `.trim()` makes it `'hello world'`) |
| strips multi-line internal tags (line 203) | `'hello <internal>\nsecret\nstuff\n</internal> world'` | `'hello  world'` |
| strips multiple internal tag blocks (line 207) | `'<internal>a</internal>hello<internal>b</internal>'` | `'hello'` |
| returns empty string when text is only internal tags (line 211) | `'<internal>only this</internal>'` | `''` |

#### Block 6: formatOutbound tests (lines 213-226)

| Test name | Input | Expected output |
|-----------|-------|-----------------|
| returns text with internal tags stripped (line 214) | `'hello world'` | `'hello world'` |
| returns empty string when all text is internal (line 218) | `'<internal>hidden</internal>'` | `''` |
| strips internal tags from remaining text (line 222) | `'<internal>thinking</internal>The answer is 42'` | `'The answer is 42'` |

#### Block 7: trigger gating (requiresTrigger interaction) tests (lines 228-254)

| Test name | Input | Expected result |
|-----------|-------|-----------------|
| main group always processes (no trigger needed) (line 239) | `isMainGroup: true`, message without trigger | `true` |
| main group processes even with requiresTrigger=true (line 244) | `isMainGroup: true`, `requiresTrigger: true`, no trigger | `true` |
| non-main group with requiresTrigger=undefined requires trigger (line 249) | `isMainGroup: false`, `requiresTrigger: undefined`, no trigger | `false` |
| non-main group with requiresTrigger=true requires trigger (line 254) | `isMainGroup: false`, `requiresTrigger: true`, no trigger | `false` |
| non-main group with requiresTrigger=true processes when trigger present (line 259) | `isMainGroup: false`, trigger in message | `true` |
| non-main group uses per-group trigger instead of default (line 264) | `isMainGroup: false`, `trigger: '@Claw'`, message `'@Claw do something'` | `true` |
| non-main group does not process when only default trigger is present for custom-trigger group (line 269) | `isMainGroup: false`, `trigger: '@Claw'`, message `'@Andy do something'` | `false` |
| non-main group with requiresTrigger=false always processes (line 274) | `isMainGroup: false`, `requiresTrigger: false`, no trigger | `true` |

---

## v2 porting plan

### For each of sections 1–5: the specific change to make in v2

#### 1. Timestamp formatting

**v2 file to modify**: (Unknown — search for where v2 formats inbound messages to the agent)

**Change needed**:
1. Find where v2 currently formats message timestamps for the agent
2. Replace any custom date formatting with the v1 pattern:
   - Call `new Date(timestamp).toLocaleString('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })`
3. Ensure the timezone parameter is sourced from `config.TIMEZONE` (or equivalent in v2)

**Test to port**: `src/v1/formatting.test.ts:51-56` (basic formatting) and `src/v1/formatting.test.ts:74-78` (timezone conversion)

#### 2. Context timezone header

**v2 file to modify**: (Unknown — search for where v2 constructs the XML/prompt for inbound messages)

**Change needed**:
1. Prepend `<context timezone="<TIMEZONE_NAME>" />\n` to the formatted message block
2. The timezone should be the resolved IANA identifier (e.g., `'UTC'`, `'America/New_York'`)
3. Ensure it's placed BEFORE the `<messages>` element

**Test to port**: `src/v1/formatting.test.ts:51-56` and `src/v1/formatting.test.ts:80-83` (empty array still has header)

#### 3. Reply-to with message ID

**v2 file to modify**: (Unknown — search for where v2 formats message metadata)

**Change needed**:
1. If `message.reply_to_message_id` is present, add ` reply_to="<ID>"` attribute to the `<message>` element
2. If BOTH `message.reply_to_message_content` AND `message.reply_to_sender_name` are present, include a nested `<quoted_message from="<SENDER>"><CONTENT></quoted_message>` element
3. XML-escape all three values (ID, sender name, content)

**Test to port**: 
- `src/v1/formatting.test.ts:96-112` (full reply context)
- `src/v1/formatting.test.ts:121-130` (ID only, no content)
- `src/v1/formatting.test.ts:131-139` (XML escaping in reply)

#### 4. Internal tag stripping

**v2 file to modify**: (Unknown — search for where v2 processes outbound messages before sending)

**Change needed**:
1. Apply the regex `/<internal>[\s\S]*?<\/internal>/g` to strip all internal thinking/reasoning blocks
2. Call `.trim()` on the result after stripping
3. Return empty string if result is empty after stripping

**Test to port**: 
- `src/v1/formatting.test.ts:163-177` (stripInternalTags)
- `src/v1/formatting.test.ts:183-194` (formatOutbound)

#### 5. Scheduled task timezone handling

**v2 file to modify**: (Unknown — search for where v2 handles cron task scheduling)

**Change needed**:
1. When parsing cron expressions, pass the timezone option to cron-parser:
   ```typescript
   const interval = CronExpressionParser.parse(cronExpression, { tz: TIMEZONE });
   ```
2. For interval-based tasks, anchor to the original `next_run` time, not `Date.now()`, to prevent drift
3. Ensure the TIMEZONE constant is resolved at startup via a function like:
   ```typescript
   function resolveConfigTimezone(): string {
     const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
     for (const tz of candidates) {
       if (tz && isValidTimezone(tz)) return tz;
     }
     return 'UTC';
   }
   ```

**Test to port**: 
- `src/v1/task-scheduler.test.ts:33-39` (interval anchoring)
- `src/v1/task-scheduler.test.ts:40-49` (once-task returns null)
- `src/v1/task-scheduler.test.ts:51-60` (interval catch-up)

---

## Git references for verification

All code snippets above can be verified with:

```bash
git show 27c5220:src/v1/router.ts
git show 27c5220:src/v1/timezone.ts
git show 27c5220:src/v1/config.ts
git show 27c5220:src/v1/task-scheduler.ts
git show 27c5220:src/v1/types.ts
git show 27c5220:src/v1/formatting.test.ts
git show 27c5220:src/v1/timezone.test.ts
git show 27c5220:src/v1/task-scheduler.test.ts
```

Or from the deletion parent commit:

```bash
git show 86becf8^:src/v1/<filename>
```
