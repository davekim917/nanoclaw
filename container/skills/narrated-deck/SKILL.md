---
name: narrated-deck
description: Turn any finding, report, recap, or update into a narrated presentation — visual slides with an AI voiceover the user presses play on and can speed up. Produces an MP4 (plays inline in chat, including on phones) and a self-contained HTML player (1×–2× speed, slide skip, transcript). Use whenever someone asks to "present this to me", "narrate it", "walk me through it", "read it out", "give me a voiceover / audio version", "make a narrated deck", or wants to listen to an output instead of reading it — for any task, ad hoc or scheduled.
---

# Narrated deck

You write a **deck spec**: a list of slides, each with a short visual and the
narration spoken over it. `render-deck.mjs` voices the narration with
ElevenLabs, renders each slide to a 1920×1080 image, and builds the outputs.

The listener is usually on a phone, half-watching. **The voice carries the
explanation; the slide is the anchor.** Anything the listener must understand
goes in the narration. The slide shows the one number, chart or table that
the sentence is about.

## Workflow

1. **Script first.** Before any markup, write the narration for every slide as
   if you were an analyst walking an executive through the material in person.
   Order: the headline answer → what moved and why → the detail that matters →
   decisions made / what needs the listener. Cut everything else.
2. **Design each slide to support its paragraph** — one visual per slide (see
   *Slide rules*).
3. **Write the spec** to a durable path the user's siblings can reach:
   `/workspace/workgroup/artifacts/decks/<slug>/deck.json`.
4. **Preview silently** — no voice credits spent:
   ```bash
   node /app/skills/narrated-deck/render-deck.mjs /workspace/workgroup/artifacts/decks/<slug>/deck.json --silent --no-mp4 --no-html
   ```
   Open every `slides/NN.png` it lists and look at it. Fix overflow warnings,
   crowding, and anything you would not want to read on a phone.
5. **Render for real:**
   ```bash
   node /app/skills/narrated-deck/render-deck.mjs /workspace/workgroup/artifacts/decks/<slug>/deck.json
   ```
   Add `--speed 1.5` when delivering to **Discord** — its video player has no
   speed control, so a pre-sped cut is the only way to listen faster inline.
   Unchanged narration is cached, so re-rendering after a visual fix is free.
6. **Deliver** with `send_file`: the `.mp4` first (it plays inline on every
   device), then the `.html` player, then the `-1.5x.mp4` if you made one.
   Caption: the one-line headline plus the running time, e.g.
   `Weekly review w/e 9/26 — $4.2M gross, −$0.1M vs forecast. 2:18 narrated.`
   Never send only the files: the caption must carry the headline so the user
   can triage without pressing play.

The command prints a JSON summary: output paths and sizes, total duration,
characters billed, cache hits, and `warnings`. **Read `warnings` every time** —
overflowing slides and files over the ~10 MB chat upload cap are reported
there, not as failures.

## Deck spec

```json
{
  "title": "Weekly review — week ending Sep 26",
  "subtitle": "optional — shown in the player header",
  "theme": "dark",
  "voice": "optional ElevenLabs voice_id",
  "slides": [
    { "label": "The headline", "narration": "…", "html": "<div class=\"kicker\">…</div>…" },
    { "label": "Trend", "narration": "…", "image": "chart.png" },
    { "label": "Status card", "narration": "…", "jsonRender": { "root": "frame", "elements": { } } }
  ]
}
```

- Each slide needs `narration` and **exactly one** visual: `html` (a fragment
  using the classes below), `image` (a PNG/JPG path, relative to the spec),
  or `jsonRender` (a json-render spec — see below).
- `label` is the slide's name in the player's chapter list. Keep it to 2–5 words.
- `theme`: `dark` (default) or `light`.
- A complete working spec: `/app/skills/narrated-deck/example-deck.json`.
  Copy it rather than starting from nothing.

## Slide rules

- **One idea, one visual.** A big number, KPI tiles, bars, a small table, or a
  callout. Not two of them competing.
- **≤ 12 words of prose on screen**, not counting numbers and labels. No
  paragraphs, ever — that text belongs in the narration.
- **Tables: ≤ 5 rows × ≤ 4 columns**, numbers right-aligned, one column that
  carries the verdict (green ahead / red behind). Highlight the row the
  narration is about with `class="hl"`.
- **Every number states its comparison basis** on screen (`vs forecast`, `vs plan`,
  `vs LY`) when it is a delta.
- Colour means direction only: `up` = good, `down` = bad. Don't decorate with it.
- 4–10 slides is the normal range. Past ~12, split into two decks.

## Narration rules — write for the ear

- **Lead with the answer.** First sentence of the deck = the headline result.
- **Don't read the slide.** Say the *so what* the visual can't: why it moved,
  what it means, what happens next.
- **15–45 seconds per slide** (≈ 40–110 words). A deck should run 2–6 minutes.
- **Spell out what a voice would mangle.** The TTS reads text literally:

  | Written | Say instead |
  |---|---|
  | `$4.2M` | four point two million dollars |
  | `-$308K` | three hundred eight thousand behind |
  | `9/23` | September twenty-third |
  | `3+9`, `A/B` | three-plus-nine, A-B |
  | `CAC`, `NCs`, `AOV`, `LE` | acquisition cost, new customers, order value, latest estimate |
  | an acronym said as letters (`QBR`) | Q-B-R |

