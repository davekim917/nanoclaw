/**
 * The contract between a browsing agent and the demo composition.
 *
 * An agent walks a UI, and for each step records a full-resolution screenshot
 * plus the on-screen rect of the element it acted on (`agent-browser get box
 * <sel> --json` → `.data`). The composition turns that into camera moves,
 * cursor motion, and callouts. Nothing is hand-keyframed, so when the UI moves
 * the demo stays correct — you re-capture, you don't re-animate.
 */

/** Element rect in SCREENSHOT pixel coordinates (agent-browser `get box`). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type StepAction = 'click' | 'type' | 'look';

export interface Step {
  /**
   * Filename under public/shots/, e.g. "01-dashboard.png". Ignored when `clip`
   * is set. One of `shot` or `clip` is required.
   */
  shot?: string;
  /**
   * Filename under public/clips/, e.g. "03-drag.mp4" — use INSTEAD of `shot`
   * for the few moments a still genuinely cannot carry: a drag, a chart
   * animating in, a transition, a live-updating number.
   *
   * The trade is real: `agent-browser record` captures at 10fps, so a clip is
   * visibly softer and choppier than a retina still, and zooming it makes that
   * worse. Use clips for motion that IS the point, stills for everything else.
   *
   * `hold` must not exceed the clip's own length or the last frame freezes.
   * Measure it — `ffprobe -v error -show_entries format=duration -of csv=p=0
   * <clip>` — and set `hold` from that.
   */
  clip?: string;
  /**
   * Narration for this step: a filename under public/audio/. The step's `hold`
   * should be at least the audio length or the voice is cut off mid-sentence —
   * measure it with ffprobe, same as a clip.
   */
  voice?: string;
  /** Seconds this step is on screen, transition included. Default 3. */
  hold?: number;
  /** Lower-third caption. Omit for no caption. */
  caption?: string;
  /**
   * Rect to push the camera onto. Omit to hold the full frame — do that
   * deliberately for establishing shots; a demo that zooms every step is
   * seasick.
   */
  focus?: Box;
  /** `click` draws a ripple, `type` types `text`, `look` only moves the camera. */
  action?: StepAction;
  /** Text typed out character by character when action is 'type'. */
  text?: string;
}

export interface Timeline {
  /** Screenshot pixel dimensions. The composition matches this aspect. */
  width: number;
  height: number;
  fps?: number;
  /** Optional opening title card. */
  title?: string;
  subtitle?: string;
  /**
   * Background music: a filename under public/audio/. Automatically ducked
   * under any step that has `voice`, because music at a constant level under
   * narration is the single most common reason a demo sounds amateur.
   */
  music?: string;
  /** Music level with no narration over it. 0-1, default 0.18. */
  musicVolume?: number;
  steps: Step[];
}

export const DEFAULT_FPS = 30;
export const DEFAULT_HOLD_SECONDS = 3;
/** Seconds of cross-dissolve between consecutive steps. */
export const TRANSITION_SECONDS = 0.5;
/** Seconds the title card holds, when a title is present. */
export const TITLE_SECONDS = 2.5;

export function stepFrames(step: Step, fps: number): number {
  return Math.round((step.hold ?? DEFAULT_HOLD_SECONDS) * fps);
}

/** Total composition length. Used by `calculateMetadata` so duration follows the timeline. */
export function totalFrames(timeline: Timeline): number {
  const fps = timeline.fps ?? DEFAULT_FPS;
  const steps = timeline.steps.reduce((sum, step) => sum + stepFrames(step, fps), 0);
  const title = timeline.title ? Math.round(TITLE_SECONDS * fps) : 0;
  return Math.max(1, steps + title);
}
