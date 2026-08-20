---
name: Observatory
description: Editorial-technical fleet console — near-white canvas, ink text, one vermillion accent, sharp corners.
colors:
  background: "#fafafa"
  surface: "#ffffff"
  foreground: "#27272a"
  foreground-secondary: "#52525b"
  muted-foreground: "#71717a"
  border: "#969696"
  border-soft: "#d4d4d8"
  accent: "#ff5a00"
  accent-on: "#ffffff"
  accent-hover: "#e85200"
  accent-soft: "rgba(255, 90, 0, 0.08)"
  sev-hands: "#c81e1e"
  sev-decision: "#8c6400"
  sev-parked: "#5b4b8a"
  sev-working: "#1f7a4d"
  grid-line: "rgba(150, 150, 150, 0.05)"
typography:
  wordmark:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  eyebrow:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.14em"
  meta:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  button:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  none: "0px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.accent-on}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "10px 10px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "10px 10px"
    height: "44px"
  exception-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    padding: "16px"
  room-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    padding: "12px"
    width: "148px"
  fleet-row:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.none}"
    padding: "14px 0"
  nav-item:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.none}"
    padding: "10px 10px 10px 12px"
---

# Design System: Observatory

## Overview

**Creative North Star: "A blueprint pinned to a studio wall"**

The Observatory reads like a working technical document, not an application
chrome. A near-white sheet carries a faint 30px grid; content sits on it in
white rectangles with hard borders and shadows that offset rather than blur, as
if the paper were physically stacked. Labels are set in uppercase monospace the
way a drawing annotates its own parts. Nothing is rounded, nothing glows,
nothing floats.

Density is deliberately uneven, and that unevenness is the hierarchy. The
exception feed at the top is generous — 16px padding, a 4px severity rule along
the card's top edge, room for a full sentence of title. Below it the fleet list
compresses to single 14px rows with monospace ages hard-right. The reader is
meant to slow at the top and skim below it. The floor plan sits between them as
the one drawn object on the page: outlined zones on a blueprint grid, avatars as
flat geometric marks, an ink-on-white schematic rather than an illustration.

