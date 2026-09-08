import { readEnvFile } from '../src/env.js';
import { resolveStorageAdmissionPolicy, STORAGE_ADMISSION_POLICY_ENV_KEYS } from '../src/storage-manager.js';

// The host process loads `.env` before resolving storage policy. This script is
// a separate process launched by health-sentinel, so it supplies that same
// process-env-first view only for the admission knobs it reports.
const env = {
  ...readEnvFile([...STORAGE_ADMISSION_POLICY_ENV_KEYS]),
  ...process.env,
};
const policy = resolveStorageAdmissionPolicy(env);
process.stdout.write(`${policy.enabled ? 'enabled' : 'disabled'} ${policy.admissionRefusePct}\n`);
