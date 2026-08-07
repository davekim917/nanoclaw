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
  /** Filename under public/shots/, e.g. "01-dashboard.png". */
  shot: string;
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
