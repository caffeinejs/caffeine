interface RegisteredDestroy {
  instance: unknown
  destroy: (value: never) => void | Promise<void>
}

export class RequestScopeContext {
  private readonly _cachedInstances = new Map<number, unknown>()
  private _destroys = new Array<RegisteredDestroy>()
  private _destroyed = false

  get destroyed(): boolean {
    return this._destroyed
  }

  get<T>(id: number): T | undefined {
    return this._cachedInstances.get(id) as T | undefined
  }

  set(id: number, instance: unknown): void {
    this._cachedInstances.set(id, instance)
  }

  registerDestroy<T>(instance: T, destroy: (value: T) => void | Promise<void>): void {
    this._destroys.push({ instance, destroy: destroy as (value: never) => void | Promise<void> })
  }

  /**
   * Destroys every instance the request produced, in reverse creation order, one at a time.
   *
   * Sequential because a dependency must outlive the hook of whatever depends on it, and an instance reached
   * through more than one binding is destroyed once. A hook that throws does not stop the rest; the failures
   * surface together as an `AggregateError`.
   */
  async destroy(): Promise<void> {
    if (this._destroyed) {
      return
    }

    this._destroyed = true

    if (this._destroys.length === 0) {
      this._cachedInstances.clear()
      return
    }

    const registered = this._destroys
    const seen = new Set<object>()
    const errors: unknown[] = []

    try {
      for (let i = registered.length - 1; i >= 0; i--) {
        const { instance, destroy } = registered[i]

        if (instance !== null && (typeof instance === 'object' || typeof instance === 'function')) {
          if (seen.has(instance as object)) {
            continue
          }

          seen.add(instance as object)
        }

        try {
          await destroy(instance as never)
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      this._cachedInstances.clear()
      this._destroys = []
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} component(s) failed during disposal`)
    }
  }
}
