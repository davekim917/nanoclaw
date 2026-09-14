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

/** The `model = "…"` line of a Codex role TOML. Throws rather than defaulting. */
export function codexRoleModel(toml: string): string {
  const match = /^model\s*=\s*"([^"]+)"\s*$/m.exec(toml.replace(/\r\n?/g, '\n'));
  if (!match) throw new Error(`no \`model = "…"\` line in the Codex role TOML`);
  return match[1];
}

/** Sync every vendored path; returns the tree-relative paths that changed. */
export function vendorWorkflowAgent(): string[] {
  if (!fs.existsSync(PLUGIN_ROOT)) {
    throw new Error(`plugin repo not found at ${PLUGIN_ROOT} — clone github.com/davekim917/bootstrap there first`);
  }
  const changed: string[] = [];
  for (const { from, to } of VENDORED) {
    const src = path.join(PLUGIN_ROOT, from);
    const dst = path.join(TREE_ROOT, to);
    const content = fs.readFileSync(src);
    if (fs.existsSync(dst) && fs.readFileSync(dst).equals(content)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    changed.push(to);
  }
  return changed;
}
