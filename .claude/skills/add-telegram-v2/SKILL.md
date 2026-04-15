---
name: add-telegram-v2
description: Add Telegram channel integration to NanoClaw v2 via Chat SDK.
---

# Add Telegram Channel

Adds Telegram bot support to NanoClaw v2 using the Chat SDK bridge.

## Pre-flight

Check if `src/channels/telegram.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

### Install the adapter package

```bash
npm install @chat-adapter/telegram
```

### Enable the channel

Uncomment the Telegram import in `src/channels/index.ts`:

```typescript
import './telegram.js';
```

### Build

```bash
npm run build
```

## Credentials

### Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts:
   - Bot name: Something friendly (e.g., "NanoClaw Assistant")
   - Bot username: Must end with "bot" (e.g., "nanoclaw_bot")
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

**Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:

1. Open `@BotFather` > `/mybots` > select your bot
2. **Bot Settings** > **Group Privacy** > **Turn off**

### Configure environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `telegram`
- **terminology**: Telegram calls them "groups" and "chats." A "group" has multiple members; a "chat" is a 1:1 conversation with the bot.
- **how-to-find-id**: Do NOT ask the user for a chat ID. Telegram registration uses pairing — run `npx tsx setup/index.ts --step pair-telegram -- --intent <main|wire-to:folder|new-agent:folder>`, show the user the 4-digit `CODE` from the `PAIR_TELEGRAM_ISSUED` block (follow the `REMINDER_TO_ASSISTANT` line in that block), and tell them to send just the 4 digits as a message from the chat they want to register (DM the bot for `main`, post in the group otherwise). In groups with Group Privacy ON, prefix with the bot handle: `@<botname> CODE`. Wrong guesses invalidate the code — if a `PAIR_TELEGRAM_ATTEMPT` block arrives with a mismatched `RECEIVED_CODE`, a `PAIR_TELEGRAM_NEW_CODE` block will follow automatically (up to 5 regenerations); show the new code. On `PAIR_TELEGRAM STATUS=failed ERROR=max-regenerations-exceeded`, ask the user if they want to try again and re-invoke the step — each invocation starts a fresh 5-attempt batch. Success emits `PAIR_TELEGRAM STATUS=success` with `PLATFORM_ID`, `IS_GROUP`, and `ADMIN_USER_ID`. The service must be running for this to work (the polling adapter is what observes the code).
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.
