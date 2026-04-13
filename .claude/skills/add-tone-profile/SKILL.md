---
name: add-tone-profile
description: Create a new tone profile for email drafting or agent personality. Guides through writing style analysis, profile creation, and integration with the selection guide and group defaults.
---

# Add Tone Profile

This skill creates a new tone profile by analyzing writing samples, defining voice characteristics, and integrating the profile into the tone system.

## Overview

Tone profiles live at `tone-profiles/` in the repo root. Each is a markdown file defining voice, structure, sample phrases, and anti-patterns. The selection guide (`tone-profiles/selection-guide.md`) routes agents to the right profile, and group defaults are set in `groups/global/CLAUDE.md`.

## Phase 1: Understand the Profile

Use `AskUserQuestion` to gather requirements:

1. **What is this profile for?** (e.g., "a fun tone for Slack with engineers", "formal tone for investor emails", "a pirate voice for laughs")
2. **Whose voice is it?** Dave's voice (for emails/messages sent as Dave) or the agent's own voice (for responses in channels)?
3. **Who is the audience?** (engineers, executives, friends, specific team, etc.)
4. **Should it be a group default or override-only?** If group default, which groups?
5. **Any specific traits or constraints?** (e.g., "playful but not silly", "use emojis", "no corporate jargon")
6. **Do you want me to analyze existing writing samples first?** If yes, ask where to find them (Discord channels, Slack threads, email accounts, or paste examples directly).

## Phase 2: Analyze Writing Samples (Optional)

If the user wants the profile based on real writing patterns:

### From Discord/Slack Messages
- Use `mcp__nanoclaw__search_threads` and `mcp__nanoclaw__read_thread` to find messages from the target voice
- Analyze 30-50+ messages for patterns:
  - Greeting and sign-off style
  - Sentence structure and length
  - Formality level (1-5 scale)
  - Punctuation habits
  - Common phrases and vocabulary
  - What they NEVER do (anti-patterns)

### From Email
- If Gmail MCP tools are available, search `in:sent` for the relevant account
- Read 20-30 sent emails with substantive content
- Same pattern analysis as above

### From Pasted Examples
- The user pastes 5-10 sample messages/emails
- Extract the same patterns

Summarize findings before proceeding to confirm accuracy.

## Phase 3: Write the Profile

Create a new file at `tone-profiles/{profile-name}.md` following this template:

```markdown
# Tone Profile: {Name}

**Use for:** {When to use this profile — audience, context, channels}

## Voice

{2-3 sentence description of the voice. What does it sound like? What's the personality?}

## Formality: {1-5}/5

## Structure

- {How sentences are structured}
- {Paragraph length}
- {List usage}
- {Any formatting preferences}

## Greeting

{Default greeting, or "None"}

## Sign-off

{Default sign-off, or "None"}

## Emoji Usage

{If agent voice: describe emoji policy. If human voice: "No emojis in composed text."}

## Sample Phrases

- "{Example 1}"
- "{Example 2}"
- "{Example 3}"
- "{Example 4}"
- "{Example 5}"
- "{Example 6}"

## Anti-Patterns (NEVER use)

- {Thing to avoid 1}
- {Thing to avoid 2}
- {Thing to avoid 3}
```

For human-voice profiles, omit the Emoji Usage section (no emojis is the default). For agent-voice profiles, include it.

For humor/novelty profiles (like medieval), add a note that it's override-only and should not be a group default.

## Phase 4: Update the Selection Guide

Edit `tone-profiles/selection-guide.md`:

1. **Add to the selection table** (if the profile maps to a specific recipient type or context)
2. **Add to per-response overrides** — what phrases activate this profile (e.g., "use pirate tone", "make this formal")
3. **Add to the correct universal rules section** — Human Voice or Agent's Voice. If it's a humor/override-only profile, add a note under the Medieval section.

## Phase 5: Update Group Defaults (if applicable)

If the profile should be a group default:

1. Edit `groups/global/CLAUDE.md`
2. Find the "Group Defaults" table under "## Tone Profiles"
3. Update the relevant group rows to point to the new profile

## Phase 6: Commit and PR

```bash
git add tone-profiles/{profile-name}.md tone-profiles/selection-guide.md
git add groups/global/CLAUDE.md  # if group defaults changed
git commit -m "feat: add {profile-name} tone profile"
git push
```

Open a PR with a summary of the new profile, its intended use, and any group default changes.

## Existing Profiles (Reference)

| Profile | File | Voice | Formality |
|---------|------|-------|-----------|
| Professional | `professional.md` | Human | 3/5 |
| Collaborative | `collaborative.md` | Human | 2/5 |
| Direct | `direct.md` | Human | 1/5 |
| Engineering | `engineering.md` | Agent | 1.5/5 |
| Assistant (Jarvis/Friday) | `assistant.md` | Agent | 1.5/5 |
| Medieval | `medieval.md` | Agent | 5/5 (humor) |

## Key Files

| File | Purpose |
|------|---------|
| `tone-profiles/*.md` | Individual profile definitions |
| `tone-profiles/selection-guide.md` | Routing logic, overrides, universal rules |
| `groups/global/CLAUDE.md` | Group default assignments |
