# atrium — one light system for the whole dashboard

## The problem this replaces

The dashboard currently speaks two languages. The inbox, session detail and
scheduled board are a dark terminal-style control surface (`color-scheme: dark`,
near-black oklch surfaces, uppercase letterspaced mono chrome). The Observatory
is a warm light retro office (hard ink outlines, zero-blur shadows, radii 0).
Tapping from one into the other is a hard cut between two products.

Neither survives. **One light system, every page.**

## The apparent conflict, resolved

"Modern minimalist" and "Gather Town visuals" sound contradictory only if you
assume Gather is a retro *app*. It isn't. Gather's chrome — its toolbars,
panels, menus, modals — is flat, light, rounded and quiet. The pixel art is the
**map**, and only the map.

That is exactly the split this system takes:

> **The office floor is the only illustrated surface in the product.
> Everything else is modern minimal light UI.**

The previous direction (office-16) got this backwards. It themed the *chrome*
retro — SNES menu borders, hard shadows, uppercase mono labels — and let that
language leak outward. That is what "Munder Difflin isn't cutting it" is
pointing at: the costume was on the wrong layer.

So this system has two zones with one palette:

| | Chrome (every page) | The map (office only) |
|---|---|---|
| Shapes | rounded 10px, hairline borders | pixel sprites, integer grid |
| Depth | one soft ambient shadow | flat, ambient contact shadows |
| Edges | 1px `--line`, never ink | no black outlines at all |
| Type | sans, sentence case | labels use the chrome's sans |

## Palette (light, warm neutral — never stark white)

Surfaces
- `--bg` `#faf9f7` — page. Warm off-white; pure `#fff` reads clinical and
  makes every card float.
- `--surface` `#ffffff` — cards, panels, sheets.
- `--surface-2` `#f2f0ec` — inset wells, hover, table stripes.
- `--line` `#e6e2dc` — hairline borders, 1px.
- `--line-2` `#d3cec6` — stronger dividers, focus rings.

Text
- `--ink` `#1c1a17` — primary.
- `--ink-2` `#5f5952` — secondary, labels.
- `--ink-3` `#8f887f` — tertiary, timestamps, placeholders.

Accent — exactly one, used for interaction only, never decoration
- `--accent` `#3f6f5b` — muted deep green. Links, focus, primary action,
  selected state.
- `--accent-soft` `#e8f0eb` — accent-tinted fill.

Status — muted, never neon. These are the ONLY colours that carry state.
- `--stop` `#b4483c` blocking · `--stop-soft` `#fbeceb`
- `--warn` `#b5822c` waiting on a person · `--warn-soft` `#fbf3e4`
- `--go` `#3f7d54` working now · `--go-soft` `#eaf3ed`
- `--idle` `#8f887f` nobody / asleep · `--idle-soft` `#f2f0ec`

Map-only zone tints — soft, desaturated, and deliberately NOT in the status
set, so a room's identity can never be misread as a room's state.
- `#dcd3e8` `#cfdce8` `#cfe0da` `#ecd9c6` `#e6e2c4` `#d6dfe4`

## Type

System stack only, no web fonts.

```
--sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
```

- **Sentence case everywhere.** No `text-transform: uppercase` in chrome.
- **Normal tracking.** No `letter-spacing` on body or labels. The current
  `letter-spacing: 0.14em; text-transform: uppercase` mono chrome is the single
  biggest reason the app reads as a 2010s terminal skin.
- Mono is reserved for **identifiers only** — issue ids, SHAs, session ids,
  cron expressions. Never for labels, headings, buttons or nav.
- Scale: 12 / 13 / 15 / 18 / 24 / 32. Weights 400 and 600 only.
- Numerals in summaries use `font-variant-numeric: tabular-nums`.

## Depth and shape

- Radii: `--r` 10px on cards and sheets, 8px on controls, 6px on chips.
  Never 0, never pill-shaped except avatars.
- **One shadow token**: `--shadow: 0 1px 2px rgb(28 26 23 / .04), 0 4px 12px rgb(28 26 23 / .05)`.
  Soft, low, ambient. There is no second elevation for cards — depth comes from
  the hairline, not from stacking shadows.
- Overlays (drawer, popover, modal) get `--shadow-pop: 0 8px 32px rgb(28 26 23 / .12)`.
- Borders are always 1px `--line`. A 2px border is a focus ring, nothing else.

## Space

4px base. Use 4 / 8 / 12 / 16 / 24 / 32 / 48. Card padding 16 (mobile) or 20
(desktop). Section gap 24. Nothing is denser than 8px between related items.

## Motion

