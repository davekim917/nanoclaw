#!/usr/bin/env node
/**
 * Every JSON artifact `scripts/deploy.sh` writes, written by a JSON encoder.
 *
 *   node scripts/write-deploy-json.mjs rollback-manifest   > data/deploy-rollback.json
 *   node scripts/write-deploy-json.mjs status              > logs/deploy-status.json
 *
 * The script used to build both with `printf '{"…":"%s"}'` templates, which are
 * only correct while no value carries a character JSON gives meaning to. One
 * can: systemd escapes every byte a unit id may not hold literally — whitespace
 * included — as `\xNN`, so a legitimately-named unit (`systemd-escape` output,
 * e.g. `nanoclaw-worker@blue\x2dgreen.service`) puts a BACKSLASH in the text,
 * and both artifacts now carry unit names.
 *
 * Neither failure is visible where it happens:
 *
 *  - the manifest: the write succeeds, the restart hands off, and on the next
 *    boot `readJson` (src/deploy-crash-guard.ts:111-117) catches the parse
 *    error and answers null, `evaluateBoot` (:134) reads null as `no-op`, and
 *    `runDeployCrashGuard` (:273) returns — so a crashing deployment silently
 *    loses automatic rollback for the host AND every sibling service;
 *  - the status: it is the operator-facing artifact, read by the announcer and
 *    by the health alert, so a malformed one turns a reported failure into
 *    silence at exactly the moment somebody needed to hear about it.
 *
 * ONE file rather than one per artifact, because the defect was not a bad
 * escape, it was a second call site nobody audited: with every deploy JSON
 * emitted from here, a third artifact has one obvious place to be written and
 * `grep -n "printf '{" scripts/deploy.sh` is a complete audit.
 *
 * Every field goes through the encoder, including ones whose producers cannot
 * emit a metacharacter today (`commit` is a 40-hex sha validated at deploy.sh's
 * post-pull gate; `imageBase` is `nanoclaw-agent-v2-<8 hex>` from
 * setup/lib/install-slug.sh) — that is a property of today's producers, not of
 * the format, and a field added later should be safe by construction.
 *
 * Input is the environment, never argv, so nothing is interpolated into a
 * command line either. `NANOCLAW_ROLLBACK_UNITS` is NEWLINE-delimited: a unit
 * id cannot contain a newline (systemd escapes it `\x0a`), which makes it the
 * one separator that is unambiguous for this input.
 *
 * Exits non-zero having written nothing usable if it cannot produce the
 * artifact. deploy.sh fails the deploy on that for the manifest, before the
 * handoff where its trap still works; for the status it falls back to a
 * literal-only line, because the reporter of last resort must not depend on
 * more than the shell itself.
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
    // Emitted whenever the guard is armed, `[]` included. An ABSENT key means a
    // deploy.sh that predates sibling restarts wrote this; `[]` means this
    // deploy looked and found none. `readRestartedUnits` reports those
    // differently, so this must never omit the key.
    restartedUnits: (env.NANOCLAW_ROLLBACK_UNITS ?? '').split('\n').filter((unit) => unit.length > 0),
  };
}

function status() {
  // `status` is the field the announcer branches on, so an unrecognised value
  // is refused rather than passed through: deploy.sh's fallback below can then
  // reproduce it from a closed set of literals without interpolating anything
  // it has not itself authored.
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
