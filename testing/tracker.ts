import type { Identifier, Key, PostProcessor, ResolutionContext } from '@caffeinejs/core'

export interface InstantiationEvent {
  key: Key
  scopeID: Identifier
  instance: unknown
  timestamp: number
}

export class InstanceTracker implements PostProcessor {
  readonly #events: InstantiationEvent[] = []

  beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
    return instance
  }

  afterInit(ctx: ResolutionContext, instance: unknown): unknown {
    this.#events.push({
      key: ctx.key,
      scopeID: ctx.binding.scopeID,
      instance,
      timestamp: performance.now(),
    })
    return instance
  }

  instancesOf<T>(key: Key<T>): T[] {
    return this.#events.filter(e => e.key === key).map(e => e.instance as T)
  }

  wasInstantiated(key: Key): boolean {
    return this.#events.some(e => e.key === key)
  }

  events(): readonly InstantiationEvent[] {
    return this.#events
  }

  reset(): void {
    this.#events.length = 0
  }
}
