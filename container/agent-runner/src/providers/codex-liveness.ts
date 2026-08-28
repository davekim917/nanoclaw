export type CodexThreadStatus = 'active' | 'idle' | 'systemError' | 'notLoaded' | 'unknown';

export interface CodexHealthSnapshot {
  rootStatus: CodexThreadStatus;
  descendantStatuses: CodexThreadStatus[];
}

export interface CodexLivenessOptions {
  probeFailureLimit: number;
  inactiveSnapshotLimit: number;
  now?: () => number;
}

export type CodexLivenessDecision =
  | { kind: 'healthy' }
  | { kind: 'suspect'; reason: string; consecutiveFailures: number }
  | { kind: 'recover'; classification: 'control_plane_unresponsive' | 'protocol_desync'; reason: string };

export interface CodexLivenessSnapshot {
  lastNotificationAtMs: number;
  consecutiveProbeFailures: number;
  consecutiveInactiveSnapshots: number;
  openItems: Array<{ id: string; type: string }>;
}

// ThreadItems whose lifecycle represents work that must finish before a
// successful turn can be trusted. Keep this explicit so informational items
// such as reasoning remain version-tolerant, while commands and tools fail
// closed if app-server reports turn completion without their item/completed.
//
// Collaboration items are deliberately excluded. `collabAgentToolCall` and
// `subAgentActivity` describe a persistent parent/child relationship, not an
// execution barrier for the parent turn. Codex can leave them `inProgress`
// after the child has emitted task_complete, and can intentionally keep a
// completed child available for follow-up work until closeAgent is called.
const TURN_BLOCKING_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
]);

// Codex 0.144.x includes the final ThreadItems in turn/completed. Under load,
// the app-server can omit an individual item/completed notification even
// though that final snapshot marks the item terminal. Treat the completed-turn
// snapshot as the authoritative reconciliation source while keeping unknown
// and in-progress statuses fail-closed.
const TERMINAL_ITEM_STATUSES = new Set(['completed', 'failed', 'declined']);

// These item schemas carry no status field in Codex 0.144.x. Their presence
// in a completed turn's final item snapshot is therefore the terminal signal.
const STATUSLESS_TERMINAL_ITEM_TYPES = new Set(['webSearch', 'imageView', 'sleep']);

/** Whether a completed-turn snapshot authoritatively closes this item. */
export function isCodexTerminalTurnItem(item: unknown): boolean {
  const parsed = parseItemIdentity(item);
  if (!parsed) return false;
  const status = (item as Record<string, unknown>).status;
  return (
    (typeof status === 'string' && TERMINAL_ITEM_STATUSES.has(status)) ||
    (status === undefined && STATUSLESS_TERMINAL_ITEM_TYPES.has(parsed.type))
  );
}

/**
 * Normalize the app-server's version-dependent thread status shape.
 * Unknown shapes deliberately fail open: a responsive future Codex version
 * must not be restarted merely because it added a status variant.
 */
export function normalizeCodexThreadStatus(value: unknown): CodexThreadStatus {
  let candidate = value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    candidate = obj.type ?? obj.state ?? obj.status ?? obj.kind;
  }

  if (candidate === 'active') return 'active';
  if (candidate === 'idle') return 'idle';
  if (candidate === 'systemError' || candidate === 'system_error') return 'systemError';
  if (candidate === 'notLoaded' || candidate === 'not_loaded') return 'notLoaded';
  return 'unknown';
}

/**
 * Pure state machine for a single Codex turn. Timers and JSON-RPC live in the
 * provider; this class only decides whether observed protocol state is safe.
 */
export class CodexTurnLiveness {
  private readonly now: () => number;
  private readonly openItems = new Map<string, string>();
  private consecutiveProbeFailures = 0;
  private consecutiveInactiveSnapshots = 0;
  private lastNotificationAtMs: number;

  constructor(private readonly options: CodexLivenessOptions) {
    if (options.probeFailureLimit < 1) throw new Error('probeFailureLimit must be at least 1');
    if (options.inactiveSnapshotLimit < 1) throw new Error('inactiveSnapshotLimit must be at least 1');
    this.now = options.now ?? Date.now;
    this.lastNotificationAtMs = this.now();
  }

