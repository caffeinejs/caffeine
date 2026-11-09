import { Binding } from '../../../binding.js'
import { contextKey, type ContextStorage, ExecutionContext } from '../../../context/context.js'
import { ErrIllegalScopeState, ErrNoRequestStorageSet, ErrOutOfScope } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { keyStr } from '../../../key.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope, ScopedInstance } from '../../../scope.js'
import { errMessage } from '../../util/errutil/index.js'
import { RequestScopeContext } from './request_context.js'

const kRequestScope = contextKey<RequestScopeContext>('@caffeinejs/di:request-scope')

export class RequestScope implements Scope {
  // Given to the constructor or to setStorage(): wins over the source.
  #storage: ContextStorage | undefined
  // Resolved from the source on first use, dropped by clear() so a container initialized again resolves it again.
  #resolved: ContextStorage | undefined
  readonly #source: (() => ContextStorage) | undefined

  /**
   * @param storage - The storage to keep frames in, or a function returning it, called on first use.
   */
  constructor(storage?: ContextStorage | (() => ContextStorage)) {
    if (typeof storage === 'function') {
      this.#source = storage
    } else {
      this.#storage = storage
    }
  }

  get lazy(): boolean {
    return true
  }

  get durable(): boolean {
    return false
  }

  setStorage(storage: ContextStorage): void {
    this.#storage = storage
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const storage = this.#current()
    const current = storage.getStore() ?? ExecutionContext.ROOT

    if (current.get(kRequestScope) !== undefined) {
      throw new ErrIllegalScopeState(
        errMessage('A request scope block is already in progress: only one is allowed at a time')
          .reference('@caffeinejs/di', ErrIllegalScopeState)
          .build(),
      )
    }

    const scope = new RequestScopeContext()
    return storage.run(current.with(kRequestScope, scope), async () => {
      try {
        return await Promise.resolve(fn())
      } finally {
        await scope.destroy()
      }
    })
  }

  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
    const context = this.#current().getStore()?.get(kRequestScope)
    if (!context) {
      throw new ErrOutOfScope(
        errMessage(`Cannot access key "${keyStr(ctx.key)}" outside of a request scope block`)
          .reference('@caffeinejs/di', ErrOutOfScope)
          .build(),
      )
    }

    if (context.destroyed) {
      throw new ErrOutOfScope(
        errMessage(`Cannot access key "${keyStr(ctx.key)}": the request scope block it belongs to has already ended`)
          .reference('@caffeinejs/di', ErrOutOfScope)
          .build(),
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
    return this.#current().getStore()?.get(kRequestScope)?.get(binding.id) as T | undefined
  }

  reset(_binding: Binding): void {
    // noop
  }

  // Request instances belong to the context the scope block installed, which destroys them when the block
  // ends. Nothing here outlives a request, so the container has nothing to dispose.
  instances(): Iterable<ScopedInstance> {
    return []
  }

  clear(): void {
    this.#resolved = undefined
  }

  configure(_binding: Binding): void {
    // noop
  }

  #current(): ContextStorage {
    const storage = this.#storage ?? (this.#resolved ??= this.#source?.())
    if (storage === undefined) {
      throw new ErrNoRequestStorageSet()
    }
    return storage
  }
}
