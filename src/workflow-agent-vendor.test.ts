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
  GENERATED,
  PLUGIN_CODEX_ROLE,
  PLUGIN_ROOT,
  PLUGIN_WORKER_POLICY,
  TREE_ROOT,
  VENDORED,
  WORKER_AGENT,
  assertPluginNotMidFlip,
  claudeRoleDispatch,
  codexRoleModel,
  parseWorkerPolicy,
  readManifest,
  renderWorkerPolicyModule,
  sha256,
} from './workflow-agent-vendor.js';
import {
  WORKER_POLICY_CLAUDE_EFFORT,
  WORKER_POLICY_CLAUDE_MODEL,
  WORKER_POLICY_CODEX_EFFORT,
  WORKER_POLICY_CODEX_MODEL,
} from './worker-policy.vendored.js';

const REGEN = 'pnpm exec tsx scripts/vendor-workflow-agent.ts';
const hasPluginRepo = fs.existsSync(PLUGIN_ROOT);
const manifest = readManifest();

describe('vendored worker agent matches the committed fingerprint', () => {
  it('records exactly the vendored and generated paths', () => {
    expect(Object.keys(manifest.files).sort()).toEqual([...VENDORED.map((v) => v.to), ...GENERATED].sort());
  });

  for (const to of [...VENDORED.map((v) => v.to), ...GENERATED]) {
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

  /**
   * Both copies of the generated policy must be the same bytes. They are
   * separate files because the runner's Bun tree cannot import the host's
   * module, and separate files are exactly what drifts; one hash for both is
   * what makes that impossible.
   */
  it('the host and runner copies of the worker policy are byte-identical', () => {
    const [host, runner] = GENERATED.map((to) => fs.readFileSync(path.join(TREE_ROOT, to), 'utf8'));
    expect(host, `${GENERATED.join(' and ')} disagree — run: ${REGEN}`).toBe(runner);
  });

  /**
   * The constants the rest of the tree actually imports, against the file the
   * manifest hashed. A hash check alone would pass a module that exported the
   * right bytes under the wrong names.
   */
  it('the exported constants are the ones in the fingerprinted module', () => {
    const source = fs.readFileSync(path.join(TREE_ROOT, GENERATED[0]), 'utf8');
    for (const [name, value] of [
      ['WORKER_POLICY_CODEX_MODEL', WORKER_POLICY_CODEX_MODEL],
      ['WORKER_POLICY_CODEX_EFFORT', WORKER_POLICY_CODEX_EFFORT],
      ['WORKER_POLICY_CLAUDE_MODEL', WORKER_POLICY_CLAUDE_MODEL],
      ['WORKER_POLICY_CLAUDE_EFFORT', WORKER_POLICY_CLAUDE_EFFORT],
    ]) {
      expect(source, `${name} is not exported by ${GENERATED[0]}`).toContain(
        `export const ${name} = ${JSON.stringify(value)};`,
      );
    }
    expect(WORKER_POLICY_CODEX_MODEL).toBe(manifest.codexModel);
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

  /**
   * The whole point of the policy file: the plugin moves, this fails. Rendering
   * from the live policy and comparing bytes catches a model change, an effort
   * change, and a change to the module's shape alike.
   */
  it('the vendored policy module is the current render of the plugin policy', () => {
    const policy = parseWorkerPolicy(fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_WORKER_POLICY), 'utf8'));
    const expected = renderWorkerPolicyModule(policy);
    for (const to of GENERATED) {
      expect(
        fs.readFileSync(path.join(TREE_ROOT, to), 'utf8'),
        `${to} drifted from ${PLUGIN_WORKER_POLICY} — run: ${REGEN}`,
      ).toBe(expected);
    }
  });
});

describe('parseWorkerPolicy', () => {
  const valid = '{"claude":{"model":"m","effort":"e"},"codex":{"model":"n","effort":"f"}}';

  it('reads the four fields this repo consumes', () => {
    expect(parseWorkerPolicy(valid)).toMatchObject({ codex: { model: 'n', effort: 'f' } });
  });

  /**
   * Throw rather than default. A missing effort silently becoming `"undefined"`
   * would write a config.toml Codex rejects at spawn, on every container.
   */
  it.each([
    ['no codex entry', '{"claude":{"model":"m","effort":"e"}}'],
    ['empty model', '{"claude":{"model":"","effort":"e"},"codex":{"model":"n","effort":"f"}}'],
    ['missing effort', '{"claude":{"model":"m"},"codex":{"model":"n","effort":"f"}}'],
    ['effort not a string', '{"claude":{"model":"m","effort":3},"codex":{"model":"n","effort":"f"}}'],
  ])('throws on %s', (_name, json) => {
    expect(() => parseWorkerPolicy(json)).toThrow(/model.*effort|effort/);
  });
});

describe('claudeRoleDispatch', () => {
  it('reads model and effort out of the frontmatter and tolerates CRLF', () => {
    const md = '---\r\nname: w\r\nmodel: claude-opus-5[1m]\r\neffort: high\r\n---\r\n\r\nbody\r\n';
    expect(claudeRoleDispatch(md)).toEqual({ model: 'claude-opus-5[1m]', effort: 'high' });
  });

  it.each([
    ['no frontmatter block', 'just prose\n'],
    ['no model line', '---\nname: w\neffort: high\n---\n\nbody\n'],
    ['no effort line', '---\nname: w\nmodel: claude-opus-5[1m]\n---\n\nbody\n'],
  ])('throws rather than defaulting on %s', (_name, md) => {
    expect(() => claudeRoleDispatch(md)).toThrow();
  });
});

/**
 * The refusal is symmetric on purpose. Checking only the Codex model — as this
 * shipped in the first commit — leaves the half that actually decides Claude
 * dispatch unguarded: the def's frontmatter is vendored verbatim, so a policy
 * edit with the plugin's sync not re-run renders new constants beside a stale
 * `model:`/`effort:`, and every drift test still passes because each artifact
 * agrees with the thing it was rendered from. Found by review r1 on #837.
 */
describe('assertPluginNotMidFlip', () => {
  const policy = {
    claude: { model: 'claude-opus-5[1m]', effort: 'high' },
    codex: { model: 'gpt-5.6-sol', effort: 'high' },
  };
  const codexToml = 'name = "worker-frontier"\nmodel = "gpt-5.6-sol"\n';
  const claudeMd = '---\nname: worker-frontier\nmodel: claude-opus-5[1m]\neffort: high\n---\n\nbody\n';

  it('accepts a plugin whose artifacts all agree with the policy', () => {
    expect(() => assertPluginNotMidFlip(policy, codexToml, claudeMd)).not.toThrow();
  });

  it('refuses a stale Codex role model, naming both values', () => {
    expect(() => assertPluginNotMidFlip(policy, 'model = "gpt-6-astra"\n', claudeMd)).toThrow(
      /codex\.model=gpt-5\.6-sol.*gpt-6-astra/s,
    );
  });

  it('refuses a stale Claude frontmatter model, naming both values', () => {
    const stale = '---\nname: worker-frontier\nmodel: claude-fable-5-1[1m]\neffort: high\n---\n\nbody\n';
    expect(() => assertPluginNotMidFlip(policy, codexToml, stale)).toThrow(
      /claude\.model=claude-opus-5\[1m\].*claude-fable-5-1\[1m\]/s,
    );
  });

  /**
   * Effort separately from model: a `medium`/`high` flip changes no model id at
   * all, so a check that only compared models would pass it through.
   */
  it('refuses a stale Claude frontmatter effort, naming both values', () => {
    const stale = '---\nname: worker-frontier\nmodel: claude-opus-5[1m]\neffort: medium\n---\n\nbody\n';
    expect(() => assertPluginNotMidFlip(policy, codexToml, stale)).toThrow(/claude\.effort=high.*medium/s);
  });

  it('reports every mismatch at once rather than the first', () => {
    const stale = '---\nname: worker-frontier\nmodel: claude-fable-5-1[1m]\neffort: medium\n---\n\nbody\n';
    const call = () => assertPluginNotMidFlip(policy, 'model = "gpt-6-astra"\n', stale);
    expect(call).toThrow(/codex\.model=/);
    expect(call).toThrow(/claude\.model=/);
    expect(call).toThrow(/claude\.effort=/);
    expect(call).toThrow(/sync-agent-skills\.mjs/);
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
