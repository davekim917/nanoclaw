/**
 * The gcloud/bq CLIs authenticate from gcloud's own credential store, not GOOGLE_APPLICATION_CREDENTIALS, so a
 * mounted key must be activated explicitly. Best-effort: a failure must never block the agent.
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

  // gcloud's default config dir is root-owned in these containers (Docker creates /home/node/.config), so
  // redirect it. Set on this process before the provider snapshots env so the agent's own gcloud/bq inherit it.
  if (!process.env.CLOUDSDK_CONFIG) process.env.CLOUDSDK_CONFIG = '/home/node/.gcloud-config';
  const cfgDir = process.env.CLOUDSDK_CONFIG;

  // Bun's execFileSync snapshots the env at process start and ignores later mutation, so pass it explicitly.
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
