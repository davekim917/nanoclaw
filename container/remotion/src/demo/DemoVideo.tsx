import React from 'react';
import { AbsoluteFill, Img, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { boxCentre, cameraFor, project } from './camera';
import { DEFAULT_FPS, stepFrames, TITLE_SECONDS, TRANSITION_SECONDS, type Step, type Timeline } from './types';

/**
 * Data-driven product demo. Consumes a Timeline (screenshots + element rects
 * captured by a browsing agent) and produces camera moves, cursor motion, click
 * ripples, typed text, and captions.
 *
 * Built from STILLS rather than screen capture on purpose: `agent-browser
 * record` is locked at 10fps, so zooming into that footage is soft and choppy,
 * while retina screenshots (`set viewport 1920 1080 2`) stay sharp at any zoom.
 */

const ACCENT = '#5b8cff';

/**
 * The arrow's point sits at (5,2) in a 24x24 viewBox, not at the SVG origin, so
 * drawing it at the target leaves the tip ~8px down-right of the element it is
 * supposed to be pointing at. Shift it back by that inset so the TIP lands on
 * the coordinate — at a glance the uncorrected version just looks careless.
 */
const CURSOR_TIP_INSET = { x: 5 / 24, y: 2 / 24 };

const CursorArrow: React.FC<{ size: number }> = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{
      filter: 'drop-shadow(0 2px 6px rgba(0,0,0,.45))',
      transform: `translate(${-CURSOR_TIP_INSET.x * size}px, ${-CURSOR_TIP_INSET.y * size}px)`,
    }}
  >
    <path d="M5 2l14 10-6.2 1.2L16 21l-3 1.2-3.2-7.6L5 19z" fill="#fff" stroke="#111" strokeWidth={1.2} />
  </svg>
);

const ClickRipple: React.FC<{ progress: number; scale: number }> = ({ progress, scale }) => {
  if (progress < 0 || progress > 1) return null;
  const r = interpolate(progress, [0, 1], [8, 54]) * scale;
  const opacity = interpolate(progress, [0, 0.25, 1], [0, 0.55, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        left: -r,
        top: -r,
        width: r * 2,
        height: r * 2,
        borderRadius: '50%',
        border: `${Math.max(2, 4 * scale)}px solid ${ACCENT}`,
        opacity,
      }}
    />
  );
};

const Caption: React.FC<{ text: string; opacity: number }> = ({ text, opacity }) => (
  <div
    style={{
      position: 'absolute',
      left: 64,
      bottom: 64,
      maxWidth: '62%',
      padding: '18px 28px',
      borderRadius: 14,
      background: 'rgba(10,12,18,0.82)',
      color: '#fff',
      fontFamily: 'sans-serif',
      fontSize: 34,
      fontWeight: 500,
      lineHeight: 1.25,
      opacity,
      backdropFilter: 'blur(6px)',
    }}
  >
    {text}
  </div>
);

