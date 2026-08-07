import { Composition } from 'remotion';

import { Demo } from './Demo';

/**
 * Starter root. Replace `Demo` with your own composition — this one exists so a
 * freshly scaffolded project renders end to end without editing anything, which
 * is how you confirm the runtime works before debugging your own composition.
 */
export const RemotionRoot: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={90} fps={30} width={1920} height={1080} />
);
