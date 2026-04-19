---
name: add-github
description: Add GitHub channel integration via Chat SDK. PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support via the Chat SDK bridge. The agent participates in PR and issue comment threads.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the GitHub adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/github.ts` exists
- `src/channels/index.ts` contains `import './github.js';`
- `@chat-adapter/github` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/github.ts > src/channels/github.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './github.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/github@4.26.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

> 1. Go to [GitHub Settings > Developer Settings > Personal Access Tokens](https://github.com/settings/tokens)
> 2. Create a **Fine-grained token** with:
>    - Repository access: select the repos you want the bot to monitor
>    - Permissions: **Pull requests** (Read & Write), **Issues** (Read & Write)
> 3. Copy the token
> 4. Set up a webhook on your repo(s):
>    - Go to **Settings** > **Webhooks** > **Add webhook**
>    - Payload URL: `https://your-domain/webhook/github`
>    - Content type: `application/json`
>    - Secret: generate a random string
>    - Events: select **Issue comments**, **Pull request review comments**

### Configure environment

Add to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `github`
- **terminology**: GitHub has "repositories" containing "pull requests" and "issues." Each PR or issue comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `owner/repo` (e.g. `acme/backend`). Each PR/issue becomes its own thread automatically.
- **supports-threads**: yes (PR and issue comment threads are native conversations)
- **typical-use**: Webhook/notification — the agent receives PR and issue events and responds in comment threads
- **default-isolation**: Typically shares a session with a chat channel (e.g. Slack) so the agent can summarize PRs and respond to reviews in the same context. Use a separate agent group if the repo contains sensitive code that other channels shouldn't access.
