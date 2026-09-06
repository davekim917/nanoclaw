export type MemoryAdmissionResult =
  | { status: 'admitted'; budgetMb: number; requestMb: number }
  | { status: 'queued'; budgetMb: number; requestMb: number; position: number }
  | { status: 'rejected'; reason: 'request_exceeds_budget'; budgetMb: number; requestMb: number };

export type MemoryAdmissionPriority = 'interactive' | 'scheduled';

interface QueuedRequest<T> {
  id: string;
  requestMb: number;
  payload: T;
  priority: MemoryAdmissionPriority;
  sequence: number;
}

/**
 * Host-local priority-aware memory reservation controller.
 * Reservations cover both in-flight spawns and active containers.
 * Interactive work always runs before scheduled work, with FIFO preserved
 * within each priority class. Background work may wait under sustained chat
 * load; that is deliberate because an operator message must never lose a slot
 * to a scheduled wake merely because the scheduled wake has waited longer.
 */
export class MemoryAdmissionController<T> {
  private readonly reservations = new Map<string, number>();
  private readonly queue: QueuedRequest<T>[] = [];
  private readonly queuedIds = new Set<string>();
  private nextSequence = 0;

  constructor(readonly budgetMb: number) {
    if (!Number.isInteger(budgetMb) || budgetMb <= 0) {
      throw new Error(`Memory admission budget must be a positive integer MiB value: ${budgetMb}`);
    }
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
      // A task retry must not demote a session that an operator has already
      // promoted by sending an interactive message into the same session.
      if (priority === 'interactive') entry.priority = priority;
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
      sequence: this.nextSequence++,
    });
    this.queuedIds.add(id);
    if (this.tryAdmit(id)) {
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }

    return { status: 'queued', budgetMb: this.budgetMb, requestMb, position: this.positionOf(id) };
  }

  /**
   * Reserve `requestMb` for `id` whether or not it fits — a SATURATING
   * reservation for memory that is already in use by a container this host
   * did not admit (a survivor of the previous host it could not yet adopt,
   * seam 4 E/D2, #462 item 5). `reservedMb` may then exceed `budgetMb`, and
   * `request`/`drain` admit nothing further until enough is released: the
   * budget is a fact about the machine, and an over-committed survivor must
   * block fresh spawns rather than be left uncounted. A queued request under
   * the same id is withdrawn; an existing reservation is replaced.
   */
  reserveSaturating(id: string, requestMb: number): void {
    if (!Number.isInteger(requestMb) || requestMb <= 0) {
      throw new Error(`Memory request must be a positive integer MiB value: ${requestMb}`);
    }
    this.removeQueued(id);
    this.reservations.set(id, requestMb);
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
    return [...this.queue].sort((a, b) => {
      const priorityDelta = this.priorityValue(b) - this.priorityValue(a);
      return priorityDelta || a.sequence - b.sequence;
    });
  }

  private priorityValue(entry: QueuedRequest<T>): number {
    return entry.priority === 'interactive' ? 1 : 0;
  }

  private removeQueued(id: string): void {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.queuedIds.delete(id);
  }
}
