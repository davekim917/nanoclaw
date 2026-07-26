import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Create the agent's persistent memory scaffold, container-side, at boot.
 *
 * The runner scaffolds through `/workspace/agent/memory`, the compatibility
 * link to the host-mounted workgroup canon at `/workspace/workgroup/memory`.
 * Every sibling provider in the workgroup therefore resolves the same
 * persistent tree.
 *
 * The default memory files live as real markdown templates next to this module
 * (under `templates/`) — not as strings in code — so the
 * doctrine is editable as markdown and the agent receives an unescaped copy.
 * They ship in the mounted `/app/src` tree, so no image change is needed.
 *
 * Idempotent — only writes what's missing, so the agent's own edits and
 * accumulated memory are never clobbered on a later wake. Every provider uses
 * the same tree.
 */
const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

export function ensureMemoryScaffold(baseDir = '/workspace/agent'): void {
  const memoryDir = path.join(baseDir, 'memory');
  const systemDir = path.join(memoryDir, 'system');

  fs.mkdirSync(systemDir, { recursive: true });

  copyTemplateIfMissing('index.md', path.join(memoryDir, 'index.md'));
  copyTemplateIfMissing(path.join('system', 'index.md'), path.join(systemDir, 'index.md'));
  copyTemplateIfMissing(path.join('system', 'definition.md'), path.join(systemDir, 'definition.md'));
}

function copyTemplateIfMissing(template: string, dest: string): void {
  try {
    fs.copyFileSync(path.join(TEMPLATES_DIR, template), dest, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'EEXIST') throw err;
  }
}
