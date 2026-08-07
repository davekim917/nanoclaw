import type { Box, Timeline } from './types';

/**
 * Camera framing maths, kept out of the component so it is inspectable and
 * testable without rendering. See `camera.test.ts` — the transform is the part
 * that silently produces a beautiful video of the wrong region.
 */

/** How much of the frame width the focused element should occupy when zoomed. */
const TARGET_OCCUPANCY = 0.42;
/** Never zoom out past 1 (letterboxing) or in past this (screenshot pixels get soft). */
const MIN_SCALE = 1;
const MAX_SCALE = 2.6;

export interface CameraTransform {
  scale: number;
  /** Translation in composition pixels, applied BEFORE scale about the center. */
  translateX: number;
  translateY: number;
}

export const IDENTITY_CAMERA: CameraTransform = { scale: 1, translateX: 0, translateY: 0 };

/**
 * Frame `box` (in screenshot pixels) within a `timeline.width`x`timeline.height`
 * composition. Returns the transform that centres the box and scales it to
 * TARGET_OCCUPANCY, clamped, and then clamped again so the image never pulls
 * its own edge inside the frame (which would show background bars).
 */
export function cameraFor(box: Box | undefined, timeline: Timeline): CameraTransform {
  if (!box) return IDENTITY_CAMERA;

  const { width, height } = timeline;
  const rawScale = box.width > 0 ? (width * TARGET_OCCUPANCY) / box.width : MIN_SCALE;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale));

  // Vector from image centre to box centre, negated to bring the box to centre.
  const boxCentreX = box.x + box.width / 2;
  const boxCentreY = box.y + box.height / 2;
  let translateX = width / 2 - boxCentreX;
  let translateY = height / 2 - boxCentreY;

  // With the image scaled about its centre, this much slack exists on each side
  // before an edge would cross into frame. Clamp so we never reveal background.
  const slackX = (width * (scale - 1)) / 2 / scale;
  const slackY = (height * (scale - 1)) / 2 / scale;
  translateX = Math.max(-slackX, Math.min(slackX, translateX));
  translateY = Math.max(-slackY, Math.min(slackY, translateY));

  return { scale, translateX, translateY };
}

/** Centre of a box in screenshot pixels — where the cursor points. */
export function boxCentre(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Where a screenshot-space point lands on screen once `camera` is applied.
 * Overlays (cursor, ripple) must use this or they drift away from the element
 * as the camera moves — the bug that makes a demo look broken rather than slick.
 */
export function project(
  point: { x: number; y: number },
  camera: CameraTransform,
  timeline: Timeline,
): { x: number; y: number } {
  const cx = timeline.width / 2;
  const cy = timeline.height / 2;
  return {
    x: cx + (point.x + camera.translateX - cx) * camera.scale,
    y: cy + (point.y + camera.translateY - cy) * camera.scale,
  };
}
