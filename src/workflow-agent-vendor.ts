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
 * `pnpm exec tsx scripts/vendor-workflow-agent.ts` and commit the result.
 * src/workflow-agent-vendor.test.ts fails the host suite on drift (skipped on
 * machines without the plugin repo).
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

export const PLUGIN_ROOT = path.join(os.homedir(), 'plugins', 'bootstrap');
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
  /** the model in the plugin's generated Codex role, pinned against CODEX_WORKER_MODELS */
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

  const codexModel = codexRoleModel(fs.readFileSync(path.join(PLUGIN_ROOT, PLUGIN_CODEX_ROLE), 'utf8'));
  const manifest = `${JSON.stringify({ files, codexModel } satisfies VendorManifest, null, 2)}\n`;
  if (!fs.existsSync(MANIFEST_PATH) || fs.readFileSync(MANIFEST_PATH, 'utf8') !== manifest) {
    fs.writeFileSync(MANIFEST_PATH, manifest);
    changed.push(path.relative(TREE_ROOT, MANIFEST_PATH));
  }
  return changed;
}
