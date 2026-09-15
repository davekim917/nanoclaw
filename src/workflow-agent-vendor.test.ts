/**
 * Drift tripwire for the vendored bootstrap worker agent def.
 *
 * ~/plugins/bootstrap is the development home for `worker-frontier`; the
 * container tree carries a byte-identical vendored copy (see
 * scripts/vendor-workflow-agent.ts).
 *
 * Two layers, because CI has no plugin repo:
 *
 *  1. UNCONDITIONAL — the vendored file must hash to the value recorded in
 *     src/workflow-agent-vendor.manifest.json, and CODEX_WORKER_MODELS must
 *     match the model recorded there. Only the vendor script refreshes those
 *     values and it requires the plugin repo, so an in-tree edit — dropping a
 *     worker instruction from the def, say — fails here on every machine. A
 *     suite that skipped wholesale off a developer laptop would have proved
 *     nothing at all.
 *  2. PLUGIN PRESENT — additionally assert live byte-identity with the plugin
 *     and that the recorded model still matches the plugin's Codex role, which
 *     is what catches the plugin moving underneath a stale manifest.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { CODEX_WORKER_MODELS } from './claude-agent-md.js';
import {
  PLUGIN_CODEX_ROLE,
  PLUGIN_ROOT,
  TREE_ROOT,
  VENDORED,
  WORKER_AGENT,
  codexRoleModel,
  readManifest,
  sha256,
} from './workflow-agent-vendor.js';

const REGEN = 'pnpm exec tsx scripts/vendor-workflow-agent.ts';
const hasPluginRepo = fs.existsSync(PLUGIN_ROOT);
const manifest = readManifest();

describe('vendored worker agent matches the committed fingerprint', () => {
  it('records exactly the vendored paths', () => {
    expect(Object.keys(manifest.files).sort()).toEqual(VENDORED.map((v) => v.to).sort());
  });

  for (const { to } of VENDORED) {
    it(`${to} hashes to the recorded fingerprint`, () => {
      expect(sha256(fs.readFileSync(path.join(TREE_ROOT, to))), `${to} was edited in place — run: ${REGEN}`).toBe(
        manifest.files[to],
      );
    });
  }

  /**
   * The Codex halves live in two repos with nothing forcing agreement: the
   * plugin's role TOML carries the model it dispatches, and this repo reads
   * CODEX_WORKER_MODELS. Pinned through the manifest so the check survives on a
   * machine with no plugin repo — otherwise the Claude defs stay identical
   * while the two Codex mappings silently fork to different models.
   */
  it('CODEX_WORKER_MODELS agrees with the recorded Codex model', () => {
    expect(
      CODEX_WORKER_MODELS[WORKER_AGENT],
      `CODEX_WORKER_MODELS['${WORKER_AGENT}'] and the vendor manifest name different Codex models`,
    ).toBe(manifest.codexModel);
  });
});

describe.skipIf(!hasPluginRepo)('vendored worker agent matches the live plugin repo', () => {
  for (const { from, to } of VENDORED) {
    it(`${to} is byte-identical to plugin ${from}`, () => {
      expect(
        fs.readFileSync(path.join(TREE_ROOT, to)).equals(fs.readFileSync(path.join(PLUGIN_ROOT, from))),
        `${to} drifted from the plugin — run: ${REGEN}`,
      ).toBe(true);
    });
  }

  it('the recorded Codex model still matches the plugin Codex role', () => {
    const toml = fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_CODEX_ROLE), 'utf8');
    expect(manifest.codexModel, `${PLUGIN_CODEX_ROLE} changed model — run: ${REGEN}`).toBe(codexRoleModel(toml));
  });
});

describe('codexRoleModel', () => {
  it('reads the model line and tolerates CRLF', () => {
    expect(codexRoleModel('name = "w"\r\nmodel = "gpt-5.6-sol"\r\n')).toBe('gpt-5.6-sol');
  });

  it('throws rather than defaulting when no model line exists', () => {
    expect(() => codexRoleModel('name = "w"\n')).toThrow(/model/);
  });
});
