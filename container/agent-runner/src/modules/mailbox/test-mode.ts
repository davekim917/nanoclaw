/**
 * In-memory test mode for the fork mailbox.
 *
 * Its own module rather than a flag inside index.ts: leaf ops (wiki-lint.ts)
 * need to know whether the session DBs are the in-memory test pair, and
 * importing the barrel from a leaf would close an import cycle.
 */
let testMode = false;

/** Test harness only — see testing.ts. */
export function setMailboxTestMode(enabled: boolean): void {
  testMode = enabled;
}

export function isMailboxTestMode(): boolean {
  return testMode;
}
