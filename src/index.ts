/**
 * Entry bootstrap. ExecStart runs dist/index.js, so this file must stay a
 * thin shim: run the deploy crash guard BEFORE the application module graph
 * loads (a bad dependency bump crashes at import time, where nothing inside
 * src/main.ts can ever run), then hand off.
 *
 * Do not add imports here beyond the guard and the shadow environment scrub —
 * static imports are hoisted, so anything imported from this file executes
 * before the guard does. Both import only node builtins.
 */
import { runDeployCrashGuard } from './deploy-crash-guard.js';
import { scrubShadowProcessEnv } from './shadow-allowlist.js';

runDeployCrashGuard();
scrubShadowProcessEnv();

const { startNanoClaw } = await import('./main.js');
startNanoClaw();
