# channels: v1 vs v2

## Scope

### v1
- **Paths**: `src/v1/channels/index.ts`, `src/v1/channels/registry.ts`, `src/v1/channels/registry.test.ts`
- **LOC**: 62 total (1 + 23 + 38)
- **Purpose**: Registry and interface stubs for external channel adapters (real adapters live on `channels` branch)

### v2 counterparts
- **Paths**: `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/channels/chat-sdk-bridge.ts`, `src/channels/index.ts`, `src/channels/ask-question.ts`, and tests
- **LOC**: 1,055 total (excluding tests: ~757)
- **Purpose**: Full adapter interface, registry with lifecycle, Chat SDK bridge (new in v2), ask_question normalization, plus integration tests

---

## Adapter Interface Diff

### v1: `Channel` (from src/v1/types.ts:87–98)

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;      // Optional
  syncGroups?(force: boolean): Promise<void>;                      // Optional
}
```

**Callbacks** (src/v1/types.ts:101–112):
- `OnInboundMessage(chatJid: string, message: NewMessage): void`
- `OnChatMetadata(chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean): void`

**Factory & Registration** (src/v1/channels/registry.ts:3–23):
```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;
registerChannel(name: string, factory: ChannelFactory): void;
getChannelFactory(name: string): ChannelFactory | undefined;
getRegisteredChannelNames(): string[];
```

---

### v2: `ChannelAdapter` (from src/channels/adapter.ts:61–106)

```typescript
export interface ChannelAdapter {
  name: string;
  channelType: string;
  supportsThreads: boolean;  // NEW: declares thread model
  
  // Lifecycle (was: connect/disconnect)
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  
  // Message delivery (was: sendMessage, now structured)
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;
  