120ms `ease-out` on colour and transform only. Never animate layout. Everything
inside `@media (prefers-reduced-motion: reduce)` collapses to 0ms. No loading
spinners longer than one line of skeleton.

## Components (one definition, used on every page)

- **AppBar** — 52px, `--surface`, one hairline bottom. Left: workgroup switcher.
  Centre: nothing. Right: page nav as quiet text links, accent underline when
  active.
- **Card** — `--surface`, 1px `--line`, `--r`, `--shadow`.
- **Disclosure** — native `<details>`. Summary is a 44px row with a chevron that
  rotates. Closed by default for anything dense.
- **Row** — 44px min height, hairline separated inside a card, whole row is the
  hit target, chevron or external-link glyph on the right.
- **Chip** — 24px, `--r` 6, soft status fill + status text colour. Never a solid
  saturated block.
- **Stat** — a number in 24/32 tabular sans over a 12px `--ink-2` label. Used in
  the summary strip. Tapping filters, and a filtered view MUST say so with a
  dismissible bar — a silently filtered list reads as missing data.
- **Sheet** — right drawer on desktop (420px), bottom sheet on mobile
  (max 85vh). Same component, one breakpoint.
- **Composer** — sticky bottom, `--surface`, hairline top, textarea + send.

## The map — the Pied Piper incubator, not a corporate floor

Gather Town supplies the RENDERING discipline. Silicon Valley supplies the
PLACE. They are different jobs and taking both from one source is what produced
a retro-skinned dashboard nobody wanted.

**The place is the incubator**, not an open-plan office. A converted suburban
house that a serious company is being built inside: folding tables, mismatched
chairs, whiteboards on every wall, a garage, a fridge, a pool out back, palms
over a beige stucco wall. The scrappiness is the joke AND the utility — the
whiteboard is a real surface for a room's blockers, the garage is where dead
channels go, and a room that is genuinely thriving looks different from one
that has three cobwebbed desks because the furniture says so, not because a
label does.

**California-noon palette**, sun-bleached rather than saturated:
- `--stucco #efe7d9`, `--concrete #e2dccf` — floor materials, 32px tiles
- `--terracotta #c98a63` — roof lines, room edges
- `--palm #7f9c6a`, `--pool #8fc0cc`, `--sunbleach #f6f0e2`
- Zone tints from the same family, all desaturated, none of them a state colour

**Rendering rules, from Gather:**
- Rooms are read by FLOOR MATERIAL, not by outlines. A zone is a soft tinted
  area with 4px rounded corners and a 6px wall band on its top edge only.
- **No black outlines anywhere on the map.** A sprite's edge is a darker shade
  of its own palette, never `#000`. This is the single biggest difference from
  the retro direction and the one that stops it reading as SNES chrome.
- Contact shadow under every object: a 4px soft ellipse at 8% ink. Never a hard
  offset shadow — that language belongs to the chrome, and the chrome doesn't
  use it either.
- Room size follows occupancy. Labels are quiet sans chips resting on the wall
  band, not hanging signs.
- Agent = pixelated avatar in a circular mask + a state dot + a sans nameplate.
  Asleep is 55% opacity plus desaturation, never a 💤 glyph.
- The floor pans as one image on mobile; it never reflows into a column. A
  stack of rooms is a list, not a place.

**The map is an index, not a picture.** Every room shows its own open-item
count in its own worst state colour, and tapping a room filters the ledger to
that room. That is what earns it the space: it answers *where* while the ledger
answers *what*, over the same data. A map that only showed which agent sat
where would be decoration, and would be cut.

## Anti-patterns (explicitly banned)

- Dark surfaces anywhere in the product.
- Uppercase + letterspaced + mono used as chrome, labels, nav or buttons.
- Hard zero-blur offset shadows; radii 0; 2–3px ink borders.
- Two visual languages in one product — a page that looks like it belongs to a
  different app is the bug this system exists to fix.
- Retro chrome around the map. The map is illustrated; its container is not.
- Equal-sized cards in a uniform grid used to represent a physical space.
- Status colour used decoratively, or a zone tint that collides with a status.

## Layout laws

1. **Every page: app bar → one-line summary → primary content → dense detail
   in closed disclosures.** The primary content of the Observatory is the
   office, and it is reachable without scrolling on a phone.
2. **One accent, one shadow, one radius scale, one type scale** — shared by
   every route. A component may not restyle itself per page.
3. **Detail opens in a Sheet, in place.** Navigating away from context to a
   differently-designed page is the specific failure this replaces.
4. Mobile first: 44px targets, no hover-only affordance, nothing wider than the
   viewport except the map, which pans.
