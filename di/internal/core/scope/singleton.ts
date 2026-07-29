import { Binding } from '../../../binding.js'
import { Scope } from '../../../scope.js'
import { Factory } from '../../../factory.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { ErrIllegalScopeState } from '../../../errors.js'
import { keyStr } from '../../../key.js'

export class SingletonScope implements Scope {
  protected readonly _cachedInstances = new Map<number, unknown>()

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
        'Async provided instances must be provided externally by the container.\n'
        + `Check the key ${keyStr(ctx.key)}. In case you really need the instance to be undefined, use "null" instead.`,
      )
    }

    const resolved = unscoped(ctx)
    this._cachedInstances.set(ctx.binding.id, resolved)

    return resolved
  }

  set(binding: Binding, value: unknown): void {
    this._cachedInstances.set(binding.id, value)
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
  }

  configure(_binding: Binding): void {
    //
  }
}
