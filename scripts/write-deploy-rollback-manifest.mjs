#!/usr/bin/env node
/**
 * Write the post-deploy crash-guard rollback manifest to stdout, as JSON.
 *
 * `scripts/deploy.sh` used to build this object with `printf`, pasting each
 * value into a `{"commit":"%s",...}` template. That is only correct while no
 * value contains a character JSON gives meaning to, and one of them can:
 * systemd escapes every byte a unit id may not carry literally — whitespace
 * included — as `\xNN`, so a legitimately-named unit (`systemd-escape` output,
 * e.g. `nanoclaw-worker@blue\x2dgreen.service`) puts a BACKSLASH in the list.
 * The template then emitted `"...blue\x2dgreen..."`, which is not valid JSON.
 *
 * That failure is silent and lands two processes later: the deploy's own write
 * succeeds, the restart hands off, and on the next boot
 * `readJson` (src/deploy-crash-guard.ts:111-117) catches the parse error and
 * answers null, `evaluateBoot` (:134) reads null as `no-op`, and
 * `runDeployCrashGuard` (:273) returns — so a crashing deployment silently
 * loses automatic rollback for the host AND for every sibling service, which
 * is the one situation the manifest exists for.
 *
 * So the manifest is written by a JSON encoder, not by a template, and every
 * field goes through it — `commit` and `imageBase` cannot carry a
 * metacharacter today (a 40-hex sha validated at deploy.sh's post-pull gate,
 * and `nanoclaw-agent-v2-<8 hex>` from setup/lib/install-slug.sh), but that is
 * a property of today's producers, not of the format, and a field added later
 * should be safe by construction rather than by re-derivation.
 *
 * Input is the environment, never argv, so nothing is interpolated into a
 * command line either. `NANOCLAW_ROLLBACK_UNITS` is NEWLINE-delimited: unit
 * ids cannot contain a newline (systemd escapes it as `\x0a`), which makes it
 * the one separator that is unambiguous for this input.
 *
 * Exits non-zero without writing anything usable if it cannot produce a
 * manifest worth arming the guard with; deploy.sh fails the deploy on that,
 * before the handoff, where its rollback trap still works.
 */
const env = process.env;

const commit = env.NANOCLAW_ROLLBACK_COMMIT ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) {
  process.stderr.write(
    `write-deploy-rollback-manifest: NANOCLAW_ROLLBACK_COMMIT is not a 40-character sha (got ${commit.length} chars)\n`,
  );
  process.exit(1);
}

const manifest = {
  commit,
  // "" is meaningful: this deploy did not retag :pre-deploy, so the guard must
  // not retag anything (deploy.sh, and `if (manifest.imageBase)` in the guard).
  imageBase: env.NANOCLAW_ROLLBACK_IMAGE_BASE ?? '',
  timestamp: env.NANOCLAW_ROLLBACK_TIMESTAMP ?? '',
  node: env.NANOCLAW_ROLLBACK_NODE ?? '',
  // Emitted whenever the guard is armed, `[]` included. An ABSENT key means a
  // deploy.sh that predates sibling restarts wrote this; `[]` means this deploy
  // looked and found none. The guard reports those differently, so this must
  // never omit the key.
  restartedUnits: (env.NANOCLAW_ROLLBACK_UNITS ?? '').split('\n').filter((unit) => unit.length > 0),
};

process.stdout.write(`${JSON.stringify(manifest)}\n`);
