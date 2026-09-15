/**
 * Vendoring map + sync for the bootstrap workflow plugin's worker agent def.
 *
 * ~/plugins/bootstrap (github.com/davekim917/bootstrap) is the single
 * development home for the `worker-frontier` role: the plugin ships it so
 * `/orchestrate` has a worker on a bare install with no NanoClaw. NanoClaw is a
 * consumer — `container/agents/worker-frontier.md` is a byte-identical vendored
 * copy, so a fresh install needs no external repo at runtime and the two cannot
 * describe different workers.
 *
 * Develop in the plugin repo, then run
 * `pnpm exec tsx scripts/vendor-workflow-agent.ts` and commit the result — it
 * syncs the file AND refreshes the committed fingerprint below.
 * src/workflow-agent-vendor.test.ts fails on drift. Its fingerprint layer runs
 * everywhere, including CI with no plugin repo; only the live byte-identity
 * layer is skipped where ~/plugins/bootstrap is absent.
 *
 * It also vendors the WORKER MODEL/EFFORT POLICY. The plugin renders its own
 * artifacts from one hand-edited `plugins/workflow/worker-policy.json`; this
 * script reads that same file and generates `worker-policy.vendored.ts` for the
 * host and for the runner's separate Bun tree, so `CODEX_WORKER_MODELS`, the
 * manifest's `codexModel` and the container's
 * `default_subagent_reasoning_effort` all come from it instead of three
 * independently-typed literals. Flip procedure: docs/review-policy.md,
 * "Changing the worker policy".
 *
 * What is NOT vendored, deliberately:
 *   - the plugin's generated Codex role TOML. NanoClaw renders its own from
 *     this same .md (`formatCodexAgentToml`, src/claude-agent-md.ts:159-177)
 *     and writes it with its own ownership marker, so the two managers can tell
 *     their output apart. The drift test still pins the two model mappings
 *     together so the Codex half cannot fork.
 *   - everything downstream of the def: syncWorkerAgentDefs
 *     (src/container-runner.ts), codex-sync, MANAGED_WORKER_DEFS and
 *     scripts/reviewer-models.ts all keep reading the vendored copy unchanged.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The plugin checkout to vendor from. `~/plugins/bootstrap` is the live one the
 * host loads plugins out of, which is exactly why the override exists: vendoring
 * a change that has not landed on the plugin's main yet means pointing at a
 * worktree, and the alternative is mutating the live checkout to run one script.
 * Mirrors the plugin harness's own BOOTSTRAP_PLUGINS_DIR.
 */
export const PLUGIN_ROOT = process.env.BOOTSTRAP_PLUGIN_ROOT || path.join(os.homedir(), 'plugins', 'bootstrap');
export const TREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The one worker role, and the plugin file that owns it. */
export const WORKER_AGENT = 'worker-frontier';

/** Vendored path map: plugin-relative → tree-relative. */
export const VENDORED: ReadonlyArray<{ from: string; to: string }> = [
  {
    from: `plugins/workflow/agents/${WORKER_AGENT}.md`,
    to: `container/agents/${WORKER_AGENT}.md`,
  },
];

/**
 * The plugin's worker model/effort policy — ONE hand-edited file over there, and
 * the source of the def's model/effort, the Codex role's model, and the Codex
 * subagent reasoning effort. NanoClaw reads that same file so a policy flip
 * cannot land here as three separate hand edits that disagree with each other.
 */
export const PLUGIN_WORKER_POLICY = 'plugins/workflow/worker-policy.json';

/** The shape this repo consumes. The plugin's own gates validate the rest. */
export interface WorkerPolicy {
  claude: { model: string; effort: string };
  codex: { model: string; effort: string };
}

/**
 * Where the rendered constants land. TWO copies, not one: `container/agent-runner`
 * is a separate Bun package tree with no module path back into `src/` (CLAUDE.md,
 * "Container Runtime (Bun)" — the session DBs are the only shared surface), so
 * the runner cannot import the host's copy. Both are rendered from the same
 * policy in the same run and both are fingerprinted, so they cannot drift from
 * each other or from the plugin.
 */
export const GENERATED: readonly string[] = [
  'src/worker-policy.vendored.ts',
  'container/agent-runner/src/worker-policy.vendored.ts',
];

/** Parse the plugin's policy file, asserting only what this repo reads from it. */
export function parseWorkerPolicy(json: string): WorkerPolicy {
  const parsed = JSON.parse(json) as Partial<WorkerPolicy>;
  for (const runtime of ['claude', 'codex'] as const) {
    const entry = parsed[runtime];
    if (
      !entry ||
      typeof entry.model !== 'string' ||
      !entry.model ||
      typeof entry.effort !== 'string' ||
      !entry.effort
    ) {
      throw new Error(`${PLUGIN_WORKER_POLICY}: \`${runtime}\` must carry a non-empty \`model\` and \`effort\``);
    }
  }
  return parsed as WorkerPolicy;
}

