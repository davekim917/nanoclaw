/**
 * The task content envelope in each task row's `content` column. `muteChat` is
 * also written into it but deliberately not parsed here: only the runner reads it.
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
 * Read a task's per-fire pin, EXACTLY as stored and never alias-resolved: the
 * alias `opus` (tracks the default) and a frozen id are different choices.
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