  noteNotification(): void {
    this.lastNotificationAtMs = this.now();
  }

  noteItemStarted(item: unknown): void {
    const parsed = parseItemIdentity(item);
    if (parsed) this.openItems.set(parsed.id, parsed.type);
    this.noteNotification();
  }

  noteItemCompleted(item: unknown): void {
    const parsed = parseItemIdentity(item);
    if (parsed) this.openItems.delete(parsed.id);
    this.noteNotification();
  }

  noteTurnEnded(turn?: unknown): CodexLivenessDecision {
    this.reconcileTerminalTurnItems(turn);
    const unfinishedExecutionItems = [...this.openItems]
      .filter(([, type]) => TURN_BLOCKING_ITEM_TYPES.has(type))
      .map(([id, type]) => `${type}:${id}`);
    this.openItems.clear();
    this.noteNotification();
    if (unfinishedExecutionItems.length > 0) {
      return {
        kind: 'recover',
        classification: 'protocol_desync',
        reason: `Codex turn completed with unfinished execution items: ${unfinishedExecutionItems.join(', ')}`,
      };
    }
    return { kind: 'healthy' };
  }

  hasOpenBlockingItems(): boolean {
    return [...this.openItems.values()].some((type) => TURN_BLOCKING_ITEM_TYPES.has(type));
  }

  private reconcileTerminalTurnItems(turn: unknown): void {
    if (!turn || typeof turn !== 'object') return;
    const items = (turn as { items?: unknown }).items;
    if (!Array.isArray(items)) return;

    for (const item of items) {
      const parsed = parseItemIdentity(item);
      if (!parsed || this.openItems.get(parsed.id) !== parsed.type) continue;
      if (isCodexTerminalTurnItem(item)) this.openItems.delete(parsed.id);
    }
  }

  noteProbeFailure(reason: string): CodexLivenessDecision {
    this.consecutiveProbeFailures++;
    if (this.consecutiveProbeFailures >= this.options.probeFailureLimit) {
      return {
        kind: 'recover',
        classification: 'control_plane_unresponsive',
        reason:
          `Codex app-server failed ${this.consecutiveProbeFailures} consecutive health probes` +
          (reason ? `: ${reason}` : ''),
      };
    }
    return { kind: 'suspect', reason, consecutiveFailures: this.consecutiveProbeFailures };
  }

  noteProbeSuccess(snapshot: CodexHealthSnapshot): CodexLivenessDecision {
    this.consecutiveProbeFailures = 0;

    if (snapshot.rootStatus === 'systemError') {
      return {
        kind: 'recover',
        classification: 'protocol_desync',
        reason: 'Codex root thread entered systemError while the turn was pending',
      };
    }

    const statuses = [snapshot.rootStatus, ...snapshot.descendantStatuses];
    const hasActiveWork = statuses.includes('active');
    const hasUnknownStatus = statuses.includes('unknown');
    if (hasActiveWork || hasUnknownStatus) {
      this.consecutiveInactiveSnapshots = 0;
      return { kind: 'healthy' };
    }

    this.consecutiveInactiveSnapshots++;
    if (this.consecutiveInactiveSnapshots >= this.options.inactiveSnapshotLimit) {
      return {
        kind: 'recover',
        classification: 'protocol_desync',
        reason:
          `Codex app-server responded but the pending root/descendant threads were inactive for ` +
          `${this.consecutiveInactiveSnapshots} consecutive probes`,
      };
    }

    return {
      kind: 'suspect',
      reason: 'Codex app-server responded but no pending root/descendant thread reported active',
      consecutiveFailures: this.consecutiveInactiveSnapshots,
    };
  }

  snapshot(): CodexLivenessSnapshot {
    return {
      lastNotificationAtMs: this.lastNotificationAtMs,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      consecutiveInactiveSnapshots: this.consecutiveInactiveSnapshots,
      openItems: [...this.openItems].map(([id, type]) => ({ id, type })),
    };
  }
}

function parseItemIdentity(item: unknown): { id: string; type: string } | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== 'string') return null;
  return { id: obj.id, type: typeof obj.type === 'string' ? obj.type : 'unknown' };
}
