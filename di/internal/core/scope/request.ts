import { Binding } from '../../../binding.js'
import { contextKey, ExecutionContext, type ContextStorage } from '../../../context.js'
import { ErrIllegalScopeState, ErrOutOfScope } from '../../../errors.js'
import { Factory } from '../../../factory.js'
import { keyStr } from '../../../key.js'
import { ResolutionContext } from '../../../resolution_context.js'
import { Scope, ScopedInstance } from '../../../scope.js'
import { errMessage } from '../../util/errutil/index.js'
import { RequestScopeContext } from './request_context.js'

export class RequestScope implements Scope {
  readonly #storage: ContextStorage
  // A slot of this scope's own: two containers sharing one storage never see each other's request scope.
  readonly #key = contextKey<RequestScopeContext>('@caffeinejs/di:request-scope')

  constructor(storage: ContextStorage) {
    this.#storage = storage
  }

  get lazy(): boolean {
    return true
  }

  get durable(): boolean {
    return false
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.enter(async end => {
      try {
        return await fn()
      } finally {
        await end()
      }
    })
  }

  enter<T>(fn: (end: () => void | Promise<void>) => T, context?: ExecutionContext): T {
    const storage = this.#storage
    const current = storage.getStore()

    // A scope that has ended may still sit in the frame of work its request started: that one is not open.
    const open = current?.get(this.#key)
    if (open !== undefined && !open.destroyed) {
      throw new ErrIllegalScopeState(
        errMessage('A request scope block is already in progress: only one is allowed at a time')
          .reference('@caffeinejs/di', ErrIllegalScopeState)
          .build(),
      )
    }

    const scope = new RequestScopeContext()
    const frame = (context ?? current ?? ExecutionContext.ROOT).with(this.#key, scope)
    let ended = false
    let ending: void | Promise<void>

    // Hooks run in the scope's frame, so one still sees its request; with none, no frame is opened. A second call hands
    // back what the first did.
    const end = (): void | Promise<void> => {
      if (!ended) {
        ended = true
        ending = scope.hasHooks ? storage.run(frame, () => scope.destroy()) : scope.destroy()
      }

      return ending
    }

    return storage.run(frame, () => fn(end))
  }

  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
    const context = this.#storage.getStore()?.get(this.#key)
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
    return this.#storage.getStore()?.get(this.#key)?.get(binding.id) as T | undefined
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
}
