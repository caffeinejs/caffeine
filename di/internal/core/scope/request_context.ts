export class RequestScopeContext {
  private readonly _cachedInstances = new Map<number, unknown>()
  private _destroyCallbacks = new Array<() => Promise<void> | void>()
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

  registerDestroyCallback(cb: () => Promise<void> | void): void {
    this._destroyCallbacks.push(cb)
  }

  async destroy(): Promise<void> {
    if (this._destroyed) {
      return
    }

    this._destroyed = true

    if (this._destroyCallbacks.length === 0) {
      this._cachedInstances.clear()
      return
    }

    await Promise.all([...this._destroyCallbacks.values()].map(cb => Promise.resolve(cb()))).finally(() => {
      this._cachedInstances.clear()
      this._destroyCallbacks = []
    })
  }
}
