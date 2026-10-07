import fs from 'fs';
import path from 'path';

import { REPO_ROOT } from './config.js';

const DEPLOY_STATUS_PATH = path.resolve(REPO_ROOT, 'logs', 'deploy-status.json');

/** A status this young at boot was written by the deploy that restarted this process. */
export const RECENT_DEPLOY_MS = 300_000;

export interface DeployStatus {
  status?: 'ok' | 'failed' | 'running';
  step?: string;
  error?: string;
  mtimeMs: number;
}

export function readDeployStatus(file: string = DEPLOY_STATUS_PATH): DeployStatus | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const { mtimeMs } = fs.statSync(file);
    return { ...(JSON.parse(raw) as Omit<DeployStatus, 'mtimeMs'>), mtimeMs };
  } catch {
    return null;
  }
}

export function consumeDeployStatus(file: string = DEPLOY_STATUS_PATH): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore — racy unlink is fine */
  }
}

/** True when this boot follows a deploy that reported success; read before anything consumes the file. */
export function bootFollowsSuccessfulDeploy(now = Date.now(), file: string = DEPLOY_STATUS_PATH): boolean {
  const status = readDeployStatus(file);
  return status?.status === 'ok' && now - status.mtimeMs <= RECENT_DEPLOY_MS;
}
