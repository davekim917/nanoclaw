# office-16 — a committed design system for the Observatory

Vibe: Animal Crossing × SNES menu chrome × Gather Town. A **bright, warm,
top-down office** you look down into. Not arcade-dark, not corporate-flat.

## Palette (roles, not decoration)
- `--floor-a #e9d7b6` / `--floor-b #dfc9a2` — checkerboard floor tiles, 32px
- `--wall #7c5f3e`, `--wall-hi #a2825a`, `--wall-sh #52402a` — the building
  perimeter AND each room's own four-sided wall (see the amendment below)
- `--rug-*` — one saturated but desaturated-warm tone per zone. Rug colour
  carries the zone's IDENTITY; the wall carries its extent. A rug tone is
  never reused to mean a state — grey is reserved for "unused 7+ days" and
  amenity spaces (lounge, kitchen, breakout) get their own tone rather than
  borrowing it.
- `--panel #fbf3e2` (paper), `--panel-edge #2a2118` (ink outline)
- `--ink #2a2118`, `--ink-2 #6d5b45`
- `--live #3f9c4a` (working), `--warn #e0a32e` (needs a person),
  `--stop #c8483a` (blocking), `--idle #8a8378` (nobody / asleep)

## Depth language
Every raised object: **2px ink outline + 4px hard offset shadow, zero blur.**
No gradients on chrome, no border-radius above 0 except sprite-internal art.
Radii: 0. This is what makes it read as sprites rather than cards.

## Type
System stack only — NO web fonts. Chrome/labels are uppercase, letter-spaced
1px, weight 700. Body copy sentence case. Numbers in tallies are the largest
type on the page (they are the summary).

## Layout law (fixes the real complaints)
1. **The office is the hero and is reachable without scrolling** — on mobile
   it sits directly under a one-line tally strip; the dense boards live BELOW
   it and are collapsed.
2. **Progressive disclosure via native `<details>`** — nothing dense is open
   by default; the tallies ARE the summary. No JS.
3. **Free-form floor, not a grid** — zones are absolutely placed at varied
   sizes with furniture between them; a perimeter wall and an entrance make it
   a place. A CSS grid of equal boxes is the anti-pattern this replaces.
4. **A room's size is its occupancy** — a one-desk channel gets a small room,
   not a large colour slab with a desk marooned in the middle. Bare area
   inside a room has to read as circulation, not as unfilled rectangle.
5. **The frame fits its contents** — the floor is sized to the rooms on it. A
   walled box that is half bare tile undoes what the walls bought.

## Amendment — rooms are walled (adopted after round 3)

The original rule said zones are told apart by rug colour *never by borders*,
and the first three rounds honoured it. Every critic read the result the same
way: a colour-block chart, not a floor plan. Enclosing each room on all four
sides with a cap face and an inward shadow was the single change that made it
read as a place you look down into.

So the rule is amended rather than quietly broken: **rooms are enclosed.** The
rug still names the zone and still carries its state colour; the wall gives it
extent and lets an agent sprite be genuinely occluded by furniture, which is
what sells the top-down view. What remains banned is the thing the original
rule was actually protecting against — a *hairline* box border used as a card
edge. A wall is 6-8px of drawn masonry with a lit cap and a doorway gap in it;
a 1px outline around a coloured rectangle is still a card.

## Anti-patterns (explicitly banned)
- Equal-sized cards in a uniform grid (reads as cubicles, not an office)
- Soft/blurred shadows, rounded cards, gradient fills on chrome
- Dark background (the office is lit)
- Web fonts, JS, external assets
