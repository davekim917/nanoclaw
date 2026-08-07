import { Config } from '@remotion/cli/config';

// Use the system Chromium the image already ships (also used by agent-browser
// and mmdc) instead of letting Remotion download its own Chrome Headless Shell
// (~150MB, and a network fetch on first render inside a container that may have
// no egress). Remotion's docs note that a full Chromium is marginally less
// deterministic than their pinned shell; for demo/marketing renders that is a
// fair trade against image size and an offline-capable first render.
Config.setBrowserExecutable('/usr/bin/chromium');

// JPEG frames encode substantially faster than PNG and the difference is
// invisible for screen-capture and UI footage. Switch to 'png' only when a
// composition needs alpha.
Config.setVideoImageFormat('jpeg');

Config.setOverwriteOutput(true);
