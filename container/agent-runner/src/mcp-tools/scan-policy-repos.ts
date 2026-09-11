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
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-policy-repos.json');

export const SCAN_POLICY_REPOSITORY_NAMES: readonly string[] = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
