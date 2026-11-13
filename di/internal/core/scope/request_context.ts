interface RegisteredDestroy {
  instance: unknown
  destroy: (value: never) => void | Promise<void>
}

export class RequestScopeContext {
  // Created on first use: a request that resolves nothing request-scoped allocates neither.
  private _cachedInstances: Map<number, unknown> | undefined
  private _destroys: RegisteredDestroy[] | undefined
  private _destroyed = false

  get destroyed(): boolean {
    return this._destroyed
  }

  /** Whether a destroy hook was registered and not yet run. */
  get hasHooks(): boolean {
    return this._destroys !== undefined && this._destroys.length > 0
  }

  get<T>(id: number): T | undefined {
    return this._cachedInstances?.get(id) as T | undefined
  }

  set(id: number, instance: unknown): void {
    ;(this._cachedInstances ??= new Map()).set(id, instance)
  }

  registerDestroy<T>(instance: T, destroy: (value: T) => void | Promise<void>): void {
    ;(this._destroys ??= []).push({ instance, destroy: destroy as (value: never) => void | Promise<void> })
  }

  /**
   * Destroys every instance the request produced, in reverse creation order, one at a time.
   *
   * Sequential because a dependency must outlive the hook of whatever depends on it, and an instance reached
   * through more than one binding is destroyed once. A hook that throws does not stop the rest; the failures
   * surface together as an `AggregateError`.
   *
   * Returns `undefined`, having run nothing, when no hook was registered or the context is already destroyed; a
   * promise otherwise.
   */
  destroy(): void | Promise<void> {
    if (this._destroyed) {
      return
    }

    this._destroyed = true
    const registered = this._destroys

    if (registered === undefined || registered.length === 0) {
      this._cachedInstances = undefined
      return
    }

    return this.#runHooks(registered)
  }

  async #runHooks(registered: RegisteredDestroy[]): Promise<void> {
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
      this._cachedInstances = undefined
      this._destroys = undefined
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} component(s) failed during disposal`)
    }
  }
}
