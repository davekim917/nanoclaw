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

**The `DemoVideo` composition already implements this — you supply data, not
animation code.** Scaffolding gives you `src/demo/`:

| File | What it is |
|---|---|
| `timeline.json` | **The only file you normally edit.** Steps, captions, element rects. |
| `types.ts` | The timeline contract, and where duration is derived. |
| `camera.ts` | Framing maths: zoom-to-box, edge clamping, screen projection. |
| `DemoVideo.tsx` | Renders it: camera moves, cursor, click ripples, typing, captions. |

```bash
npx remotion render src/index.ts DemoVideo demo.mp4
```

Duration, dimensions, and fps all follow `timeline.json` — you never touch
`Root.tsx`. Add a step, the video gets longer.

### Capturing a timeline

```bash
agent-browser set viewport 1920 1080 2      # 2 = retina; stills come out ~3840px
agent-browser screenshot public/shots/01-dashboard.png
agent-browser get box "#submit" --json      # exact rect of the element you act on
```

`get box --json` nests the rect under `.data` — `{"success":true,"data":{"x":256,
"y":94.9,"width":768,"height":27,...}}` — so read `.data.x` / `.data.y` /
`.data.width` / `.data.height`, not the top level. Those numbers go straight
into a step's `focus`:

```json
{
  "width": 1920, "height": 1080, "fps": 30,
  "title": "Market Scope", "subtitle": "Forecast in three clicks",
  "steps": [
    { "shot": "01-dashboard.png", "hold": 3, "caption": "Start on the dashboard", "action": "look" },
    { "shot": "02-scope.png", "hold": 3.5, "caption": "Pick the market",
      "focus": {"x":840,"y":95,"width":120,"height":40}, "action": "click" },
    { "shot": "03-form.png", "hold": 4, "caption": "Set the target",
      "focus": {"x":320,"y":210,"width":280,"height":44}, "action": "type", "text": "California" }
  ]
}
```

`focus` is in SCREENSHOT pixel coordinates, and the composition projects
overlays through the same transform, so the cursor stays glued to the element
as the camera moves.

### Directing it

The engine handles mechanics; these choices decide whether it looks like a
product demo or a slideshow:

- **Do not zoom every step.** Omit `focus` for establishing shots. Constant
  pushing is seasick — earn the zoom by alternating wide and tight.
- **`hold` is your pacing.** 3s reads comfortably; 4–5s when a caption carries
  real information. Under 2s and nobody can read the caption.
- **Captions say what the user achieves, not what the UI is.** "Forecast the
  quarter in three clicks" beats "Click the Submit button."
- **Order for narrative, not for chronology.** You control the timeline — drop
  the steps that only exist because the app made you take them.
- **Re-capture rather than re-animate.** When the UI changes, retake the shots
  and the boxes; the animation is derived.

### Why stills and not the screen recording

`agent-browser record` is locked at 10fps, so zooming into that footage is soft
and choppy no matter what the composition does. Retina screenshots stay sharp at
any zoom, and let you cut dead time, reorder for narrative, and re-shoot one
step without redoing the walk.

The two artifacts have different jobs: the 10fps capture is QA evidence that the
flow really ran, and the stills-plus-Remotion piece is the polished asset. Do
not substitute one for the other — a demo is directed, so it is never proof.

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