Colour is rationed to the point of austerity. The canvas, the surfaces, the
borders and every piece of text are neutral; one vermillion accent marks what
needs attention and nothing else; four severity colours each stand for exactly
one state and appear only as a card's top rule, a swatch, a status word or a
corner dot. Confirmed rejections: no dark theme (light is the single theme by
the operator's call), no gradients, no soft drop shadows, no rounded corners, no
beige or cream, no decorative motion.

**Key Characteristics:**

- Neutral near-white canvas (`#fafafa`) with a faint 30px blueprint grid
- Deep ink text (`#27272a`), one vermillion accent (`#ff5a00`), nothing else
  interactive-coloured
- 0px radius everywhere — the rectangular silhouette is the brand
- Hard offset shadows (`8px 8px 0`, `4px 4px 0`), never blurred
- Geist Sans for prose and titles, Geist Mono for every label, age and identifier
- Uppercase mono eyebrows introducing each band of content
- Severity as a top-edge rule on a card, never as a background wash

## Colors

A closed neutral palette with a single warm accent and four state colours that
are never used decoratively.

### Primary

- **Vermillion** (`#ff5a00`): the one interactive/attention colour. It marks a
  room on the floor plan that contains exception state, the active tab or
  sidebar item, and the focus ring. It is never a card background, never a
  severity, and never used twice on one card.

### Secondary

The system has no secondary accent by design. Where a second emphasis is
needed, the answer is ink (`#27272a`) as a filled surface — which is what the
primary button is.

### Tertiary

Four severity colours, each bound to exactly one real state:

- **Hands red** (`#c81e1e`): "hands needed" cards, blocked agents, blocked
  status dots. Vermillion-family so it sits inside the palette rather than
  arguing with it.
- **Decision gold** (`#8c6400`): "decision needed" cards. Hue ~43° against the
  accent's ~21°, dark enough to clear AA on white.
- **Parked violet** (`#5b4b8a`): "parked" cards — work nobody is moving.
- **Working green** (`#1f7a4d`): the working status dot and status word.
  Restrained on purpose; it must never read as celebration.

### Neutral

- **Canvas** (`#fafafa`): the page. Neutral, never warm.
- **Surface** (`#ffffff`): every card, panel, room, sidebar and tab bar.
- **Ink** (`#27272a`): all primary text, the primary button fill, the floor
  plan's outer building outline.
- **Ink secondary** (`#52525b`): descriptions, the current-activity line under
  an agent's name, schematic detail strokes.
- **Muted** (`#71717a`): eyebrows, ages, timestamps, "empty" labels, inactive
  nav.
- **Border** (`#969696`): card and room outlines, structural lines.
- **Border soft** (`#d4d4d8`): list separators, the sticky header's underline,
  the corridor divider.

### Named Rules

**The One Voice Rule.** Vermillion answers one question — *is something wrong
here* — and appears on well under a tenth of any screen. A room outlined in
vermillion means that room contains exception state. If the accent ever reads as
decoration, it has stopped meaning anything.

**The Four States Rule.** There are exactly four severity colours and each maps
to one state. A fifth colour is not a new shade; it is a claim that a fifth
state exists, and it must be justified in the data first.

## Typography

**Display Font:** Geist Sans (with `system-ui, -apple-system, Segoe UI, sans-serif`)
**Body Font:** Geist Sans (same stack)
**Label/Mono Font:** Geist Mono (with `ui-monospace, SFMono-Regular, Menlo, monospace`)

Both faces are self-hosted through pinned `@fontsource-variable` packages — the
page sits behind auth and must not request an asset from a third party on load.

**Character:** Geist is a neutral, slightly technical grotesque; its mono
companion shares the same skeleton, so switching between them changes register
without changing voice. The pairing reads as engineering documentation rather
than as marketing.

### Hierarchy

- **Wordmark** (700, 19px, -0.04em): "Observatory" in the mobile header and
  desktop sidebar. The only place tracking goes negative.
- **Card title** (700, 16px mobile / 14px desktop, 1.35): an exception card's
  one-sentence statement of what is wrong. The largest prose on the page.
- **Body** (400, 14px, 1.65): everything written in sentences. Never bolded for
  emphasis — hierarchy comes from size and surface, not weight.
- **Row name** (700, 14px): an agent's persona name in the fleet list.
- **Eyebrow** (700, 11px, 0.14em, uppercase, mono): the label above each band —
  "NEEDS ATTENTION (3)", "OFFICE", "FLEET". Also room labels on the floor plan
  and in the room strip.
- **Button** (700, 11px, 0.06em, uppercase, mono): every button label.
- **Meta** (400, 11px, mono): ages, timestamps, "Updated 12s ago", scope lines,
  identifiers, cron expressions.

### Named Rules

**The Mono-Means-Machine Rule.** Monospace marks anything the machine owns: an
identifier, a duration, a cron expression, a state label, a button's verb.
Anything a person would say out loud is Geist Sans. A sentence never mixes them.

**The Flat-Body Rule.** Body copy stays at weight 400. Emphasis is a different
size, a different surface, or the muted tier — never a bold run inside a
sentence.

## Layout

Mobile-first at 390px, with the desktop layout appearing at 980px. There is no
tablet-specific composition; the phone layout simply widens.

**Mobile.** One column, 16px page gutters. A sticky top bar carries the wordmark,
the last-updated stamp and a scope/stat line. Below it, bands stack in a fixed
order: needs attention → office (horizontally scrolling room strip) → fleet.
A fixed bottom tab bar (62px) holds four destinations; the page reserves 76px of
bottom padding so the last row is never trapped under it. The room strip is the
only horizontal scroll on the page — nothing else may overflow the viewport
width.

**Desktop (≥980px).** A 220px sticky sidebar holds the wordmark, scope line,
vertical nav and a fleet count; the main column takes the rest up to 1080px of
content width with 32px gutters. The top bar becomes a single thin stat strip.
The exception feed turns from a stack into a row of equal-width cards. The room
strip is replaced entirely by the floor-plan panel — the mobile office band is
hidden as a whole section, not just its inner list, so no orphan eyebrow is left
above the plan.

**Spacing rhythm.** 4 / 8 / 12 / 16 / 24 / 32. Bands get 24px vertical padding on
mobile and 20px on desktop; cards get 16px inside on mobile and 14px on desktop;
gaps inside a card are 8–12px. Section separation is carried by the eyebrow and
the surface change, not by large empty runs — this is a console, not a landing
page, and the tom-modern 96px section rhythm is deliberately not used here.

## Elevation & Depth

Depth comes from surface contrast first — white cards on a near-white gridded
canvas, separated by a 1px `#969696` border — and from hard offset shadows
second. Shadows never blur. They are drawn as a solid grey rectangle offset down
and right, the way a paste-up casts an edge, and they carry no alpha gradient.

### Shadow Vocabulary

- **Soft** (`box-shadow: 4px 4px 0 rgba(150,150,150,0.1)`): the default resting
  state for a small card — room cards in the strip.
- **Hard** (`box-shadow: 8px 8px 0 rgba(150,150,150,0.12)`): the emphasis state
  — exception cards and the floor-plan panel, the two things the page most wants
  read.

### Named Rules

**The No-Blur Rule.** Every shadow in this system has a blur radius of 0. A
blurred or spread shadow is a different design system wearing this one's colours.

## Shapes

Every corner is square. `--radius` is `0px` and the shadcn radius scale is
mapped to it wholesale, so no vendored component can quietly reintroduce a
rounded edge.

The recurring silhouette is the outlined rectangle: a 1px `#969696` border with
a white fill. Severity is expressed by thickening the *top* edge of that
rectangle to 4px in the severity colour — the card keeps its neutral surface and
gains a coloured rule, rather than being tinted. Rooms on the floor plan are the
same rectangle at a larger scale, with a 3px vermillion border replacing the 2px
grey one when the room contains exception state.

The two exceptions to squareness are both circles and both tiny: the 11px status
dot on an avatar (2px surface-coloured ring, so it reads as a cut-out) and the
6–8px dots used in status legends. Avatars themselves are square marks — flat
geometric glyphs on a solid ground, sized 30px in a room card, 36px in a fleet
row, 40px on the floor plan and on desktop fleet rows.

## Components

### Buttons

- **Shape:** square (0px), 1px border, minimum 44px hit height at mobile.
- **Primary:** ink fill (`#27272a`), white label, 1px ink border. Uppercase mono
  at 11px/0.06em, 10px padding, centered. Used for the action that resolves the
  card.
- **Hover / Focus:** hover deepens the accent for accent-coloured elements;
  focus is a 2px vermillion ring, always visible, never suppressed.
- **Secondary:** transparent fill, ink label, 1px `#969696` border. Sits beside
  the primary at equal width — an exception card's two actions split the row.
- **Disabled:** a button whose required identifier is missing is rendered
  disabled with a title explaining why, rather than omitted or silently dead.

### Chips

- **Style:** white surface, 1px `#969696` border, uppercase mono label, square.
- **State:** selected chips take the ink fill; the accent is not used for chip
  selection, because it is reserved for exception state.

### Cards / Containers

- **Corner Style:** 0px.
- **Background:** `#ffffff` on the `#fafafa` gridded canvas.
- **Shadow Strategy:** soft by default, hard for exception cards and the
  floor-plan panel (see Elevation).
- **Border:** 1px `#969696`; exception cards add a 4px top border in their
  severity colour; a room containing exception state swaps its border to
  vermillion.
- **Internal Padding:** 16px mobile / 14px desktop for exception cards, 12px for
  room cards, 24px mobile / 16px desktop for the floor-plan panel.

### Inputs / Fields

- **Style:** white fill, 1px `#969696` border, 0px radius, 44px minimum height.
- **Focus:** border shifts to vermillion plus the 2px focus ring. No glow.
- **Error / Disabled:** an error states its reason in words beneath the field in
  the hands-red tier; disabled fields keep the border and drop to muted text.

### Navigation

- **Mobile:** a fixed bottom tab bar, white on a 1px `#d4d4d8` top border, 62px
  tall, four equal targets. Each is an 18px line icon over a 10px uppercase mono
  label. The active tab colours icon, label and a 2px top border vermillion.
- **Desktop:** a 220px sticky white sidebar with a 1px right border. Nav items
  are 12px uppercase mono with a 16px icon, a transparent 3px left border and a
  10px inset. The active item takes the vermillion left border, an
  `accent-soft` background wash and ink text.
- Both states are driven by the current route; hover on desktop lifts the label
  from secondary to ink without moving anything.

### Exception card (signature component)

The page's front door and the only component allowed to state a problem in a
full sentence. Vertical stack: severity line (an 8px square swatch plus the
uppercase mono severity name, both in the severity colour), then the title in
Geist Sans 700/16px, then the age in mono muted ("Waiting 2h 14m", "Idle 9d"),
then a row of two equal-width buttons. The 4px top border carries the severity
colour; everything else on the card stays neutral. On desktop the stack becomes
a row of equal cards; the card's internals do not change shape, only tighten.

### Floor plan (signature component)

An inline SVG schematic on a 20px blueprint-grid pattern: a 3px ink outer
building outline, a dashed `#d4d4d8` corridor divider, and one outlined
rectangle per room with an uppercase mono label inset at its top-left. Occupants
are 40px avatar marks in a row with a 10px status square notched at the
bottom-right, ringed in white. An empty room says "EMPTY" in centred muted mono
rather than rendering nothing. Rooms never move: geometry is authored constants,
and only occupancy comes from data.

### Vignette

The floor plan's one animated element, and it animates only because something is
actually happening: three SVG wisp strokes rise from a room's fixture while that
room's bound signal is live. The base state is a visible steady stroke, so a
single-frame capture always shows real smoke. Under `prefers-reduced-motion:
reduce` the wisps stay present and stop moving — the state is information, the
drift is presentation. A room with no active signal renders nothing at all.

## Do's and Don'ts

### Do:

- **Do** keep vermillion (`#ff5a00`) for exception state, the active nav item
  and focus rings only — the One Voice Rule.
- **Do** express severity as a 4px top border plus a matching swatch and label,
  leaving the card surface white.
- **Do** set every label, age, identifier and button verb in Geist Mono,
  uppercase, at 0.06–0.14em tracking.
- **Do** keep `--radius` at `0px` and map the whole radius scale onto it.
- **Do** use `4px 4px 0` for a resting card and `8px 8px 0` for an emphasised
  one, both with zero blur.
- **Do** give every interactive target at least 44×44px at 390px.
- **Do** render an explicit empty state in muted mono ("EMPTY", "All clear")
  wherever a container can legitimately hold nothing.
- **Do** keep the room strip the only horizontally scrolling element; the page
  body never scrolls sideways at 390px.

### Don't:

- **Don't** introduce a fifth severity colour, or reuse an existing one for a
  second meaning.
- **Don't** tint a card's background to show state — the top rule does that job.
- **Don't** add a blurred, spread or soft drop shadow anywhere.
- **Don't** round a corner, including on vendored shadcn components.
- **Don't** animate anything that is not reporting live state, and never remove
  an active indicator under reduced motion — freeze it instead.
- **Don't** bold body copy or drop ink to a lower opacity for hierarchy; change
  size, surface, or move to the muted tier.
- **Don't** put a warm background (beige, cream) behind anything — the canvas is
  neutral `#fafafa`.
- **Don't** render an agent's infrastructure name where its persona name
  belongs, or invent an avatar for an agent that has none.
