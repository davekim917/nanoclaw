/**
 * Vendoring map + sync for the design-artifact-loop plugin.
 *
 * ~/plugins/design-artifact-loop (github.com/davekim917/design-artifact-loop)
 * is the single development home for the skill + design_review engine. The
 * container tree carries byte-identical vendored copies so NanoClaw installs
 * need no external repo at runtime. Develop in the plugin repo, then run
 * `pnpm exec tsx scripts/vendor-design-artifact-loop.ts` and commit the result.
 * src/design-artifact-loop-vendor.test.ts fails the host suite on drift
 * (skipped on machines without the plugin repo).
 *
 * Tree-only files NOT synced (each side has a thin harness of its own):
 *   - tree  mcp-tools/design-review/index.ts        — registerTools wrapper + container root pin
 *   - tree  mcp-tools/design-review/corpus.test.ts   — same checks, tree-relative corpus path
 *   - tree  mcp-tools/design-review/fixtures.test.ts — same checks, tree-relative fixtures path
 *   - plugin server/index.ts                         — standalone stdio MCP entry
 *   - plugin server/dist/                            — committed node bundle (plugin-only)
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

export const PLUGIN_ROOT = path.join(os.homedir(), 'plugins', 'design-artifact-loop');
export const TREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Vendored path map: plugin-relative → tree-relative. Dirs sync recursively. */
export const VENDORED: Array<{ from: string; to: string; dir?: boolean }> = [
  { from: 'server/design-review.ts', to: 'container/agent-runner/src/mcp-tools/design-review/design-review.ts' },
  { from: 'server/design-review.test.ts', to: 'container/agent-runner/src/mcp-tools/design-review/design-review.test.ts' },
  { from: 'server/linter.ts', to: 'container/agent-runner/src/mcp-tools/design-review/linter.ts' },
  { from: 'server/linter.test.ts', to: 'container/agent-runner/src/mcp-tools/design-review/linter.test.ts' },
  { from: 'server/render.ts', to: 'container/agent-runner/src/mcp-tools/design-review/render.ts' },
  { from: 'server/render.test.ts', to: 'container/agent-runner/src/mcp-tools/design-review/render.test.ts' },
  { from: 'server/state.ts', to: 'container/agent-runner/src/mcp-tools/design-review/state.ts' },
  { from: 'server/state.test.ts', to: 'container/agent-runner/src/mcp-tools/design-review/state.test.ts' },
  { from: 'skills/design-artifact-loop/SKILL.md', to: 'container/skills/design-artifact-loop/SKILL.md' },
  { from: 'skills/design-artifact-loop/design-systems', to: 'container/skills/design-artifact-loop/design-systems', dir: true },
  { from: 'skills/design-artifact-loop/fixtures', to: 'container/skills/design-artifact-loop/fixtures', dir: true },
];

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

function dirsEqual(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  const files = listFiles(a);
  if (listFiles(b).join('\n') !== files.join('\n')) return false;
  return files.every((f) => fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
}

function syncOne(from: string, to: string, dir: boolean): boolean {
  const src = path.join(PLUGIN_ROOT, from);
  const dst = path.join(TREE_ROOT, to);
  if (dir) {
    if (dirsEqual(src, dst)) return false;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    return true;
  }
  const content = fs.readFileSync(src);
  if (fs.existsSync(dst) && fs.readFileSync(dst).equals(content)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return true;
}

/** Sync every vendored path; returns the tree-relative paths that changed. */
export function vendorDesignArtifactLoop(): string[] {
  if (!fs.existsSync(PLUGIN_ROOT)) {
    throw new Error(`plugin repo not found at ${PLUGIN_ROOT} — clone github.com/davekim917/design-artifact-loop there first`);
  }
  const changed: string[] = [];
  for (const { from, to, dir } of VENDORED) {
    if (syncOne(from, to, dir ?? false)) changed.push(to);
  }
  return changed;
}
