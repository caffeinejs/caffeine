import { Binding } from '../../../binding.js'
import { ErrIllegalScopeState } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { keyStr } from '../../../key.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope, ScopedInstance } from '../../../scope.js'
import { nextSequence } from './_sequence.js'

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
