import { DEFAULT_FPS, stepFrames, TITLE_SECONDS, type Timeline } from './types';

/**
 * Music ducking. Pure functions, kept out of the component so the behaviour is
 * provable — you cannot hear a unit test, and measuring the bed level in a
 * finished mix is hopeless once narration is layered on top of it.
 */

/** Default music level when nothing is being said over it. */
export const MUSIC_BED_VOLUME = 0.18;
/** Fraction of the bed level music drops to under narration. */
export const DUCK_RATIO = 0.28;
/** Seconds of ramp into and out of a duck. An instant level change clicks. */
export const DUCK_RAMP_SECONDS = 0.25;

/** Frame ranges [start, end) during which a step's narration is playing. */
export function narrationRanges(timeline: Timeline): Array<[number, number]> {
  const fps = timeline.fps ?? DEFAULT_FPS;
  const ranges: Array<[number, number]> = [];
  let at = timeline.title ? Math.round(TITLE_SECONDS * fps) : 0;
  for (const step of timeline.steps) {
    const duration = stepFrames(step, fps);
    if (step.voice) ranges.push([at, at + duration]);
    at += duration;
  }
  return ranges;
}

function lerp(value: number, fromRange: [number, number], toRange: [number, number]): number {
  const [a, b] = fromRange;
  const [c, d] = toRange;
  if (b === a) return d;
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return c + (d - c) * t;
}

/**
 * Music level at `frame`: the bed, ramped down to `bed * DUCK_RATIO` across any
 * narration range and back out afterwards.
 */
export function musicVolumeAt(
  frame: number,
  ranges: Array<[number, number]>,
  bed: number,
  fps: number,
): number {
  const ramp = Math.max(1, Math.round(DUCK_RAMP_SECONDS * fps));
  const ducked = bed * DUCK_RATIO;
  let level = bed;
  for (const [start, end] of ranges) {
    if (frame < start - ramp || frame > end + ramp) continue;
    const value = frame <= end ? lerp(frame, [start - ramp, start], [bed, ducked]) : lerp(frame, [end, end + ramp], [ducked, bed]);
    level = Math.min(level, value);
  }
  return level;
}
