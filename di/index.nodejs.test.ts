import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { CaffeineIoC, ContextStorage, Scopes, type ExecutionContext } from './index.nodejs.js'

describe('the Node entry', function () {
  it('gives each container an AsyncLocalStorage of its own', async function () {
    const a = new CaffeineIoC({ decorators: false })
    const b = new CaffeineIoC({ decorators: false })
    await Promise.all([a.init(), b.init()])

    expect(a.get(ContextStorage)).toBeInstanceOf(AsyncLocalStorage)
    expect(a.get(ContextStorage)).not.toBe(b.get(ContextStorage))
  })

  it('runs the request scope on the storage it binds', async function () {
    class Session {}
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))
    await di.init()

    const [first, again, inFrame] = await di.requestScopeManager.run(
      () => [di.get(Session), di.get(Session), di.get(ContextStorage).getStore() !== undefined] as const,
    )

    expect(first).toBeInstanceOf(Session)
    expect(again).toBe(first)
    expect(inFrame).toBe(true)
  })

  it('lets a storage bound before init replace it', async function () {
    const storage = new AsyncLocalStorage<ExecutionContext>()
    const di = new CaffeineIoC({ decorators: false }).bindContextStorage(storage)
    await di.init()

    const inFrame = await di.requestScopeManager.run(() => storage.getStore() !== undefined)

    expect(di.get(ContextStorage)).toBe(storage)
    expect(inFrame).toBe(true)
  })

  // What a feature injects is what the request scope keeps its frames in.
  it('injects the same storage the request scope runs on', async function () {
    class Reader {
      constructor(readonly storage: ContextStorage) {}
    }
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Reader, t => t.toSelf([ContextStorage]))
    await di.init()

    const inFrame = await di.requestScopeManager.run(() => di.get(Reader).storage.getStore() !== undefined)

    expect(inFrame).toBe(true)
  })
})
