/**
 * design_review — NanoClaw registration wrapper.
 *
 * The engine (design-review.ts + linter/render/state) is VENDORED byte-identical
 * from ~/plugins/design-artifact-loop (github.com/davekim917/design-artifact-loop)
 * — develop THERE, then run `pnpm exec tsx scripts/vendor-design-artifact-loop.ts`.
 * src/design-artifact-loop-vendor.test.ts fails the host suite on drift.
 *
 * This wrapper is the only tree-specific part: it pins the loop root to the
 * persistent, send_file-able /workspace/agent dir (the vendored engine reads
 * DESIGN_ARTIFACT_LOOP_ROOT at module load, so the env default must be set
 * BEFORE the dynamic import), then registers the tool with the per-session MCP
 * server for all three providers.
 */
import { registerTools } from '../server.js';

process.env.DESIGN_ARTIFACT_LOOP_ROOT ??= '/workspace/agent/design-artifact-loop';

const { designReviewTools } = await import('./design-review.js');
registerTools(designReviewTools);

export { designReviewTools };
