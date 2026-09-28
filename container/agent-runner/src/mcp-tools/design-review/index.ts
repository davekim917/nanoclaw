/**
 * design_review registration wrapper. The engine beside it is VENDORED byte-identical from
 * ~/plugins/design-artifact-loop (develop there, then run scripts/vendor-design-artifact-loop.ts).
 * DESIGN_ARTIFACT_LOOP_ROOT must be set BEFORE the dynamic import: the engine reads it at module load.
 */
import { registerTools } from '../server.js';

process.env.DESIGN_ARTIFACT_LOOP_ROOT ??= '/workspace/agent/design-artifact-loop';

try {
  const { designReviewTools } = await import('./design-review.js');
  registerTools(designReviewTools);
} catch (err) {
  // A broken vendored engine (e.g. an unvendored new module) must degrade to
  // "design_review missing this session", never a dead agent-runner.
  console.error('[design-review] engine failed to load — design_review unavailable:', err);
}
