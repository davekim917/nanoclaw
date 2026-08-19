# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React 19 + TypeScript SPA built with Vite, hash-routed, styled with Tailwind v4
and shadcn/ui on a hand-authored token layer (`src/theme.css`). Data comes from
the host's own REST endpoints under `/dashboard/api/` via SWR; the Observatory
polls every 15s. No router library, no state library, no CSS framework beyond
Tailwind. The SPA builds to `dist/dashboard-spa/` and is served by the host
process that also serves its API.

Authored directly rather than through `/impeccable init`'s interview: product
truth here is already settled and recorded across the repo's specs, so the Q&A
round would have been asking the builder to repeat itself.

## Users

One operator — the person who runs the agent fleet — reading on a phone far
more often than at a desk. They are not monitoring a system for its own sake;
they are answering the question *what needs me right now* between other things.
Every second reader is the same person at a laptop wanting the wider view. There
is no multi-tenant audience, no customer-facing surface, and no onboarding path
to design for.

## Product Purpose

The dashboard is the layer above chat. Agent work happens in messaging threads,
which are excellent at conversation and terrible at status: nothing in a thread
says which of forty open commitments has already broken its promise, which need
a human decision, and which are moving on their own. This product answers those
three questions before any interaction, and lets the operator act on the answer
— steer a piece of work, hand it to an agent, push a stalled claim forward —
without leaving the page or opening the underlying thread.

Success is that the operator can open it on a phone, read the top of one screen,
and either do nothing (because nothing needs them) or take exactly one action.

## Positioning

The mechanism a neighboring tool could not truthfully copy: this reads the
fleet's *own* state files and live session records — claims, release state,
container liveness, per-channel presence — and renders commitments rather than
activity. Anything built on a generic API would show messages sent and processes
running; those are the two numbers that look healthiest while work rots. A
container can be awake, busy and animated while the thing it holds has been
stuck for three days.

The second half of the mechanism is spatial: the fleet is rendered as an office
with fixed geometry, so a room is findable twice. A layout generated from data
reshuffles whenever the data moves, and a room you cannot find twice is worse
than a list.

## Operating Context

Read in short bursts, usually on a phone, usually one-handed, often outdoors.
The operator arrives from a chat notification or from habit, not from a
workflow. Sessions are seconds to a minute. The page is behind an auth token
handed out through a private channel; there is no public URL and no third-party
asset request on load (fonts are self-hosted for that reason, not for speed).

Data is slow-moving — a 15s poll, no live feed — and every number on the page
is derived at request time from files and tables the fleet already maintains.
Nothing is cached, stored or backfilled for the dashboard's benefit.

## Capabilities and Constraints

Confirmed capabilities: an exception feed ("needs attention") sorted by
severity; a fleet list of every agent with persona name, status and current
activity; a schematic floor plan of the office (desktop) and a room strip
(mobile); the commitment ledger with per-row actions — steer, assign, push
forward — wired to existing endpoints; a decisions view; a job board; scheduled
work; per-agent and per-room detail that opens in place.

Hard constraints:

- **Nothing is invented.** An agent with no avatar gets a fallback mark, never
  a generated face. An item with no timestamp renders an em dash and sorts
  last, never a guessed age. An absent release desk and an empty one are
  different sentences.
- **Persona over infrastructure.** An agent's channel-facing name is what
  renders; its group/folder identity is secondary detail at most.
- **No new verbs.** The dashboard offers exactly the actions the host already
  exposes. A button whose only possible outcome is the server refusing it is
  worse than no button.
- **Install identity never lives in source.** Channel names, room bindings and
  signal wiring are operator config read at runtime; the shipped code is
  tenant-neutral.
- **Fixed floor geometry.** Room positions are hand-authored constants;
  only occupancy comes from data.

Terminology: *room* = one chat channel. *agent* = one agent identity. *claim* =
a piece of work an agent has picked up. *commitment* = an open item with an
owner and, ideally, a promised date. *exception* = anything the feed surfaces.

## Brand Commitments

The product's identity is the office: the fleet as a place, drawn as a
schematic, not as a chart. That survives every redesign.

Voice is lowercase, plain and unhedged — "nobody is in this room right now",
"no release desk", "already pushed in the last few minutes". No exclamation
marks, no encouragement, no status words that flatter ("All systems
operational"). When something is broken the page says so in the fewest ordinary
words that are true.

The visual system is `tom-modern`: editorial-technical, near-white canvas, deep
ink text, one vermillion accent, sharp corners, hard offset shadows, Geist
Sans/Mono. Light-first and single-theme by the operator's explicit call.

## Evidence on Hand

Live data throughout — real agent records, real claims, real release state,
real bot avatars from the platform CDN. There is no seeded content, no demo
mode, and no placeholder copy anywhere in the product. The approved visual
contract is a full-fidelity comp of the home screen at both widths, critic
reviewed, held in the private spec directory.

## Product Principles

1. **Answer before interaction.** The top of the screen states what needs a
   person. Nothing worth acting on should require a tap to discover.
2. **Say the honest thing, in ordinary words.** Absent, empty and broken are
   three different facts and never share a sentence. Uncertainty is stated, not
   smoothed.
3. **One grammar per thing.** A row is a row wherever it renders; a status word
   means the same thing on every surface. Two surfaces must never explain the
   same refusal two different ways.
4. **Fixed places, moving contents.** Spatial memory is a feature: geometry is
   authored once, and only occupancy comes from data.
5. **Colour and motion are information.** The accent marks what needs
   attention; animation appears only where something is genuinely happening.
   Neither is ever decorative.

## Accessibility & Inclusion

Phone-first: 390px is the primary viewport and every interactive target is at
least 44×44px there. WCAG AA contrast for all text, including on the vermillion
accent. Motion is state-driven and respects `prefers-reduced-motion` — under
`reduce`, an animated indicator stays *present* but static, because the fact it
reports is information and only its movement is presentation. Keyboard focus is
visible on every interactive element.
