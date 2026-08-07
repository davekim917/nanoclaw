import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * Smoke-test composition: a spring-driven zoom, which is the same primitive a
 * real demo uses to push in on a button or form field. If this renders, the
 * runtime, the system Chromium, and the encoder are all wired correctly.
 */
export const Demo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 200 }, from: 1, to: 1.4 });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: '#0b0b0d',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ transform: `scale(${scale})`, opacity, color: '#fff', fontSize: 96, fontWeight: 600 }}>
        Remotion runtime OK
      </div>
    </AbsoluteFill>
  );
};
