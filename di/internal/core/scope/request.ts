import { Binding } from '../../../binding.js'
import { ErrIllegalScopeState, ErrNoRequestStorageSet, ErrOutOfScope } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { keyStr } from '../../../key.js'
import { RequestScopeStorage } from '../../../request_scope_manager.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope, ScopedInstance } from '../../../scope.js'
import { RequestScopeContext } from './request_context.js'

export class RequestScope implements Scope {
  private _storage: RequestScopeStorage | undefined

  constructor(storage?: RequestScopeStorage) {
    this._storage = storage
  }

  get lazy(): boolean {
    return true
  }

  get durable(): boolean {
    return false
  }

  setStorage(storage: RequestScopeStorage): void {
    this._storage = storage
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    this.#checkAndthrowIfNoStorageIsSet()

    if (this._storage!.getStore() !== undefined) {
      throw new ErrIllegalScopeState('A request scope block is already in progress: only one is allowed at a time')
    }

    return (this._storage! as RequestScopeStorage<RequestScopeContext>).run(new RequestScopeContext(), async () => {
      try {
        return await Promise.resolve(fn())
      } finally {
        const store = this._storage!.getStore()
        if (store) {
          await store.destroy()
        }
      }
    })
  }

  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
    this.#checkAndthrowIfNoStorageIsSet()

    const context = (this._storage! as RequestScopeStorage<RequestScopeContext>).getStore()
    if (!context) {
      throw new ErrOutOfScope(`Cannot access key "${keyStr(ctx.key)}" outside of a request scope block`)
    }

    if (context.destroyed) {
      throw new ErrOutOfScope(
        `Cannot access key "${keyStr(ctx.key)}": the request scope block it belongs to has already ended`,
      )
    }

    const value = context.get(ctx.binding.id)
    if (value !== undefined) {
      return value as T
    }

    const resolved = factory(ctx)
    context.set(ctx.binding.id, resolved)

    if (ctx.binding.preDestroy !== undefined) {
      context.registerDestroy(resolved, ctx.binding.preDestroy)
    }

    return resolved
  }

  cachedInstance<T>(binding: Binding<T>): T | undefined {
    this.#checkAndthrowIfNoStorageIsSet()

    return this._storage!.getStore()?.get(binding.id) as T | undefined
  }

  reset(_binding: Binding): void {
    // noop
  }

  // Request instances belong to the context the scope block installed, which destroys them when the block
  // ends. Nothing here outlives a request, so the container has nothing to dispose or clear.
  instances(): Iterable<ScopedInstance> {
    return []
  }

  clear(): void {
    // noop
  }

  configure(_binding: Binding): void {
    // noop
  }

  #checkAndthrowIfNoStorageIsSet(): void {
    if (this._storage === undefined) {
      throw new ErrNoRequestStorageSet()
    }
  }
}
