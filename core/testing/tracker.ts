import type { Key, Identifier } from '../key.js'
import type { ResolutionContext } from '../resolution_context.js'
import type { PostProcessor } from '../post_processor.js'

export interface InstantiationEvent {
  key: Key
  scopeId: Identifier
  instance: unknown
  timestamp: number
}

/**
 * A {@link PostProcessor} that records every instantiation event during container resolution.
 * Add it to the {@link Container} `postProcessors` before calling `init()`.
 *
 * @param container - The container to record instantiation events for.
 *
 * @experimental
 * @internal
 * @testing
 */
export class InstanceTracker implements PostProcessor {
  readonly #events: InstantiationEvent[] = []

  beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
    return instance
  }

  afterInit(ctx: ResolutionContext, instance: unknown): unknown {
    this.#events.push({
      key: ctx.key,
      scopeId: ctx.binding.scopeId,
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
