export type MemoryAdmissionResult =
  | { status: 'admitted'; budgetMb: number; requestMb: number }
  | { status: 'queued'; budgetMb: number; requestMb: number; position: number }
  | { status: 'rejected'; reason: 'request_exceeds_budget'; budgetMb: number; requestMb: number };

export type MemoryAdmissionPriority = 'interactive' | 'scheduled';

export const SCHEDULED_PRIORITY_AGING_MS = 15 * 60 * 1000;

interface MemoryAdmissionOptions {
  scheduledAgingMs?: number;
  now?: () => number;
}

interface QueuedRequest<T> {
  id: string;
  requestMb: number;
  payload: T;
  priority: MemoryAdmissionPriority;
  enqueuedAt: number;
  sequence: number;
}

/**
 * Host-local priority-aware memory reservation controller.
 * Reservations cover both in-flight spawns and active containers.
 * Interactive work runs before scheduled work, FIFO is preserved within each
 * effective priority class, and scheduled work ages into the interactive
 * class so sustained chat traffic cannot starve it forever.
 */
export class MemoryAdmissionController<T> {
  private readonly reservations = new Map<string, number>();
  private readonly queue: QueuedRequest<T>[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly scheduledAgingMs: number;
  private readonly now: () => number;
  private nextSequence = 0;

  constructor(
    readonly budgetMb: number,
    options: MemoryAdmissionOptions = {},
  ) {
    if (!Number.isInteger(budgetMb) || budgetMb <= 0) {
      throw new Error(`Memory admission budget must be a positive integer MiB value: ${budgetMb}`);
    }
    const scheduledAgingMs = options.scheduledAgingMs ?? SCHEDULED_PRIORITY_AGING_MS;
    if (!Number.isInteger(scheduledAgingMs) || scheduledAgingMs < 0) {
      throw new Error(`Scheduled priority aging must be a non-negative integer millisecond value: ${scheduledAgingMs}`);
    }
    this.scheduledAgingMs = scheduledAgingMs;
    this.now = options.now ?? Date.now;
  }

  get reservedMb(): number {
    let total = 0;
    for (const amount of this.reservations.values()) total += amount;
    return total;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  isQueued(id: string): boolean {
    return this.queuedIds.has(id);
  }

  hasReservation(id: string): boolean {
    return this.reservations.has(id);
  }

  request(
    id: string,
    requestMb: number,
    payload: T,
    priority: MemoryAdmissionPriority = 'interactive',
  ): MemoryAdmissionResult {
    if (!Number.isInteger(requestMb) || requestMb <= 0) {
      throw new Error(`Memory request must be a positive integer MiB value: ${requestMb}`);
    }
    if (requestMb > this.budgetMb) {
      return { status: 'rejected', reason: 'request_exceeds_budget', budgetMb: this.budgetMb, requestMb };
    }
    if (this.reservations.has(id)) {
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb: this.reservations.get(id)! };
    }
    if (this.queuedIds.has(id)) {
      const entry = this.queue.find((queued) => queued.id === id)!;
      entry.priority = priority;
      if (this.tryAdmit(id)) {
        return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
      }
      const position = this.positionOf(id);
      return { status: 'queued', budgetMb: this.budgetMb, requestMb, position };
    }

    this.queue.push({
      id,
      requestMb,
      payload,
      priority,
      enqueuedAt: this.now(),
      sequence: this.nextSequence++,
    });
    this.queuedIds.add(id);
    if (this.tryAdmit(id)) {
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }

    return { status: 'queued', budgetMb: this.budgetMb, requestMb, position: this.positionOf(id) };
  }

  release(id: string): T[] {
    this.reservations.delete(id);
    return this.drain();
  }

  cancel(id: string): T[] {
    this.reservations.delete(id);
    this.removeQueued(id);
    return this.drain();
  }

  shutdown(): void {
    this.reservations.clear();
    this.queue.length = 0;
    this.queuedIds.clear();
  }

  private drain(): T[] {
    const admitted: T[] = [];
    while (this.queue.length > 0) {
      const head = this.orderedQueue()[0];
      if (this.reservedMb + head.requestMb > this.budgetMb) break;
      this.removeQueued(head.id);
      this.reservations.set(head.id, head.requestMb);
      admitted.push(head.payload);
    }
    return admitted;
  }

  private tryAdmit(id: string): boolean {
    const head = this.orderedQueue()[0];
    if (!head || head.id !== id || this.reservedMb + head.requestMb > this.budgetMb) return false;
    this.removeQueued(id);
    this.reservations.set(id, head.requestMb);
    return true;
  }

  private positionOf(id: string): number {
    return this.orderedQueue().findIndex((entry) => entry.id === id) + 1;
  }

  private orderedQueue(): QueuedRequest<T>[] {
    const now = this.now();
    return [...this.queue].sort((a, b) => {
      const priorityDelta = this.effectivePriority(b, now) - this.effectivePriority(a, now);
      return priorityDelta || a.sequence - b.sequence;
    });
  }

  private effectivePriority(entry: QueuedRequest<T>, now: number): number {
    if (entry.priority === 'interactive') return 1;
    return now - entry.enqueuedAt >= this.scheduledAgingMs ? 1 : 0;
  }

  private removeQueued(id: string): void {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.queuedIds.delete(id);
  }
}
