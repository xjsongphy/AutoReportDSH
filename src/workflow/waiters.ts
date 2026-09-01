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
  readonly key: string
  resolve: (outcome: WaiterOutcome) => void
  readonly childSessionId: string | undefined
  readonly idleTimeoutMs: number | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  hardTimer: ReturnType<typeof setTimeout> | undefined
}

/** Liveness bounds for one `wait: true` delegation. */
export interface WaiterLivenessOptions {
  /** Bound that applies only while the target child is idle. */
  readonly idleTimeoutMs: number
  /** Absolute bound that applies regardless of child activity. */
  readonly hardTimeoutMs: number
  /** Bound child session whose active lifecycle pauses the idle clock. */
  readonly childSessionId: string
}

export type ChildActivity = 'idle' | 'running'

/**
 * Registry of pending `(taskId#revision)` waiters.
 */
export class WaiterRegistry {
  private readonly pending = new Map<string, Set<PendingWaiter>>()
  private readonly pendingByChild = new Map<string, Set<PendingWaiter>>()
  private readonly childActivity = new Map<string, ChildActivity>()

  /**
   * Wait for one delegation attempt to settle.
   * @param key - composite `taskId#revision` key.
   * @param timeoutMs - bounded wait; elapsed time resolves `timed_out`.
   * @returns the terminal outcome (never a rejection).
   */
  wait(key: string, timeoutMs: number): Promise<WaiterOutcome>
  wait(key: string, options: WaiterLivenessOptions): Promise<WaiterOutcome>
  wait(key: string, timeout: number | WaiterLivenessOptions): Promise<WaiterOutcome> {
    let sink: (outcome: WaiterOutcome) => void = () => {}
    const promise = new Promise<WaiterOutcome>(resolve => {
      sink = resolve
    })
    const options = typeof timeout === 'number'
      ? undefined
      : {
          idleTimeoutMs: Math.max(1, timeout.idleTimeoutMs),
          hardTimeoutMs: Math.max(1, timeout.hardTimeoutMs),
          childSessionId: timeout.childSessionId,
        }
    const waiter: PendingWaiter = {
      key,
      resolve: sink,
      childSessionId: options?.childSessionId,
      idleTimeoutMs: options?.idleTimeoutMs,
      idleTimer: undefined,
      hardTimer: undefined,
    }
    let set = this.pending.get(key)
    if (set === undefined) {
      set = new Set()
      this.pending.set(key, set)
    }
    set.add(waiter)
    if (options === undefined) {
      waiter.hardTimer = setTimeout(() => this.timeout(key, waiter), Math.max(1, timeout as number))
      return promise
    }
    let childSet = this.pendingByChild.get(options.childSessionId)
    if (childSet === undefined) {
      childSet = new Set()
      this.pendingByChild.set(options.childSessionId, childSet)
    }
    childSet.add(waiter)
    waiter.hardTimer = setTimeout(() => this.timeout(key, waiter), options.hardTimeoutMs)
    if (this.childActivity.get(options.childSessionId) !== 'running') this.armIdle(key, waiter)
    return promise
  }

  /**
   * Record one live DSH child lifecycle transition. A running child pauses the
   * no-progress timer; an idle child receives a fresh idle budget. The hard
   * deadline remains armed in either state.
   */
  noteChildActivity(childSessionId: string, activity: ChildActivity): void {
    this.childActivity.set(childSessionId, activity)
    const waiters = this.pendingByChild.get(childSessionId)
    if (waiters === undefined) return
    for (const waiter of [...waiters]) {
      if (activity === 'running') {
        if (waiter.idleTimer !== undefined) clearTimeout(waiter.idleTimer)
        waiter.idleTimer = undefined
      } else {
        this.armIdle(waiter.key, waiter)
      }
    }
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
      this.clearTimers(waiter)
      this.removeFromChild(waiter)
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
      this.clearTimers(waiter)
      this.removeFromChild(waiter)
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
    this.removeFromChild(waiter)
  }

  private timeout(key: string, waiter: PendingWaiter): void {
    this.remove(key, waiter)
    this.clearTimers(waiter)
    waiter.resolve({ status: 'timed_out' })
  }

  private armIdle(key: string, waiter: PendingWaiter): void {
    if (waiter.idleTimeoutMs === undefined) return
    if (waiter.idleTimer !== undefined) clearTimeout(waiter.idleTimer)
    waiter.idleTimer = setTimeout(() => this.timeout(key, waiter), waiter.idleTimeoutMs)
  }

  private clearTimers(waiter: PendingWaiter): void {
    if (waiter.idleTimer !== undefined) clearTimeout(waiter.idleTimer)
    if (waiter.hardTimer !== undefined) clearTimeout(waiter.hardTimer)
    waiter.idleTimer = undefined
    waiter.hardTimer = undefined
  }

  private removeFromChild(waiter: PendingWaiter): void {
    if (waiter.childSessionId === undefined) return
    const set = this.pendingByChild.get(waiter.childSessionId)
    if (set === undefined) return
    set.delete(waiter)
    if (set.size === 0) this.pendingByChild.delete(waiter.childSessionId)
  }
}
