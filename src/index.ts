/**
 * Entry bootstrap: runs the deploy crash guard BEFORE the app module graph loads, since a bad dependency bump
 * crashes at import time. Import nothing else statically here: static imports are hoisted above the guard.
 */
import { runDeployCrashGuard } from './deploy-crash-guard.js';

runDeployCrashGuard();

const { startNanoClaw } = await import('./main.js');
startNanoClaw();
