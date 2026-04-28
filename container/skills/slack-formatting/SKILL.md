---
name: slack-formatting
description: Format messages for Slack. Use when responding to Slack channels (folder starts with "slack_" or JID contains slack identifiers). The host adapter converts standard Markdown to Slack mrkdwn on delivery, including native Block Kit table rendering, so write plain Markdown — don't pre-render.
---

# Slack Message Formatting

The NanoClaw host runs your Markdown through the Slack chat-adapter, which converts to Slack mrkdwn and emits Block Kit blocks where they help (tables). **Write standard Markdown.** Don't pre-render to mrkdwn — the adapter does it, and pre-rendering disables Block Kit features.

## How to detect Slack context

- Group folder name starts with `slack_` (e.g., `slack_engineering`, `slack_general`)
- Or `/workspace/group/` path includes a `slack_` prefix

## What renders correctly out of plain Markdown

| Markdown | Renders as | Notes |
|----------|------------|-------|
| `**bold**` | bold | adapter converts to `*bold*` mrkdwn |
| `*italic*` / `_italic_` | italic | adapter converts to `_italic_` |
| `~~strike~~` | strikethrough | adapter converts to `~strike~` |
| `` `inline code` `` | inline code | preserved literally |
| ```` ```code``` ```` | code block | preserved literally, language tag dropped |
| `[text](url)` | named link | adapter converts to `<url|text>` |
| `- item` / `* item` | bullet | adapter renders as `•` |
| `1. item` | numbered list | renders, but bullets are more reliable |
| `> quote` | block quote | adapter renders natively |
| `## Heading` | bold | host pre-rewrites to `**Heading**` |
| Markdown table | Block Kit table | see Tables section below |

## Tables (Block Kit)

Standard Markdown tables render as native Slack Block Kit tables. Write them in plain Markdown:

```
| Service       | Status | Last deploy |
|---------------|--------|-------------|
| API           | live   | Apr 18      |
| Worker        | broken | Apr 20      |
| Web           | live   | Apr 21      |
```

**Constraints — violating these falls back to an ASCII code-block:**

- **Header row + separator required** (`|---|---|---|`). Alignment markers (`:---:`, `---:`) supported.
- **Cell text only** — no bold, italic, links, or inline code inside cells. Block Kit tables treat cells as raw text. If a cell needs formatting, drop the table and use a list.
- **One table per message.** Additional tables in the same message render as ASCII inside a code-fence.

For wide tables (>4 columns) on mobile, prefer a bulleted summary — Block Kit tables have limited horizontal scrolling.

## Mentions

The adapter resolves bare `@username` in your text to a real Slack mention (`<@U…>`). Don't write the raw `<@U…>` form yourself — write `@username`.

For channel-wide pings:
- `@here` notifies active members
- `@channel` notifies everyone

## Emoji

Use standard shortcodes: `:white_check_mark:`, `:x:`, `:rocket:`, `:tada:`. Unicode emoji also work and are auto-shortcoded by Slack.

## What to avoid

- **`---` horizontal rules** — adapter emits literal `---`. Use a blank line for separation.
- **Pre-rendering to mrkdwn** (e.g. writing `*bold*` for bold). The adapter expects standard Markdown; mrkdwn input gets re-parsed and may break links and bold.
- **Raw user-id mentions** (`<@U1234567890>`). Write `@username` and let the adapter resolve.

## Example

```
**Daily standup summary**

_March 21, 2026_

- **Completed:** Fixed authentication bug in login flow
- **In progress:** Building new dashboard widgets
- **Blocked:** Waiting on API access from DevOps

> Next sync: Monday 10am

| Owner | Item | ETA |
|-------|------|-----|
| Alex  | Auth | Apr 22 |
| Bea   | UI   | Apr 24 |

:white_check_mark: All tests passing — [view build](https://ci.example.com/builds/123)
```