  // Optional
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  updateConversations?(conversations: ConversationConfig[]): void;
  openDM?(userHandle: string): Promise<string>;  // NEW: cold-DM initiation
}
```

**Callbacks** (src/channels/adapter.ts:18–30):
```typescript
export interface ChannelSetup {
  conversations: ConversationConfig[];
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;  // NEW
}
```

**Factory & Registration** (src/channels/channel-registry.ts:25–47):
```typescript
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  containerConfig?: { mounts?: [...]; env?: Record<string, string>; };
}
registerChannelAdapter(name: string, registration: ChannelRegistration): void;
getChannelAdapter(channelType: string): ChannelAdapter | undefined;  // RENAMED
getActiveAdapters(): ChannelAdapter[];  // NEW
getRegisteredChannelNames(): string[];
getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'];  // NEW
```

---

## Capability Map

| v1 Behavior | v2 Location | Status | Notes |
|---|---|---|---|
| **Interface & Lifecycle** | | | |
| `connect()` → `disconnect()` | `setup()` / `teardown()` | Renamed + consolidated | v2 groups init work; adds promise-based retry on NetworkError (src/channels/channel-registry.ts:73) |
| `Channel.name: string` | `ChannelAdapter.name` + `ChannelAdapter.channelType` | Split | `name` is identity; `channelType` is the key for active lookup |
| `ownsJid(jid)` | Implicit in platformId model | Removed | v2 uses structured platformId + threadId; ownership logic pushed to router |
| **Message Flow** | | | |
| `sendMessage(jid, text)` | `deliver(platformId, threadId, message)` | Refactored | v2 passes structured `OutboundMessage` with `kind` field; returns platform messageId; supports edit/reaction ops (src/channels/chat-sdk-bridge.ts:279–289) |
| Callbacks: `onMessage` | `onInbound(platformId, threadId, message)` | Refactored | v2 passes message object with `kind` enum ('chat' \| 'chat-sdk'); can be async |
| Callbacks: `onChatMetadata` | `onMetadata(platformId, name?, isGroup?)` | Simplified | Signature matches v1; removed `channel` param; timestamp now in inbound message itself |
| | `onAction(questionId, option, userId)` | **NEW** | Handles ask_question card button clicks via Chat SDK bridge (src/channels/chat-sdk-bridge.ts:193–218) |
| **Typing Indicator** | | | |
| `setTyping(jid, bool)` | `setTyping(platformId, threadId)` | Refactored | v2 omits boolean flag (always true, no off-toggle); threaded parameter |
| **Group/Conversation Sync** | | | |
| `syncGroups(force?)` | `syncConversations()?: Promise<ConversationInfo[]>` | Renamed | Now returns structured list; decoupled from periodic init (optional hook) |
| | `updateConversations(configs)`: void | **NEW** | Push notifications of conversation changes from host to adapter (e.g., new wiring) |
| **Thread Model** | | | |
| Implicit (adapter-specific) | `supportsThreads: boolean` | **NEW** | v2 explicitly declares it; router uses this to collapse/expand thread context (src/channels/adapter.ts:73–75) |
| **DM Initiation** | | | |
| Not exposed | `openDM(userHandle)?: Promise<string>` | **NEW** | For cold-DM reaching (approvals, onboarding, alerts) on platforms that distinguish user-id from DM-channel-id. Optional; fallback in user-dm.ts if absent (src/channels/adapter.ts:94–105) |
| **Inbound Message Structure** | | | |
| v1 `NewMessage` object | v2 `InboundMessage` (generic JSON) | Generalized | v1 had flat fields (sender, content, timestamp, thread_id, reply_to_*); v2 wraps serialized Chat SDK Message or native JSON in `content` field; Chat SDK bridge enriches (adds senderId, senderName) before sending (src/channels/chat-sdk-bridge.ts:124–141) |
| **Outbound Message Structure** | | | |
| Plain text + typing flag | v2 `OutboundMessage` (typed `kind` + flexible `content`) | Generalized | Supports 'chat', 'chat-sdk', edit ops, reactions, ask_question cards (src/channels/adapter.ts:46–51, src/channels/chat-sdk-bridge.ts:279–317) |
| **Factory Pattern** | | | |
| `ChannelFactory(opts) → Channel \| null` | `ChannelAdapterFactory() → ChannelAdapter \| Promise<...> \| null` | Async + cred check | v2 supports async factory (for loading credentials); promise-based retry on NetworkError (src/channels/channel-registry.ts:68–87) |
| **Container Config** | | | |
| Not exposed | `ChannelRegistration.containerConfig` | **NEW** | Adapters can declare mounts + env vars for their container (used by container-runner); see src/channels/channel-registry.ts:45–47 |

---

## Message Conversion & Error Handling

### v1 Flow
- Adapter calls `onMessage(chatJid, NewMessage)` synchronously
- Router extracts fields, upserts user, creates/finds session, writes to `inbound.db`
- No built-in error handling; adapters catch and log themselves

### v2 Flow (src/channels/chat-sdk-bridge.ts:85–141)
1. **Inbound**: Chat SDK `Message` → `InboundMessage` (kind='chat-sdk', content=serialized JSON)
2. **Attachment handling**: Downloads attachments, converts to base64 (src/channels/chat-sdk-bridge.ts:90–111)
3. **Reply context extraction**: Platform-specific hook (src/channels/chat-sdk-bridge.ts:115–120)
4. **User field normalization**: Maps Chat SDK author → senderId, sender, senderName (src/channels/chat-sdk-bridge.ts:124–131)
5. **Raw data drop**: Removes `raw` to save DB space (src/channels/chat-sdk-bridge.ts:134)
6. **Call onInbound**: Async-capable (can await router writes)

**Outbound** (src/channels/chat-sdk-bridge.ts:273–344):
- Supports multiple operation types via `content.operation`:
  - `'edit'` + `messageId` → `adapter.editMessage()`
  - `'reaction'` + `emoji` → `adapter.addReaction()`
  - `type: 'ask_question'` → render Card with buttons
  - Normal text/markdown → `adapter.postMessage()` with optional files

**Error Propagation**:
- Network errors on setup get retry (src/channels/channel-registry.ts:73; duck-type check for Error.name==='NetworkError')
- Delivery errors logged but don't block (src/channels/chat-sdk-bridge.ts:213–214, 484–486)

---

## New: Chat SDK Bridge

The v2 `Chat` abstraction (from `@anthropic-ai/chat`) wraps platform-specific adapters (Discord.js, Slack SDK, etc.) into a unified API. The NanoClaw `createChatSdkBridge()` (src/channels/chat-sdk-bridge.ts:68–384) adapts that `Chat` instance to the `ChannelAdapter` interface.

**Key methods**:
- `setup(hostConfig)`: Initialize Chat, set up event handlers (subscribed messages, DMs, mentions, actions), start Gateway listener or register webhook (src/channels/chat-sdk-bridge.ts:149–271)
- `deliver()`: Route outbound payloads (text, edit, reaction, ask_question card) to Chat SDK (src/channels/chat-sdk-bridge.ts:273–344)
- `setTyping()`: Delegate to `adapter.startTyping()` (src/channels/chat-sdk-bridge.ts:346–349)
- `teardown()`: Abort Gateway, shutdown Chat (src/channels/chat-sdk-bridge.ts:351–355)
- `updateConversations()`: Rebuild conversation map on changes (src/channels/chat-sdk-bridge.ts:361–363)
- `openDM()`: Conditional; only if underlying adapter supports it (src/channels/chat-sdk-bridge.ts:366–381)

**Event routing** (src/channels/chat-sdk-bridge.ts:163–191):
- `chat.onSubscribedMessage()` → `onInbound()` for all known threads
- `chat.onNewMention()` → `onInbound()` + auto-subscribe
- `chat.onDirectMessage()` → `onInbound()` for DMs
- `chat.onAction()` → `onAction()` for ask_question button clicks (src/channels/chat-sdk-bridge.ts:193–218)

**Gateway listener** (src/channels/chat-sdk-bridge.ts:222–268):
- Adapters like Discord that support websocket connection declare `startGatewayListener()`.
- NanoClaw runs it, forwards interactions (button clicks) to a local HTTP webhook server (src/channels/chat-sdk-bridge.ts:392–506).
- Non-Gateway adapters (Slack, Teams) register on the shared webhook-server instead (src/channels/chat-sdk-bridge.ts:266–268).

---

## Test Fixtures

### v1 (src/v1/channels/registry.test.ts:10–38)
- Simple lambda factories: `() => null`
- No mock adapters (tests only verify registry API mechanics)
- Test count: 4 (unknown-channel, round-trip, listing, overwrite)

### v2 (src/channels/channel-registry.test.ts + src/channels/chat-sdk-bridge.test.ts)

**Mock Adapter** (src/channels/channel-registry.test.ts:31–71):
```typescript
createMockAdapter(channelType): ChannelAdapter & { delivered, inbound, setupConfig }
  - Properties: name, channelType, supportsThreads, delivered[], inbound[], setupConfig
  - Methods: setup(config), teardown(), isConnected(), deliver(), setTyping(), updateConversations()
