/** Its own module: leaf ops need the flag, and importing the barrel from a leaf would close an import cycle. */
let testMode = false;

/** Test harness only — see testing.ts. */
export function setMailboxTestMode(enabled: boolean): void {
  testMode = enabled;
}

export function isMailboxTestMode(): boolean {
  return testMode;
}