- **Round in speech, keep precision on screen.** Say "about three hundred
  thousand"; show `−$308K`.
- **End with what needs the listener** — a decision, an ask, or "nothing needs
  you this week".

## Accuracy

A narrated deck sounds authoritative, so an error in one is worse than in a doc.

- Every figure on a slide or in the narration comes from the source you were
  given. If you compute a new figure (a sum, a share), say so in the narration.
- Carry the source's hedges into the voice ("preliminary", "per the flash",
  "one team hasn't reported yet").
- If the source is ambiguous (a figure missing its unit, two sources
  disagreeing), say it out loud rather than picking one silently.

## Slide components (`theme.css`)

Everything is sized for a 1920×1080 canvas that will be viewed on a phone.
The slide content is vertically centred; a footer with the deck title and
slide number is added for you.

```html
<!-- Kicker + title -->
<div class="kicker">Company · week ending Sep 26</div>
<h2>Wholesale dragged; Direct and Retail offset</h2>   <!-- h1 for a title slide -->
<p class="lede">One muted supporting line.</p>

<!-- One huge number -->
<div class="big"><div class="v">$4.2M</div><div class="l">gross revenue</div></div>

<!-- KPI tiles (2–4) -->
<div class="kpis">
  <div class="kpi"><div class="l">Gross</div><div class="v">$4.2M</div><div class="d down">−$0.1M vs forecast</div></div>
</div>

<!-- Horizontal bars: --w is the bar length as a % of the largest magnitude -->
<div class="bars">
  <div class="bar down"><span class="l">Wholesale</span><span class="track"><i style="--w:100%"></i></span><span class="v down">−$49K</span></div>
  <div class="bar up"><span class="l">Retail</span><span class="track"><i style="--w:82%"></i></span><span class="v up">+$40K</span></div>
</div>

<!-- Scannable table -->
<table class="scan">
  <thead><tr><th>Vertical</th><th class="n">Revenue</th><th class="n">vs forecast</th></tr></thead>
  <tbody><tr class="hl"><td>Wholesale</td><td class="n">$1.2M</td><td class="n down">−1.7%</td></tr></tbody>
</table>

<!-- Callout and short points (≤ 3) -->
<div class="callout warn">Hold the forecast — one order slipped.</div>   <!-- up | down | warn -->
<ul class="points"><li>Revisit if the order hasn't landed by Oct 15</li></ul>

<!-- Layout -->
<div class="cols"> … </div>        <!-- two equal columns; .cols.wide-left = 3:2 -->
<div class="row"> … </div>         <!-- inline row; <span class="tag up">+$0.2M vs plan</span> -->
```

Text utilities: `.up .down .flat .warn .accent .muted`.

The theme is a starting point, not a constraint. When the user asks for a
different look (brand colours, a light theme, another typeface), put a
`<style>` block or inline styles in the fragments. Web fonts load at render
time, e.g. `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=block">`.
Use `display=block` so the screenshot waits for the font. If the user wants
the look kept, save it to memory and reuse it on their next deck. For a line or area
chart, write inline `<svg>` in the fragment (size it to the slide), or render a
PNG with any tool you have and use an `image` slide.

## json-render slides

If the json-render plugin is mounted (`/workspace/plugins/json-render`) and you
already produce a card with it — a recurring status or scoreboard card — you
can drop that spec in as a slide with `"jsonRender": { …spec… }`. Set the
root Frame to `width: 1920, height: 1080`; other sizes are letterboxed. The
renderer validates the spec with the plugin before rendering. For anything
else, `html` slides are more capable: json-render has no tables or charts.

## Voice and cost

- Default voice: **Will** (`bIHbv24MWmeRgasZH58o`, relaxed, American male).
  Set `"voice"` in the spec to change it; list the account's voices with
  `curl -sS https://api.elevenlabs.io/v1/voices`. Keep one voice per deck.
  If the user names a preferred voice, save it to memory and reuse it.
- Model: `eleven_multilingual_v2`. Each slide is voiced with its neighbours'
  text as context, so intonation carries across slide boundaries.
- Billing is per character of narration: a 5-minute deck is ~4,500
  characters. `--silent` previews cost nothing, and the per-deck cache
  (`<out>/.tts-cache/`) means only changed narration (and its immediate
  neighbours) is re-voiced.
- Narration text is sent to ElevenLabs. The operator has approved that for the
  fleet's business data; if a user flags material as too sensitive for a
  third party, render `--silent` and say the voice step was skipped.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ElevenLabs TTS failed: HTTP 401` | This group isn't granted the `ElevenLabs` secret, or the key lacks text-to-speech permission. Report it to the operator; don't retry. (`GET /v1/user` returns 401 by design — the key has no `user_read`; it is not a useful credential test.) |
| `content overflows the slide` warning | Too much on the slide. Cut rows or words; don't shrink the type. |
| `… over the ~10 MB chat upload cap` warning | Deck too long for chat. Split it, or send the HTML only if it fits. |
| `chromium exited …` | Usually malformed HTML in a fragment. Check the slide's `slides/NN.html`. |
| Silent-preview timing differs from the real render | Expected: `--silent` estimates duration from word count. |

## Relation to other skills

- **remotion** — animated, motion-designed video. Use it when the video itself
  is the product (demos, marketing). A narrated deck is a briefing; this skill
  is faster and cheaper for that.
- **design-artifact-loop** — one-off UI/page design judged on taste.
- **json-render** — a single static card image; can feed a slide here.
