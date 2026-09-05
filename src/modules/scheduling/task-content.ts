/**
 * The storage-neutral task content envelope, and its shared parser.
 *
 * One JSON blob lives in each task row's `content` column: `{prompt, script,
 * scriptHost, threadAnchor, originSessionId}`. `scriptHost` and
 * `threadAnchor` are fork-only fields with no upstream counterpart — see
 * `src/cli/resources/tasks.ts` for how each is written and read. `muteChat`
 * is also written into this envelope (`create.ts`) but is not part of this
 * shape: only the agent-runner reads it, so parsing it here would claim a
 * totality over the envelope that the callers below don't need.
 */
export interface TaskContent {
  prompt: string;
  script: string | null;
  scriptHost: boolean;
  threadAnchor: boolean;
  originSessionId: string | null;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      scriptHost: parsed.scriptHost === true,
      threadAnchor: parsed.threadAnchor !== false,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
    };
  } catch {
    // LEGACY-COMPAT(v1-tasks): plain-string content from rows that predate the
    // JSON envelope. Removable once no pre-v2 session DBs remain in the wild.
    return { prompt: raw, script: null, scriptHost: false, threadAnchor: true, originSessionId: null };
  }
}
