/**
 * Shadow host mode (`NANOCLAW_SHADOW=1`): a second host run from a separate
 * checkout on a machine that already runs a production host — the practice
 * copy an agent drives to verify a change. Data, sockets and containers are
 * already scoped to the checkout.
 *
 * What a shadow may run and read is an allowlist (shadow-allowlist.ts): its
 * environment, host modules, sweep duties, channels, providers, `ncl`
 * commands, delivery actions and approval replays. The seams no registry
 * covers sit inside work the allowlist admits, and each asks `isShadowHost()`
 * where it acts: the image store (spawn image, builds, the rebuild watcher,
 * docker cleanup), the OneCLI agent identity, host paths mounted into
 * containers, host-side task scripts, the dashboard cookie, the webhook port
 * and bind, the process temp dir, and deploy rollback. The rules those need
 * live here.
 *
 * Unset, every call site behaves exactly as before.
 */
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DATA_DIR, INSTALL_SLUG, REPO_ROOT } from './config.js';
import { readEnvValue } from './env-file.js';
import { getHostStartCallbacks, type HostStartContext } from './host-lifecycle.js';
import { getContainerImageBase } from './install-slug.js';
import { log } from './log.js';
import { scrubbedShadowEnvKeys, shadowMayRunProvider, shadowMayStartHostModule } from './shadow-allowlist.js';
import { isShadowProcess } from './shadow-flag.js';

export function isShadowHost(): boolean {
  return isShadowProcess();
}

const SHADOW_MODE_SUMMARY =
  'Shadow host mode: environment, host modules, sweep duties, channels (CLI only), providers (Claude ' +
  'only), ncl commands, delivery actions and approval replays are allowlisted; container image builds, ' +
  'docker image/build-cache cleanup, host-side task scripts and host credential mounts are disabled; ' +
  'operator mounts forced read-only; OneCLI agents, TMPDIR and the dashboard cookie are namespaced to ' +
  'this checkout; webhook server bound to 127.0.0.1';

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
 * Production's webhook server binds its port on every interface, so a shadow
 * listening on that port, the default included, fails at boot. The shadow
 * cannot see which port production chose, so it must be given its own.
 */
export function shadowWebhookPortViolation(raw: string | undefined): string | null {
  if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535) return null;
  return (
    `NANOCLAW_SHADOW=1 needs its own WEBHOOK_PORT (got ${raw === undefined ? 'none' : JSON.stringify(raw)}): ` +
    `production's webhook server holds its port on every interface. Set WEBHOOK_PORT to a free port ` +
    `in this checkout's .env or the process environment.`
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

/** Null when the shadow provider allowlist admits the provider (always, off a shadow). */
export function shadowProviderViolation(provider: string): string | null {
  if (shadowMayRunProvider(provider)) return null;
  return `Shadow host refuses a ${provider} session: only the claude provider runs without writing host credential files`;
}

/**
 * Enter shadow mode at boot, before anything can spawn or build. Returns the
 * refusal message when the configured image is outside this checkout's
 * namespace, or when no WEBHOOK_PORT of its own is set (read from `.env` here
 * too: boot copies `.env` into the environment only after this runs).
 * Otherwise points TMPDIR into this checkout — the OneCLI SDK writes CA
 * bundles and credential stubs under fixed names in `os.tmpdir()`, which
 * production's containers bind-mount — logs what shadow mode changed and the
 * environment keys the entry shim removed, and returns null. Does nothing
 * when shadow mode is off.
 */
export function enterShadowHostMode(): string | null {
  if (!isShadowHost()) return null;
  const violation =
    shadowImageViolation(CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, getContainerImageBase(REPO_ROOT)) ??
    shadowWebhookPortViolation(readEnvValue(process.cwd(), 'WEBHOOK_PORT'));
  if (violation) return violation;
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.TMPDIR = tmpDir;
  log.warn(SHADOW_MODE_SUMMARY, { image: CONTAINER_IMAGE, tmpDir, removedEnvKeys: scrubbedShadowEnvKeys() });
  return null;
}

/**
 * A shadow host's replacement for `startHostModules`, which main.ts calls
 * instead on a shadow: host-lifecycle.ts must stay byte-identical to upstream,
 * so the allowlist filters here rather than in the registry itself.
 */
export async function startShadowHostModules(ctx: HostStartContext): Promise<void> {
  for (const cb of getHostStartCallbacks()) {
    if (!shadowMayStartHostModule(cb.name)) {
      log.info('Host module not started on a shadow host', { module: cb.name || '(anonymous)' });
      continue;
    }
    await cb(ctx);
  }
}
