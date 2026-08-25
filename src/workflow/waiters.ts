/**
 * In-process waiters for `send_to_agent({ wait: true })` (PLAN.md §2.4).
 * Waiters are synchronization aids ONLY: the durable delegation projection
 * stays authoritative, nothing here is persisted across restarts, and a
 * timeout resolves a `timed_out` outcome instead of throwing. The child
 * report/settlement observer calls {@link WaiterRegistry.settle}; waiting on
 * the parent's next model step is exactly what this registry exists to avoid.
 * @module
 */

/** Terminal outcome delivered to one waiter. */
export interface WaiterOutcome {
  /** Domain classification of why waiting ended. */
  readonly status: 'completed' | 'blocked' | 'failed' | 'timed_out' | 'cancelled'
  /** Report response text for `completed`/`blocked`. */
  readonly response?: string
  /** Validated produced-file list for `completed`. */
  readonly producedFiles?: readonly string[]
  /** Block classification for `blocked`. */
  readonly blockType?: 'missing_data' | 'quality'
}

interface PendingWaiter {
  resolve: (outcome: WaiterOutcome) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * Registry of pending `(taskId#revision)` waiters.
 */
export class WaiterRegistry {
  private readonly pending = new Map<string, Set<PendingWaiter>>()

  /**
   * Wait for one delegation attempt to settle.
   * @param key - composite `taskId#revision` key.
   * @param timeoutMs - bounded wait; elapsed time resolves `timed_out`.
   * @returns the terminal outcome (never a rejection).
   */
  wait(key: string, timeoutMs: number): Promise<WaiterOutcome> {
    let sink: (outcome: WaiterOutcome) => void = () => {}
    const promise = new Promise<WaiterOutcome>(resolve => {
      sink = resolve
    })
    const waiter: PendingWaiter = { resolve: sink, timer: undefined }
    waiter.timer = setTimeout(() => {
      this.remove(key, waiter)
      waiter.resolve({ status: 'timed_out' })
    }, Math.max(1, timeoutMs))
    let set = this.pending.get(key)
    if (set === undefined) {
      set = new Set()
      this.pending.set(key, set)
    }
    set.add(waiter)
    return promise
  }

  /**
   * Deliver an outcome to every waiter on one key and clear their timers.
   * @param key - composite `taskId#revision` key.
   * @param outcome - terminal classification from the report/settlement observer.
   * @returns whether any waiter was pending (idempotency guard for double settles).
   */
  settle(key: string, outcome: WaiterOutcome): boolean {
    const set = this.pending.get(key)
    if (set === undefined || set.size === 0) return false
    const waiters = [...set]
    this.pending.delete(key)
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve(outcome)
    }
    return true
  }

  /**
   * Drop one key's waiters without delivering an outcome (shutdown path).
   * @param key - composite key to abandon.
   */
  abandon(key: string): void {
    const set = this.pending.get(key)
    if (set === undefined) return
    this.pending.delete(key)
    for (const waiter of set) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve({ status: 'cancelled' })
    }
  }

  /**
   * Number of keys with at least one pending waiter (diagnostics/tests).
   * @returns count of tracked keys.
   */
  pendingKeys(): number {
    return this.pending.size
  }

  private remove(key: string, waiter: PendingWaiter): void {
    const set = this.pending.get(key)
    if (set === undefined) return
    set.delete(waiter)
    if (set.size === 0) this.pending.delete(key)
  }
}
