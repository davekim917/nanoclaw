export type MemoryAdmissionResult =
  | { status: 'admitted'; budgetMb: number; requestMb: number }
  | { status: 'queued'; budgetMb: number; requestMb: number; position: number }
  | { status: 'rejected'; reason: 'request_exceeds_budget'; budgetMb: number; requestMb: number };

interface QueuedRequest<T> {
  id: string;
  requestMb: number;
  payload: T;
}

/**
 * Host-local strict-FIFO memory reservation controller.
 * Reservations cover both in-flight spawns and active containers.
 */
export class MemoryAdmissionController<T> {
  private readonly reservations = new Map<string, number>();
  private readonly queue: QueuedRequest<T>[] = [];
  private readonly queuedIds = new Set<string>();

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

  request(id: string, requestMb: number, payload: T): MemoryAdmissionResult {
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
      const position = this.queue.findIndex((entry) => entry.id === id) + 1;
      return { status: 'queued', budgetMb: this.budgetMb, requestMb, position };
    }

    if (this.queue.length === 0 && this.reservedMb + requestMb <= this.budgetMb) {
      this.reservations.set(id, requestMb);
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }

    this.queue.push({ id, requestMb, payload });
    this.queuedIds.add(id);
    return { status: 'queued', budgetMb: this.budgetMb, requestMb, position: this.queue.length };
  }

  release(id: string): T[] {
    this.reservations.delete(id);
    return this.drain();
  }

  cancel(id: string): T[] {
    this.reservations.delete(id);
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queuedIds.delete(id);
    }
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
      const head = this.queue[0];
      if (this.reservedMb + head.requestMb > this.budgetMb) break;
      this.queue.shift();
      this.queuedIds.delete(head.id);
      this.reservations.set(head.id, head.requestMb);
      admitted.push(head.payload);
    }
    return admitted;
  }
}
