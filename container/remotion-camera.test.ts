/**
 * Camera framing checks for the Remotion demo composition.
 *
 * Lives at container/ top level because vitest includes `container/*.test.ts`
 * (see vitest.config.ts) while `container/remotion/` is a separate package tree
 * the host never builds. `camera.ts` imports nothing, which is what makes this
 * possible — keep it that way.
 *
 * Why this is worth testing at all: a wrong transform still renders a
 * beautiful, smooth video — of the wrong region. There is no crash to catch it,
 * and reviewing a 30-second render by eye is exactly the check people skip.
 */
import { describe, expect, it } from 'vitest';

import { boxCentre, cameraFor, IDENTITY_CAMERA, project } from './remotion/src/demo/camera.js';
import type { Timeline } from './remotion/src/demo/types.js';

const timeline: Timeline = { width: 1920, height: 1080, steps: [] };

describe('cameraFor', () => {
  it('holds the full frame when no focus box is given', () => {
    expect(cameraFor(undefined, timeline)).toEqual(IDENTITY_CAMERA);
  });

  it('zooms in on a small element and never below 1x', () => {
    const small = cameraFor({ x: 900, y: 500, width: 120, height: 40 }, timeline);
    expect(small.scale).toBeGreaterThan(1);

    // An element wider than the target occupancy must not zoom OUT — that would
    // letterbox the screenshot and show background bars.
    const huge = cameraFor({ x: 0, y: 0, width: 1900, height: 1000 }, timeline);
    expect(huge.scale).toBe(1);
  });

  it('centres the focused element', () => {
    const box = { x: 200, y: 200, width: 200, height: 100 };
    const camera = cameraFor(box, timeline);
    const centre = project(boxCentre(box), camera, timeline);
    // Clamping may stop short of perfect centring near an edge, but the element
    // must land well inside the frame rather than off-screen.
    expect(centre.x).toBeGreaterThan(0);
    expect(centre.x).toBeLessThan(timeline.width);
    expect(centre.y).toBeGreaterThan(0);
    expect(centre.y).toBeLessThan(timeline.height);
  });

  it('never pans far enough to reveal the image edge', () => {
    // A box hard against the corner is the case that pulls the image edge into
    // frame if translation is not clamped against the available slack.
    const corner = cameraFor({ x: 0, y: 0, width: 80, height: 30 }, timeline);
    const slackX = (timeline.width * (corner.scale - 1)) / 2 / corner.scale;
    const slackY = (timeline.height * (corner.scale - 1)) / 2 / corner.scale;
    expect(Math.abs(corner.translateX)).toBeLessThanOrEqual(slackX + 1e-6);
    expect(Math.abs(corner.translateY)).toBeLessThanOrEqual(slackY + 1e-6);
  });

  it('projects screenshot coordinates to screen so overlays track the camera', () => {
    // With no camera move, projection is the identity — a cursor at the box
    // centre sits exactly on the element.
    const point = { x: 640, y: 360 };
    expect(project(point, IDENTITY_CAMERA, timeline)).toEqual(point);

    // Under zoom, a point left of centre must move further left on screen.
    const zoomed = { scale: 2, translateX: 0, translateY: 0 };
    expect(project(point, zoomed, timeline).x).toBeLessThan(point.x);
  });
});
