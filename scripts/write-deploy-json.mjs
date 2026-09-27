#!/usr/bin/env node
/**
 * Every JSON artifact `scripts/deploy.sh` writes, written by a JSON encoder.
 *
 *   node scripts/write-deploy-json.mjs rollback-manifest   > data/deploy-rollback.json
 *   node scripts/write-deploy-json.mjs status              > logs/deploy-status.json
 *
 * Never a `printf` template: systemd-escaped unit ids carry backslashes, and a malformed manifest
 * silently disables automatic rollback while a malformed status silences the failure report.
 * Keep every deploy JSON in this one file, and encode every field, even ones that can't hold a
 * metacharacter today.
 *
 * Input is the environment, never argv. `NANOCLAW_ROLLBACK_UNITS` is NEWLINE-delimited: a unit id
 * cannot contain a newline. Exits non-zero having written nothing usable if it cannot produce the
 * artifact.
 */
const env = process.env;
const shape = process.argv[2];

function fail(message) {
  process.stderr.write(`write-deploy-json: ${message}\n`);
  process.exit(1);
}

function rollbackManifest() {
  const commit = env.NANOCLAW_ROLLBACK_COMMIT ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail(`NANOCLAW_ROLLBACK_COMMIT is not a 40-character sha (got ${commit.length} chars)`);
  }
  return {
    commit,
    // "" is meaningful: this deploy did not retag :pre-deploy, so the guard must
    // not retag anything (deploy.sh, and `if (manifest.imageBase)` in the guard).
    imageBase: env.NANOCLAW_ROLLBACK_IMAGE_BASE ?? '',
    timestamp: env.NANOCLAW_ROLLBACK_TIMESTAMP ?? '',
    node: env.NANOCLAW_ROLLBACK_NODE ?? '',
    // Always emitted, `[]` included: an ABSENT key means an older deploy.sh wrote this, which
    // `readRestartedUnits` reports differently.
    restartedUnits: (env.NANOCLAW_ROLLBACK_UNITS ?? '').split('\n').filter((unit) => unit.length > 0),
  };
}

function status() {
  // Refused rather than passed through, so deploy.sh's fallback can reproduce it from a closed
  // set of literals.
  const value = env.NANOCLAW_STATUS_STATUS ?? '';
  if (value !== 'ok' && value !== 'running' && value !== 'failed') {
    fail(`NANOCLAW_STATUS_STATUS must be ok|running|failed, got ${JSON.stringify(value)}`);
  }
  return {
    status: value,
    step: env.NANOCLAW_STATUS_STEP ?? '',
    error: env.NANOCLAW_STATUS_ERROR ?? '',
    timestamp: env.NANOCLAW_STATUS_TIMESTAMP ?? '',
  };
}

if (shape !== 'rollback-manifest' && shape !== 'status') {
  fail(`unknown shape ${JSON.stringify(shape ?? '')} — expected rollback-manifest or status`);
}

process.stdout.write(`${JSON.stringify(shape === 'status' ? status() : rollbackManifest())}\n`);