const TitleCard: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = spring({ frame, fps, config: { damping: 200 }, from: 24, to: 0 });
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  const fade = interpolate(frame, [Math.round(TITLE_SECONDS * fps) - 10, Math.round(TITLE_SECONDS * fps)], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(160deg,#0c1020 0%,#131a30 100%)',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        opacity: Math.min(opacity, fade),
      }}
    >
      <div style={{ transform: `translateY(${rise}px)`, textAlign: 'center' }}>
        <div style={{ color: '#fff', fontSize: 92, fontWeight: 700, letterSpacing: -1.5 }}>{title}</div>
        {subtitle ? <div style={{ color: '#8ea3d0', fontSize: 38, marginTop: 18 }}>{subtitle}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const StepScene: React.FC<{ step: Step; prev?: Step; timeline: Timeline; durationInFrames: number }> = ({
  step,
  prev,
  timeline,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const from = cameraFor(prev?.focus, timeline);
  const to = cameraFor(step.focus, timeline);

  // Camera eases over the first ~40% of the step, then holds — a move that runs
  // the whole step reads as drifting rather than deliberate.
  const moveFrames = Math.max(1, Math.round(durationInFrames * 0.4));
  const t = spring({ frame, fps, config: { damping: 200, mass: 0.9 }, durationInFrames: moveFrames });

  const camera = {
    scale: from.scale + (to.scale - from.scale) * t,
    translateX: from.translateX + (to.translateX - from.translateX) * t,
    translateY: from.translateY + (to.translateY - from.translateY) * t,
  };

  const fadeIn = interpolate(frame, [0, Math.round(TRANSITION_SECONDS * fps)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const centre = step.focus ? boxCentre(step.focus) : null;
  const prevCentre = prev?.focus ? boxCentre(prev.focus) : centre;
  const cursorPoint =
    centre && prevCentre
      ? { x: prevCentre.x + (centre.x - prevCentre.x) * t, y: prevCentre.y + (centre.y - prevCentre.y) * t }
      : null;
  const cursorScreen = cursorPoint ? project(cursorPoint, camera, timeline) : null;

  // Click lands once the camera has settled, so the viewer sees the target
  // before the interaction fires.
  const clickFrame = moveFrames;
  const rippleProgress = (frame - clickFrame) / Math.max(1, Math.round(0.45 * fps));

  const typed =
    step.action === 'type' && step.text
      ? step.text.slice(
          0,
          Math.max(0, Math.round(interpolate(frame, [clickFrame, clickFrame + 0.9 * fps], [0, step.text.length], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }))),
        )
      : null;

  const typedScreen = step.focus ? project({ x: step.focus.x, y: step.focus.y }, camera, timeline) : null;

  return (
    <AbsoluteFill style={{ opacity: fadeIn, background: '#000', overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          transform: `scale(${camera.scale}) translate(${camera.translateX}px, ${camera.translateY}px)`,
          transformOrigin: 'center center',
        }}
      >
        <Img src={staticFile(`shots/${step.shot}`)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </AbsoluteFill>

      {typed !== null && typedScreen ? (
        <div
          style={{
            position: 'absolute',
            left: typedScreen.x + 14 * camera.scale,
            top: typedScreen.y + (step.focus ? (step.focus.height / 2) * camera.scale - 16 : 0),
            color: '#0f1730',
            fontFamily: 'sans-serif',
            fontSize: 26 * camera.scale,
            fontWeight: 500,
          }}
        >
          {typed}
          <span style={{ opacity: Math.round(frame / 8) % 2 === 0 ? 1 : 0 }}>|</span>
        </div>
      ) : null}

      {cursorScreen ? (
        <div style={{ position: 'absolute', left: cursorScreen.x, top: cursorScreen.y }}>
          {step.action === 'click' ? <ClickRipple progress={rippleProgress} scale={camera.scale} /> : null}
          <CursorArrow size={40} />
        </div>
      ) : null}

      {step.caption ? <Caption text={step.caption} opacity={fadeIn} /> : null}
    </AbsoluteFill>
  );
};

export const DemoVideo: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const fps = timeline.fps ?? DEFAULT_FPS;
  const titleFrames = timeline.title ? Math.round(TITLE_SECONDS * fps) : 0;

  let cursor = titleFrames;
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {timeline.title ? (
        <Sequence durationInFrames={titleFrames}>
          <TitleCard title={timeline.title} subtitle={timeline.subtitle} />
        </Sequence>
      ) : null}
      {timeline.steps.map((step, index) => {
        const duration = stepFrames(step, fps);
        const start = cursor;
        cursor += duration;
        return (
          <Sequence key={`${step.shot}-${index}`} from={start} durationInFrames={duration}>
            <StepScene
              step={step}
              prev={timeline.steps[index - 1]}
              timeline={timeline}
              durationInFrames={duration}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
