import { Composition } from 'remotion';

import { Demo } from './Demo';
import { DemoVideo } from './demo/DemoVideo';
import timelineJson from './demo/timeline.json';
import { DEFAULT_FPS, totalFrames, type Timeline } from './demo/types';

const timeline = timelineJson as Timeline;

export const RemotionRoot: React.FC = () => (
  <>
    {/* Runtime smoke test. Render this first — if it produces an mp4 the
        toolchain is healthy and any later failure is your composition. */}
    <Composition id="Demo" component={Demo} durationInFrames={90} fps={30} width={1920} height={1080} />

    {/* Data-driven product demo. Duration and dimensions follow the timeline,
        so editing timeline.json changes the video without touching this file. */}
    <Composition
      id="DemoVideo"
      component={DemoVideo}
      durationInFrames={totalFrames(timeline)}
      fps={timeline.fps ?? DEFAULT_FPS}
      width={timeline.width}
      height={timeline.height}
      defaultProps={{ timeline }}
    />
  </>
);
