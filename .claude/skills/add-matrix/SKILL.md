---
name: add-matrix
description: Add Matrix channel integration via Chat SDK. Works with any Matrix homeserver.
---

# Add Matrix Channel

Adds Matrix support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Matrix adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/matrix.ts` exists
- `src/channels/index.ts` contains `import './matrix.js';`
- `@beeper/chat-adapter-matrix` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/matrix.ts > src/channels/matrix.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './matrix.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @beeper/chat-adapter-matrix@0.2.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

1. Register a bot account on your Matrix homeserver (e.g., via Element)
2. Get the homeserver URL (e.g., `https://matrix.org` or your self-hosted URL)
3. Get an access token:
   - In Element: **Settings** > **Help & About** > **Access Token** (advanced)
   - Or via API: `curl -XPOST 'https://matrix.org/_matrix/client/r0/login' -d '{"type":"m.login.password","user":"botuser","password":"..."}'`
4. Note the bot's user ID (e.g., `@botuser:matrix.org`)

### Configure environment

Add to `.env`:

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-access-token
MATRIX_USER_ID=@botuser:matrix.org
MATRIX_BOT_USERNAME=botuser
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms." A room can be a group chat or a direct message. Rooms have internal IDs (like `!abc123:matrix.org`) and optional aliases (like `#general:matrix.org`).
- **how-to-find-id**: In Element, click the room name > Settings > Advanced — the "Internal room ID" is the platform ID (starts with `!`). Or use a room alias like `#general:matrix.org`.
- **supports-threads**: partial (some clients support threads, but not all — treat as no for reliability)
- **typical-use**: Interactive chat — rooms or direct messages
- **default-isolation**: Same agent group for rooms where you're the primary user. Separate agent group for rooms with different communities or sensitive contexts.