/** Render the vendored constants module. Identical bytes for host and runner. */
export function renderWorkerPolicyModule(policy: WorkerPolicy): string {
  return `/**
 * GENERATED by scripts/vendor-workflow-agent.ts from the bootstrap plugin's
 * ${PLUGIN_WORKER_POLICY}. Do not edit — edit the policy in ~/plugins/bootstrap,
 * push it, then re-run the vendor script here (docs/review-policy.md,
 * "Changing the worker policy").
 *
 * Why a generated constant and not a config read: the values must be present in
 * a fresh clone with no plugin repo (CI, a container image build), and they must
 * be fingerprinted, so that an in-tree edit fails a test instead of silently
 * changing what every agent container dispatches.
 */

/** The frontier worker's Codex model — what \`worker-frontier\` dispatches to. */
export const WORKER_POLICY_CODEX_MODEL = ${JSON.stringify(policy.codex.model)};

/**
 * The frontier worker's Codex reasoning effort. Codex named roles have no
 * per-role effort field, so this lands as
 * \`[agents].default_subagent_reasoning_effort\` in the container's config.toml —
 * a GLOBAL subagent default, which a native spawn's own \`reasoning_effort\`
 * still overrides per task.
 */
export const WORKER_POLICY_CODEX_EFFORT = ${JSON.stringify(policy.codex.effort)};

/** The frontier worker's Claude model, as the plugin's agent def pins it. */
export const WORKER_POLICY_CLAUDE_MODEL = ${JSON.stringify(policy.claude.model)};

/** The frontier worker's Claude effort, as the plugin's agent def pins it. */
export const WORKER_POLICY_CLAUDE_EFFORT = ${JSON.stringify(policy.claude.effort)};
`;
}

/**
 * The plugin's generated Codex role TOML. Not vendored — read only so the drift
 * test can pin its `model` against CODEX_WORKER_MODELS.
 */
export const PLUGIN_CODEX_ROLE = `plugins/workflow-agents/agents/${WORKER_AGENT}.toml`;

/**
 * Committed fingerprint of the vendored content.
 *
 * Without it the drift test can only run where ~/plugins/bootstrap exists, so
 * CI — which has no plugin repo — would prove nothing, and an edit that dropped
 * a worker instruction from the vendored def would pass. The manifest gives CI
 * an unconditional check: the tree file must hash to the recorded value, and
 * only the vendor script can refresh that value, which requires the plugin.
 */
export const MANIFEST_PATH = path.join(TREE_ROOT, 'src/workflow-agent-vendor.manifest.json');

export interface VendorManifest {
  /** tree-relative path → sha256 of the vendored bytes */
  files: Record<string, string>;
  /**
   * `codex.model` from the plugin's worker policy, pinned against
   * CODEX_WORKER_MODELS. Cross-checked at vendor time against the plugin's
   * generated Codex role TOML, which must already agree.
   */
  codexModel: string;
}

export const sha256 = (content: Buffer | string): string => crypto.createHash('sha256').update(content).digest('hex');

export function readManifest(): VendorManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as VendorManifest;
}

/** The `model = "…"` line of a Codex role TOML. Throws rather than defaulting. */
export function codexRoleModel(toml: string): string {
  const match = /^model\s*=\s*"([^"]+)"\s*$/m.exec(toml.replace(/\r\n?/g, '\n'));
  if (!match) throw new Error(`no \`model = "…"\` line in the Codex role TOML`);
  return match[1];
}

/** Sync every vendored path and refresh the manifest; returns what changed. */
export function vendorWorkflowAgent(): string[] {
  if (!fs.existsSync(PLUGIN_ROOT)) {
    throw new Error(`plugin repo not found at ${PLUGIN_ROOT} — clone github.com/davekim917/bootstrap there first`);
  }
  const changed: string[] = [];
  const files: Record<string, string> = {};
  for (const { from, to } of VENDORED) {
    const content = fs.readFileSync(path.join(PLUGIN_ROOT, from));
    files[to] = sha256(content);
    const dst = path.join(TREE_ROOT, to);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(content)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    changed.push(to);
  }

  // The policy file is the source; the plugin's generated Codex role is the
  // cross-check. The plugin's own parity gate keeps the two in step, so a
  // disagreement here means the plugin was caught mid-flip — refuse rather than
  // vendor half a policy.
  const policy = parseWorkerPolicy(fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_WORKER_POLICY), 'utf8'));
  const roleModel = codexRoleModel(fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_CODEX_ROLE), 'utf8'));
  if (roleModel !== policy.codex.model) {
    throw new Error(
      `plugin is mid-flip: ${PLUGIN_WORKER_POLICY} says codex.model=${policy.codex.model} but ` +
        `${PLUGIN_CODEX_ROLE} says ${roleModel}. In the plugin repo run: ` +
        'node plugins/workflow-agents/scripts/sync-agent-skills.mjs',
    );
  }

  const policyModule = renderWorkerPolicyModule(policy);
  for (const to of GENERATED) {
    files[to] = sha256(policyModule);
    const dst = path.join(TREE_ROOT, to);
    if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === policyModule) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, policyModule);
    changed.push(to);
  }

  const codexModel = policy.codex.model;
  const manifest = `${JSON.stringify({ files, codexModel } satisfies VendorManifest, null, 2)}\n`;
  if (!fs.existsSync(MANIFEST_PATH) || fs.readFileSync(MANIFEST_PATH, 'utf8') !== manifest) {
    fs.writeFileSync(MANIFEST_PATH, manifest);
    changed.push(path.relative(TREE_ROOT, MANIFEST_PATH));
  }
  return changed;
}
