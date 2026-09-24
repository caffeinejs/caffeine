import { Binding } from '../../../binding.js'
import { ErrIllegalScopeState, ErrInvalidBinding } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { keyStr } from '../../../key.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope, ScopedInstance } from '../../../scope.js'
import { solutions } from '../../util/errutil/index.js'
import { nextSequence } from './_sequence.js'

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown })?.then === 'function'
}

export class SingletonScope implements Scope {
  protected readonly _cachedInstances = new Map<number, unknown>()

  // Kept apart from `_cachedInstances` so a cache hit stays a single map lookup with no property load on the
  // value. Only creation writes here, and only disposal reads it.
  protected readonly _created = new Map<number, { binding: Binding; sequence: number }>()

  get lazy(): boolean {
    return false
  }

  get durable(): boolean {
    return true
  }

  provide<T>(ctx: ResolutionContext, unscoped: Factory<T>): T {
    const cached = this._cachedInstances.get(ctx.binding.id)
    if (cached !== undefined) {
      return cached as T
    }

    if (ctx.binding.async) {
      throw new ErrIllegalScopeState(
        'Async provided instances must be provided externally by the container.\n' +
          `Check the key ${keyStr(ctx.key)}. In case you really need the instance to be undefined, use "null" instead.`,
      )
    }

    const resolved = unscoped(ctx)

    // The type system refuses a promise-returning `@Provides`, but a JavaScript caller never sees that, and
    // neither does anything that laundered the factory through `any`. Caching the promise would inject it
    // unresolved into every dependant, and the failure would only surface on first use. Past the cache hit
    // above, this runs once per binding.
    if (ctx.binding.configuration && isThenable(resolved)) {
      throw new ErrInvalidBinding(
        `Cannot provide "${keyStr(ctx.key)}": the factory returned a promise and the binding is not async` +
          solutions('Declare the factory with @ProvidesAsync instead of @Provides'),
      )
    }

    this._cachedInstances.set(ctx.binding.id, resolved)
    this._created.set(ctx.binding.id, { binding: ctx.binding, sequence: nextSequence() })

    return resolved
  }

  set(binding: Binding, value: unknown): void {
    this._cachedInstances.set(binding.id, value)
    this._created.set(binding.id, { binding, sequence: nextSequence() })
  }

  cachedInstance<T>(binding: Binding<T>): T | undefined {
    return this._cachedInstances.get(binding.id) as T | undefined
  }

  reset(binding: Binding): void {
    if (binding.async) {
      throw new ErrIllegalScopeState(
        `Cannot reset an async binding "${keyStr(binding.ctx!.key)}" directly. Use the container's resetBinding() method instead.`,
      )
    }

    this._cachedInstances.delete(binding.id)
    this._created.delete(binding.id)
  }

  instances(): Iterable<ScopedInstance> {
    const entries: ScopedInstance[] = []
    for (const [id, { binding, sequence }] of this._created) {
      entries.push({ binding, instance: this._cachedInstances.get(id), sequence })
    }

    return entries
  }

  clear(): void {
    this._cachedInstances.clear()
    this._created.clear()
  }

  configure(_binding: Binding): void {
    //
  }
}
