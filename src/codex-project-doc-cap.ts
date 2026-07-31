/**
 * Codex project-doc (AGENTS.md) size constants.
 *
 * Codex hard-caps the project doc it loads into the system prompt
 * (`project_doc_max_bytes`). Container spawns override this to 262144 bytes
 * (`container/agent-runner/src/providers/codex-app-server.ts`,
 * `createCodexConfigOverrides`) — `CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES`
 * below MUST match that override; the two trees share no modules, so this is
 * a documented manual sync with a test on each side.
 *
 * There is no eviction machinery here — content bloat is judged by a human
 * reading the file, never by a byte number. `warnIfOversized` only logs
 * loudly when a doc exceeds a limit; it never mutates or truncates.
 */
import { log } from './log.js';

/** Must match the `-c project_doc_max_bytes` override in codex-app-server.ts. */
export const CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES = 262144;

/** Codex's built-in default cap, used only for the host-codex sync warn (codex-sync.ts) — the host CLI does not receive the container override above. */
export const CODEX_PROJECT_DOC_DEFAULT_MAX_BYTES = 32 * 1024;

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf-8');

/** Log loudly when `content` exceeds `limitBytes`. No mutation, no truncation. */
export function warnIfOversized(label: string, content: string, limitBytes: number): void {
  const bytes = bytesOf(content);
  if (bytes <= limitBytes) return;
  log.error('Project doc exceeded size limit', { label, bytes, limitBytes });
}
