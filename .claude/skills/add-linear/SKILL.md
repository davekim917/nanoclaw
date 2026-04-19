---
name: add-linear
description: Add Linear channel integration via Chat SDK. Issue comment threads as conversations.
---

# Add Linear Channel

Adds Linear support via the Chat SDK bridge. The agent participates in issue comment threads.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Linear adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/linear.ts` exists
- `src/channels/index.ts` contains `import './linear.js';`
- `@chat-adapter/linear` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/linear.ts > src/channels/linear.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './linear.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/linear@4.26.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

> 1. Go to [Linear Settings > API Keys](https://linear.app/settings/account/security/api-keys/new)
> 2. Create a **Personal API Key** (or use an OAuth application for team-wide access)
> 3. Copy the API key
> 4. Set up a webhook:
>    - Go to **Settings** > **API** > **Webhooks** > **New webhook**
>    - URL: `https://your-domain/webhook/linear`
>    - Select events: **Comment** (created, updated)
>    - Copy the signing secret

### Configure environment

Add to `.env`:

```bash
LINEAR_API_KEY=lin_api_...
LINEAR_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `linear`
- **terminology**: Linear has "teams" containing "issues." Each issue's comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is your team key (e.g. `ENG`). Find it in Linear under Settings > Teams. Each issue becomes its own thread automatically.
- **supports-threads**: yes (issue comment threads are native conversations)
- **typical-use**: Webhook/notification — the agent receives issue comment events and responds in threads
- **default-isolation**: Typically shares a session with a chat channel (e.g. Slack) so the agent can discuss issues in the same context as team chat. Use a separate agent group if the Linear team tracks sensitive work.
