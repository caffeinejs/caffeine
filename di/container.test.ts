import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from './container.js'
import { ContextStorage, type ExecutionContext } from './context.js'
import { ErrInvalidContainerState, ErrNoContextStorage, ErrScopeNotRegistered } from './errors.js'
import { Scopes } from './scope.js'

// No platform entry is loaded here, so no ContextStorageFactory is registered: the container is as it is in a browser.
describe('the container context storage', function () {
  it('has no context storage without a factory', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.init()

    expect(di.has(ContextStorage)).toBe(false)
  })

  it('refuses a request-scoped binding without a context storage', async function () {
    class Session {}
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))

    const err = await di.init().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ErrScopeNotRegistered)
    expect((err as Error).message).toContain(
      'Cannot use scope "Request" for "Session": the container has no context storage',
    )
    expect((err as Error).message).toContain('container.bindContextStorage(storage)')
  })

  it('refuses to open a request scope without a context storage', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.init()

    expect(() => di.requestScopeManager.enter(() => 1)).toThrow(ErrNoContextStorage)
    expect(() => di.requestScopeManager.enter(() => 1)).toThrow(
      'Cannot open a request scope: no context storage is bound',
    )
  })

  // The request scope is built when the container initializes, on the storage it holds then.
  it('refuses to open a request scope before init', function () {
    const di = new CaffeineIoC({ decorators: false }).bindContextStorage(new AsyncLocalStorage<ExecutionContext>())

    expect(() => di.requestScopeManager.enter(() => 1)).toThrow(ErrInvalidContainerState)
    expect(() => di.requestScopeManager.enter(() => 1)).toThrow(
      'Cannot open a request scope: the container has not initialized',
    )
  })

  it('binds the storage bound last before init, and runs the request scope on it', async function () {
    class Session {}
    const first = new AsyncLocalStorage<ExecutionContext>()
    const second = new AsyncLocalStorage<ExecutionContext>()
    const di = new CaffeineIoC({ decorators: false }).bindContextStorage(first).bindContextStorage(second)
    di.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))
    await di.init()

    const seen = await di.requestScopeManager.run(() => [
      di.get(Session),
      di.get(Session),
      second.getStore() !== undefined,
      first.getStore() !== undefined,
    ])

    expect(di.get(ContextStorage)).toBe(second)
    expect(seen[0]).toBeInstanceOf(Session)
    expect(seen[1]).toBe(seen[0])
    expect(seen.slice(2)).toEqual([true, false])
  })

  // Initializing builds the request scope on the storage: a later one would never reach it.
  it('refuses a storage bound once compiling has started', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.compile()

    expect(() => di.bindContextStorage(new AsyncLocalStorage<ExecutionContext>())).toThrow(ErrInvalidContainerState)
  })

  // Every container binds its own: a restored one takes it from its own factory, or from its own bindContextStorage().
  it('leaves the context storage out of a snapshot', async function () {
    const di = new CaffeineIoC({ decorators: false }).bindContextStorage(new AsyncLocalStorage<ExecutionContext>())
    await di.init()

    const restored = new CaffeineIoC({ decorators: false })
    restored.restore(di.snapshot())
    await restored.init()

    expect(restored.has(ContextStorage)).toBe(false)
  })
})
