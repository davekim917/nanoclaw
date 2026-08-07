---
name: remotion
description: Render videos programmatically with Remotion (React-based). Use for demo and marketing videos, animated explainers, feature walkthroughs with zooms and callouts, or any video assembled from screenshots, screen captures, data, or motion graphics. Covers the shared runtime baked into the image and how to build a product demo from agent-browser evidence.
---

# Remotion

Remotion renders video from React components. A composition is a component that
reads `useCurrentFrame()` and draws that frame; the renderer walks the frames in
a real browser and encodes them.

The runtime is **shared and pre-installed at `/opt/remotion`** — every agent
group has it, no install step, no network fetch.

## Start a project

```bash
new-video /workspace/agent/my-demo     # scaffolds from the shared runtime
cd /workspace/agent/my-demo
npx remotion render src/index.ts Demo out.mp4
```

Render the untouched starter **first**. If it produces an mp4 the runtime is
healthy, and any later failure is your composition rather than the toolchain.
Then edit `src/Root.tsx` (declares compositions: id, dimensions, fps, duration)
and `src/Demo.tsx` (the composition itself).

`node_modules` is a symlink into `/opt/remotion` — shared and read-only.
**Never write into `/opt/remotion`**; it is every other agent's runtime too. Need
an extra package? Install it into your own project directory.

## API reference

Full Remotion documentation is mounted at
`/workspace/plugins/remotion-skills/skills/` — `remotion-best-practices`,
`remotion-create`, `remotion-multimedia` (video/audio layers),
`remotion-captions`, `remotion-render`, `remotion-markup`. Read those for the
API. This skill only covers the local wiring and the recipes below.

## Product demos from agent-browser evidence

The high-value case: turn a UI walkthrough into a demo that looks art-directed
rather than screen-recorded.

**Build it from screenshots, not from the screen recording.** `agent-browser
record` is locked at 10fps, so zooming into that footage is soft and choppy.
Screenshots have no such limit:

```bash
agent-browser set viewport 1920 1080 2      # 2 = retina; stills come out ~3840px
agent-browser screenshot step-01.png
agent-browser get box "#submit" --json      # exact rect of the element you act on
```

`get box --json` nests the rect under `.data` — `{"success":true,"data":{"x":256,
"y":94.9,"width":768,"height":27,...}}` — so read `.data.x` / `.data.y` /
`.data.width` / `.data.height`, not the top level.

Capture a still at every step plus the `get box` of the element being acted on,
and emit a timeline the composition consumes:

```json
[{"step":1,"shot":"step-01.png","action":"click","box":{"x":840,"y":95,"width":120,"height":40}},
 {"step":2,"shot":"step-02.png","action":"fill","text":"acme@example.com","box":{"x":320,"y":210,"width":280,"height":44}}]
```

Then the composition animates *from data* — no hand-placed keyframes, and it
stays correct when the UI moves:

- **Zoom to a region**: interpolate a wrapper's `transform: scale()` +
  `translate()` so the box's center lands at the composition's center.
  `spring()` reads better than linear `interpolate()` for camera moves.
- **Cursor**: absolutely position a cursor graphic and interpolate it between
  consecutive boxes; add a scale-down blip on the click frame.
- **Click ripple**: an expanding, fading circle at the box center.
- **Form fill**: render `text.slice(0, charsShown)` where `charsShown` is
  derived from the frame — typing appears live without recording it.
- **Callouts**: fade a label anchored to the box.

Two artifacts with different jobs: the 10fps capture is QA evidence that the
flow really ran; the stills-plus-Remotion piece is the polished asset.

## Gotchas

- **Renders are slow** — minutes for a 1080p composition. Set the Bash timeout
  accordingly (`600000`) or run it in the background; the default 2-minute
  timeout kills a render mid-encode and leaves no file.
- **The system Chromium is already wired** via `Config.setBrowserExecutable()`
  in `remotion.config.ts`. Don't remove it — Remotion would try to download its
  own Chrome Headless Shell, which is slow and fails without network egress.
- **`fps` and `durationInFrames` live on the `<Composition>`**, not on the
  render command. A demo that feels rushed is usually a duration problem, not
  an animation problem.
- **Deliver with `send_file`.** Users cannot open `/workspace/...` paths.
- **Audio needs an explicit track** — compositions are silent by default.
- **Licensing**: Remotion is free for some users and requires a paid company
  license for others. Confirm the current terms at remotion.pro before shipping
  renders as company or customer-facing material.
