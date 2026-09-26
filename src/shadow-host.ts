/**
 * Shadow host mode (`NANOCLAW_SHADOW=1`): a second host run from a separate
 * checkout on a machine that already runs a production host — the practice
 * copy an agent drives to verify a change. Data, sockets, containers and chat
 * channels are already scoped to the checkout. What this flag turns off is
 * what acts on state the two hosts share: the OneCLI approval queue, agent
 * grants and secrets, the container image store and build cache, the live
 * plugin sources under `~/plugins`, host credential files mounted read-write,
 * the system temp dir, the dashboard cookie secret, and an off-box port.
 *
 * Unset, every call site behaves exactly as before.
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DATA_DIR, INSTALL_SLUG, REPO_ROOT } from './config.js';
import { getContainerImageBase } from './install-slug.js';
import { log } from './log.js';
import { readShadowFlag } from './shadow-flag.js';

const shadowHost = readShadowFlag(process.cwd());

export function isShadowHost(): boolean {
  return shadowHost;
}

const SHADOW_MODE_SUMMARY =
  'Shadow host mode: OneCLI approval handler, MCP OAuth refresh and secret writes, container image ' +
  'builds, plugin updater, docker image/build-cache cleanup, host-side task scripts and host ' +
  'credential mounts are disabled; ' +
  'non-Claude providers refused; operator mounts forced read-only; OneCLI agents, TMPDIR and the ' +
  'dashboard cookie secret are namespaced to this checkout; webhook server bound to 127.0.0.1';

/** The image reference without its tag or digest (`host:5000/name:tag` → `host:5000/name`). */
export function imageRepository(ref: string): string {
  const withoutDigest = ref.split('@')[0];
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/**
 * A shadow host may only use images in its own checkout's namespace. Any other
 * reference — production's default image included — is refused: the shadow
 * cannot know which install owns a foreign name, and per-agent-group builds and
 * image cleanup both act on whatever namespace the base names.
 */
export function shadowImageViolation(image: string, imageBase: string, ownBase: string): string | null {
  if (imageBase === ownBase && imageRepository(image) === ownBase) return null;
  return (
    `NANOCLAW_SHADOW=1 but the container image (${image}, base ${imageBase}) is outside this checkout's ` +
    `own image namespace ${ownBase}. A shadow host must never run, build or tag another install's image. ` +
    `Unset CONTAINER_IMAGE and CONTAINER_IMAGE_BASE, then reuse the production image without rebuilding it: ` +
    `docker tag <production image>:latest ${ownBase}:latest`
  );
}

/**
 * Per-spawn form of the same rule, for the image a spawn actually resolves —
 * a group's `container.json` `imageTag` can name an image the boot check never
 * saw. Null when shadow mode is off or the image is in this checkout's namespace.
 */
export function shadowSpawnImageViolation(image: string): string | null {
  if (!isShadowHost()) return null;
  const ownBase = getContainerImageBase(REPO_ROOT);
  if (imageRepository(image) === ownBase) return null;
  return (
    `Shadow host refuses to spawn from ${image}: outside this checkout's image namespace ${ownBase}. ` +
    `Clear imageTag in the group's container.json, or retag the image into this namespace: ` +
    `docker tag ${image} ${ownBase}:<tag>`
  );
}

/**
 * The OneCLI agent identifier for an agent group. A shadow's copy of a group
 * can carry production's id, and spawn reconciles that agent's grants to the
 * shadow's declaration — so a shadow prefixes its identifiers with its install
 * slug. OneCLI identifiers allow lowercase letters, digits and hyphens; the
 * slug is lowercase hex.
 */
export function onecliAgentIdentifier(agentGroupId: string): string {
  return isShadowHost() ? `shadow-${INSTALL_SLUG}-${agentGroupId}` : agentGroupId;
}

/**
 * Codex and OpenCode sessions mount host credential homes read-write, so a
 * shadow runs Claude-provider sessions only. Null when allowed.
 */
export function shadowProviderViolation(provider: string): string | null {
  if (!isShadowHost() || provider === 'claude') return null;
  return `Shadow host refuses a ${provider} session: only the claude provider runs without writing host credential files`;
}

/**
 * Enter shadow mode at boot, before anything can spawn or build. Returns the
 * refusal message when the configured image is outside this checkout's
 * namespace. Otherwise points TMPDIR into this checkout — the OneCLI SDK writes
 * CA bundles and credential stubs under fixed names in `os.tmpdir()`, which
 * production's containers bind-mount — logs what shadow mode changed, and
 * returns null. Does nothing when shadow mode is off.
 */
export function enterShadowHostMode(): string | null {
  if (!isShadowHost()) return null;
  const violation = shadowImageViolation(CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, getContainerImageBase(REPO_ROOT));
  if (violation) return violation;
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.TMPDIR = tmpDir;
  log.warn(SHADOW_MODE_SUMMARY, { image: CONTAINER_IMAGE, tmpDir });
  return null;
}
