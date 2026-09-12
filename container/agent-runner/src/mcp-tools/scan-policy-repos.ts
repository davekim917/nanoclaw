/**
 * Single source of truth, RUNNER side, for which repos are under host-managed
 * secret-scan policy (#666, #680 follow-up). git-worktrees.ts's own
 * `isScanPolicyRepositoryName` reads this list rather than hardcoding a name
 * inline, so the list itself lives in exactly one place per side.
 *
 * The list is data (scan-policy-repos.json, co-located with this file), read
 * with plain `fs.readFileSync` + `JSON.parse` — not a TypeScript/JSON module
 * import — and this file imports nothing Bun-specific (no `bun:*`, no Bun
 * globals): container/agent-runner is a separate Bun package tree with its
 * own tsconfig.json (`rootDir: ./src`), so a host `src/**` file cannot
 * `import` this .ts module without failing the host's own
 * `pnpm run typecheck` (TS6059, file outside rootDir). Keeping this module
 * plain lets src/managed-git-hooks.test.ts load the SAME JSON file with an
 * ordinary `fs.readFileSync` + `JSON.parse` too — no cross-package import,
 * no regex-parsing of this file's source — and assert it deep-equals the
 * host's own `SCAN_POLICY_REPOSITORY_NAMES` (src/managed-git-hooks.ts), so
 * the two lists can never silently drift apart.
 *
 * `loadScanPolicyRepositoryNames` is deliberately NOT invoked at module load
 * (#682 round 2 blocking fix). This module is pulled in transitively by
 * every MCP tool (mcp-tools/index.ts -> git-worktrees.ts -> here), so an
 * eager `JSON.parse(fs.readFileSync(...))` at module scope meant a missing,
 * unreadable or malformed data file threw during import and took down the
 * whole `nanoclaw` MCP server — every tool, in every container — until
 * restart. Reading is now a plain function call the caller makes lazily
 * (git-worktrees.ts's `isScanPolicyRepositoryName`, memoized there), and any
 * failure — read error, parse error, or a value that parses but isn't a
 * non-empty array of non-empty strings (`[]`, `{"wiki":true}`, a bare
 * `"wiki"`) — returns `null` instead of throwing or silently loading
 * something that isn't a usable list.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-policy-repos.json');

/**
 * Reads and validates the scan-policy repository name list from `dataPath`
 * (default: scan-policy-repos.json next to this file). Returns the list only
 * when it parses as a non-empty array of non-empty strings. Returns `null`
 * on any failure — the file is missing or unreadable, its contents aren't
 * valid JSON, or the parsed value has the wrong shape (not an array, an
 * empty array, an array with a non-string or empty-string entry). Never
 * throws: every failure mode is caught and folded into the `null` result so
 * callers can decide what "no usable list" means for them, rather than this
 * function crashing whatever imported it.
 */
export function loadScanPolicyRepositoryNames(dataPath: string = DATA_PATH): readonly string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(dataPath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((entry): entry is string => typeof entry === 'string' && entry.length > 0)) return null;
  return parsed;
}
