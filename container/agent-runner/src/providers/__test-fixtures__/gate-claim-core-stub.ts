/**
 * A guard core that exposes the one-card-per-tool-call claim API (#833) and
 * records how the caller used it, so `createEmailGateHook` can be proven to
 * (a) key the claim on the tool call rather than the command, and (b) wait on a
 * peer's requestId instead of staging a second approval card.
 *
 * Recording goes through `globalThis` rather than module state because the hook
 * dynamic-imports this file and Bun memoizes the module across tests.
 */
export const IS_NANOCLAW = true;

interface Recorder {
  keyArgs: unknown[][];
  claims: string[];
  published: Array<[string, string]>;
  abandoned: string[];
  /** When set, `claimGateRequest` answers as a LOSER with this peer requestId. */
  peerRequestId: string | null;
  /**
   * When true, the peer requestId reads back as an already-DECIDED replay
   * (`delivered`/`failed`). A live peer's card sits at `pending`, which is NOT
   * decided — that is the state the loser must wait on.
   */
  peerAlreadyDecided: boolean;
  decidedChecks: string[];
}

function rec(): Recorder {
  const g = globalThis as { __nanoclawGateClaimRec?: Recorder };
  if (!g.__nanoclawGateClaimRec) {
    g.__nanoclawGateClaimRec = {
      keyArgs: [],
      claims: [],
      published: [],
      abandoned: [],
      peerRequestId: null,
      peerAlreadyDecided: false,
      decidedChecks: [],
    };
  }
  return g.__nanoclawGateClaimRec;
}

export function gateClaimKey(...args: unknown[]): string {
  rec().keyArgs.push(args);
  return `key:${args.join('|')}`;
}

export function claimGateRequest(key: string): { owner: boolean; requestId?: string | null } {
  rec().claims.push(key);
  const peer = rec().peerRequestId;
  return peer ? { owner: false, requestId: peer } : { owner: true };
}

export function publishGateClaim(key: string, requestId: string): void {
  rec().published.push([key, requestId]);
}

export function abandonGateClaim(key: string): void {
  rec().abandoned.push(key);
}

export function gateRequestAlreadyDecided(requestId: string): boolean {
  rec().decidedChecks.push(requestId);
  return rec().peerAlreadyDecided;
}
