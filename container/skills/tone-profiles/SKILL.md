---
name: tone-profiles
description: How the tone profile system works — when to call get_tone_profile, available profiles, per-response vs per-session overrides. Use when the user asks about tone, voice, writing style, or when you need to understand the profile system for content drafting. The global CLAUDE.md already instructs you to call get_tone_profile for emails — this skill has the full reference.
---

# Tone Profiles

Two concepts in the system:

1. **Tone profiles** — voice and personality (formality, structure, greeting style, anti-patterns). Your default is injected at boot.
2. **Writing rules** — how to write like a human, not an AI (banned vocabulary, structural patterns). Loaded automatically with any profile via `get_tone_profile`.

The boot-injected tone is for casual conversation. Any created content beyond chat needs human-voice treatment via `get_tone_profile` — the profiles exist so your writing sounds human, not so you impersonate the user.

## When to call `get_tone_profile`

**Any created content** — call `get_tone_profile("selection-guide")` first to pick the right profile, then load it. Writing rules (banned AI vocabulary, structural patterns) bundle automatically. Applies to: emails, pitches, reports, proposals, creative content, social posts, rejection letters, any text with an audience beyond casual chat.

**Tone override** — user says "use X tone": load the requested profile. If no file exists, treat X as an ad-hoc style hint.

**Casual conversation** — don't call. Your boot-injected default is sufficient.

## Overrides

- **Per-response** ("use X tone for this message"): applies once, reverts on next message.
- **Per-session** ("switch to X tone"): persists for the thread.

## Available Profiles

`list_tone_profiles` shows current profiles. Known: professional, collaborative, direct, engineering, assistant, spark, reel, medieval.
