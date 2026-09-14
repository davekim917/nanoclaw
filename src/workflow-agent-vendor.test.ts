/**
 * Drift tripwire for the vendored bootstrap worker agent def.
 *
 * ~/plugins/bootstrap is the development home for `worker-frontier`; the
 * container tree carries a byte-identical vendored copy (see
 * scripts/vendor-workflow-agent.ts). This test fails when either side is edited
 * without re-running the vendor script, so drift surfaces on the next host test
 * run instead of as two hosts quietly dispatching different workers.
 *
 * Skipped entirely on machines without the plugin repo — a fresh NanoClaw
 * install has only the vendored copy, which is self-contained and correct.
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
} from './workflow-agent-vendor.js';

const hasPluginRepo = fs.existsSync(PLUGIN_ROOT);

describe.skipIf(!hasPluginRepo)('worker agent def matches the bootstrap plugin', () => {
  for (const { from, to } of VENDORED) {
    it(`${to} matches plugin ${from}`, () => {
      expect(
        fs.readFileSync(path.join(TREE_ROOT, to)).equals(fs.readFileSync(path.join(PLUGIN_ROOT, from))),
        `${to} drifted — run: pnpm exec tsx scripts/vendor-workflow-agent.ts`,
      ).toBe(true);
    });
  }

  /**
   * The two runtimes' model mappings live in different repos: the plugin's Codex
   * role TOML carries the model it dispatches, and NanoClaw's own converter
   * reads CODEX_WORKER_MODELS. Nothing makes them agree by construction, so pin
   * them here — otherwise the Claude halves stay vendored-identical while the
   * Codex halves silently fork to two different models.
   */
  it('CODEX_WORKER_MODELS agrees with the model in the plugin Codex role', () => {
    const toml = fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_CODEX_ROLE), 'utf8');
    expect(
      CODEX_WORKER_MODELS[WORKER_AGENT],
      `CODEX_WORKER_MODELS['${WORKER_AGENT}'] and ${PLUGIN_CODEX_ROLE} name different Codex models`,
    ).toBe(codexRoleModel(toml));
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
