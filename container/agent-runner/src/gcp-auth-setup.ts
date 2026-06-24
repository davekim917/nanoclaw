/**
 * GCP service-account activation for the `gcloud` / `bq` CLIs.
 *
 * The host mounts a per-group service-account key and sets
 * `GOOGLE_APPLICATION_CREDENTIALS` (see `buildMounts` / `buildContainerArgs`
 * in src/container-runner.ts). That env var is enough for the Google client
 * libraries and `gcloud auth application-default` (they read it as ADC), but
 * the `gcloud` and `bq` CLIs authenticate from gcloud's OWN credential store
 * and need an explicitly activated account — otherwise they fail with
 * "You do not currently have an active account selected".
 *
 * This runs once at agent-runner startup, for every provider, and is a no-op
 * unless a key is actually mounted. Best-effort: a missing `gcloud` binary or
 * a failed activation must never block the agent (client libs still work, and
 * the log line aids debugging).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export function activateGcpServiceAccount(log: (msg: string) => void): void {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) return;
  if (!fs.existsSync(keyFile)) {
    log(`gcloud: GOOGLE_APPLICATION_CREDENTIALS=${keyFile} not found — skipping activation`);
    return;
  }

  // gcloud's default config dir (~/.config/gcloud) is root-owned in these
  // containers — the gws accounts mount makes Docker create /home/node/.config
  // as root, but we run as node (uid 1001), so activation fails with "Could not
  // create directory". Redirect CLOUDSDK_CONFIG to a node-writable home dir.
  // The host also sets this via `-e`; defaulting it here means the fix works on
  // the next respawn without waiting for a host restart, and — because we set it
  // on THIS process's env before the provider captures `{...process.env}` — the
  // agent's own gcloud/bq invocations inherit the same activated config.
  if (!process.env.CLOUDSDK_CONFIG) process.env.CLOUDSDK_CONFIG = '/home/node/.gcloud-config';
  const cfgDir = process.env.CLOUDSDK_CONFIG;

  // Bun's execFileSync does NOT inherit mutated process.env by default — it
  // snapshots the original env at process start — so pass it explicitly, else
  // gcloud won't see the CLOUDSDK_CONFIG we just set and falls back to the
  // root-owned default dir. (Verified: Bun returns empty for a mutated var
  // under the default env, populated under an explicit env.)
  const childEnv = { ...process.env };

  try {
    fs.mkdirSync(cfgDir, { recursive: true });
    execFileSync('gcloud', ['auth', 'activate-service-account', `--key-file=${keyFile}`, '--quiet'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: childEnv,
    });
    const project = process.env.CLOUDSDK_CORE_PROJECT;
    if (project) {
      execFileSync('gcloud', ['config', 'set', 'project', project, '--quiet'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: childEnv,
      });
    }
    log(`gcloud: activated service account from ${keyFile}${project ? ` (project ${project})` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`gcloud: service-account activation failed — CLIs may need manual auth (client libs unaffected): ${detail}`);
  }
}