```

**Registry Tests** (src/channels/channel-registry.test.ts:84–119):
- Adapter registration with container config (src/channels/channel-registry.test.ts:88–98)
- Credential-missing adapters skipped (src/channels/channel-registry.test.ts:101–119)

**Integration Tests** (src/channels/channel-registry.test.ts:122–234):
- Router receives inbound from adapter, writes to inbound.db (src/channels/channel-registry.test.ts:166–197)
- Delivery adapter bridge calls adapter.deliver() (src/channels/channel-registry.test.ts:199–233)

**Chat SDK Bridge Tests** (src/channels/chat-sdk-bridge.test.ts:11–38):
- Conditional openDM exposure (src/channels/chat-sdk-bridge.test.ts:12–18)
- openDM delegation to underlying adapter (src/channels/chat-sdk-bridge.test.ts:20–37)

---

## Missing from v2

### 1. `ownsJid(jid: string): boolean`
- **v1 use**: Adapters declared ownership of a JID (e.g., "does this Telegram numeric ID belong to me?")
- **v2 model**: JIDs → platformId + threadId; ownership is implicit in `platformId` format (e.g., `"telegram:6037840640"` vs `"discord:guildId:channelId"`). Router uses this to route inbound to the right adapter.
- **Impact**: Adapters no longer need explicit ownership checks; the structured ID handles it.

### 2. `syncGroups(force?: boolean): Promise<void>`
- **v1 use**: Periodic or on-demand sync of all groups/channels from the platform.
- **v2 model**: Optional `syncConversations()` returns metadata instead of mutating internal state; host calls it when needed (not baked into adapter init). Conversations are tracked in central DB `messaging_groups` table.
- **Impact**: Host has more control; adapters don't side-effect their own state.

### 3. `registeredGroups` callback in `ChannelOpts`
- **v1 use**: Passed at init time; adapters could query which groups were registered.
- **v2 model**: Conversations provided upfront in `ChannelSetup.conversations`; can be updated via `updateConversations()`.
- **Impact**: Cleaner dependency injection; avoids callback nesting.

### 4. `channel` parameter in `OnChatMetadata`
- **v1 use**: Metadata callback could optionally return which channel type made the discovery.
- **v2 model**: Not needed; `platformId` in `onMetadata(platformId, name, isGroup)` encodes the channel type.

---

## Behavioral Discrepancies

### 1. Thread-ID Handling
- **v1**: Some adapters (Telegram, WhatsApp) don't use threads; JIDs are the same as channel IDs. Others (Discord, Slack) embed thread IDs in reply_to logic.
- **v2**: Explicit `supportsThreads` flag; adapters that don't support threads pass `threadId: null` to `onInbound()`. Router uses this to decide session granularity (file:src/channels/adapter.ts:73–75).

### 2. Outbound Message Structure
- **v1**: Plain text + optional typing flag.
- **v2**: Structured `{ kind, content, files? }` with operation support (edit, reaction, ask_question cards). Allows multi-op delivery without repeated deliver() calls.

### 3. Inbound Serialization
- **v1**: Adapters directly passed `NewMessage` interface objects.
- **v2**: Adapters pass `InboundMessage` with generic `content` field (JSON-serializable JS object). Chat SDK bridge converts Chat SDK Message → JSON, then stringifies for DB (file:src/channels/chat-sdk-bridge.ts:136–140).

### 4. Ask-Question Handling
- **v1**: No native support; would be custom per-adapter.
- **v2**: Unified via `ask_question` payload type. Chat SDK bridge renders as Card + Buttons; handles button clicks via `onAction()` callback and updates card to show selection (file:src/channels/chat-sdk-bridge.ts:292–317, 459–486).

### 5. Cold-DM Initiation
- **v1**: Not exposed.
- **v2**: `openDM(userHandle): Promise<string>` allows host to initiate DMs to users without prior message. Adapters that need it (Discord, Slack, Teams) implement; others omit and fall back to direct handle as platformId (file:src/user-dm.ts fallback).

### 6. Async Factory
- **v1**: `ChannelFactory` returns `Channel | null` synchronously.
- **v2**: `ChannelAdapterFactory` returns `ChannelAdapter | Promise<ChannelAdapter> | null`, supporting async credential loading. Registry retries on `NetworkError` (file:src/channels/channel-registry.ts:68–87).

### 7. Lifecycle Promises
- **v1**: `connect()` / `disconnect()` are separate.
- **v2**: `setup()` / `teardown()` grouped; no intermediate "starting/stopping" state. Gateway listeners and webhook servers are started inside `setup()`, torn down inside `teardown()` (file:src/channels/chat-sdk-bridge.ts:149–271, 351–355).

---

## Worth Preserving?

**All v1 patterns are preserved in v2, just restructured:**

1. **Adapter interface model**: v1's optional hooks (`setTyping?`, `syncGroups?`) become v2's optional methods (`setTyping?`, `syncConversations?`, `openDM?`). Structural compatibility for native adapters.

2. **Registry pattern**: v1's `registerChannel(name, factory)` → v2's `registerChannelAdapter(name, registration)`. Same self-registration barrel; v2 adds container config metadata.

3. **Callback-driven message flow**: v1's `onMessage` and `onChatMetadata` callbacks live on as `onInbound` and `onMetadata`. v2 adds `onAction` for interactive features (ask_question buttons).

4. **No built-in state mutation**: v1 adapters own their group state; v2 adapters are stateless (conversations pushed in). Both respect adapter autonomy.

**What's genuinely new and worth keeping:**

- **Chat SDK bridge**: Unifies platform SDKs without duplicating channel adapters per SDK. Huge reduction in code duplication (one Discord adapter instead of native + Chat SDK versions).
- **Structured message payloads**: v2's `kind` field and flexible `content` JSON allow single delivery path for text, edits, reactions, and rich interactions.
- **Ask-question cards**: Native support for interactive approvals and user input, reducing agent-side boilerplate.
- **openDM**: Enables host-initiated contact (onboarding, alerts, approvals) without waiting for inbound.
- **supportsThreads**: Explicit declaration lets router make informed session granularity decisions, vs. hardcoded per-adapter assumptions.

**Minimal migration burden:**

Native adapters written for v1 need only:
1. Rename `connect` → `setup` (add `ChannelSetup` param).
2. Rename `disconnect` → `teardown`.
3. Rename `sendMessage(jid, text)` → `deliver(platformId, threadId, message)` (wrap text in `{ kind: 'chat', content: { text } }`).
4. Add `supportsThreads: boolean`, `name`, `channelType` fields.
5. Add `isConnected()` stub if not already present.
6. Optional: Implement `setTyping?`, `syncConversations?`, `openDM?` for feature parity.

Nothing is fundamentally broken; it's a straightforward refactor of the adapter contract.

