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

/** The per-fire model/effort pin stored on a task, as written by `flagIntent`. */
export interface TaskPin {
  model: string | null;
  effort: string | null;
}

/**
 * Read a task's per-fire pin out of the content envelope.
 *
 * Deliberately separate from {@link parseTaskContent}: the envelope parser
 * claims no totality over the blob (see its note on `muteChat`), and the pin
 * is read by callers — the CLI's task output and the provider-migration
 * audit — that don't want the rest of it. Values come back EXACTLY as stored,
 * never alias-resolved: a pin is the operator's literal choice, and the
 * difference between the family alias `opus` (tracks the install default) and
 * the frozen id `claude-opus-5[1m]` is the whole point of having written one
 * rather than the other.
 */
export function parseTaskPin(raw: string): TaskPin {
  try {
    const parsed = JSON.parse(raw) as { flagIntent?: { turnModel?: unknown; turnEffort?: unknown } };
    const fi = parsed.flagIntent;
    return {
      model: typeof fi?.turnModel === 'string' && fi.turnModel !== '' ? fi.turnModel : null,
      effort: typeof fi?.turnEffort === 'string' && fi.turnEffort !== '' ? fi.turnEffort : null,
    };
  } catch {
    // LEGACY-COMPAT(v1-tasks): plain-string content carries no pin.
    return { model: null, effort: null };
  }
}
