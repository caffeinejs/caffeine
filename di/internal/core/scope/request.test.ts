import HTTP, { IncomingMessage, ServerResponse } from 'http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import Supertest from 'supertest'
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest'

import { contextKey, ContextStorage, ExecutionContext } from '../../../context.js'
import { Injectable } from '../../../decorators/injectable.js'
import { Lazy } from '../../../decorators/lazy.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { PostConstruct } from '../../../decorators/post_construct.js'
import { ErrIllegalScopeState, ErrOutOfScope } from '../../../errors.js'
import { CaffeineIoC, Scopes } from '../../../index.nodejs.js'
import { token } from '../../../key.js'

describe('Request Scope', function () {
  describe('common cases', function () {
    const ctorSpy = vi.fn()
    const initSpy = vi.fn()
    const destroySpy = vi.fn()
    const singletonSpy = vi.fn()

    @Injectable()
    @Lifetime(Scopes.REQUEST)
    class Ctrl {
      readonly id: string = randomUUID()

      constructor() {
        ctorSpy()
      }

      value() {
        return 'hello world'
      }

      @PostConstruct()
      init() {
        initSpy()
      }

      onDestroy() {
        destroySpy()
      }
    }

    @Injectable([Ctrl])
    @Lazy()
    class SingletonWithReq {
      constructor(readonly req: Ctrl) {
        singletonSpy()
      }
    }

    const di = new CaffeineIoC({ checks: { scopes: 'off' } })

    beforeAll(async () => {
      await di.init()
    })

    async function requestListener(req: IncomingMessage, res: ServerResponse) {
      void di.requestScopeManager.run(() => {
        const ctrl = di.get(Ctrl)

        res.writeHead(200)
        res.end(ctrl.value())
      })
    }

    const server = HTTP.createServer(requestListener)

    afterAll(async () => {
      server.close()

      await di.dispose()
    })

    beforeEach(() => {
      ctorSpy.mockReset()
      singletonSpy.mockReset()
      initSpy.mockReset()
      destroySpy.mockReset()
    })

    it('should fail when trying to resolve outside a request scope', function () {
      expect(() => di.get(Ctrl)).toThrow()
    })

    it('should fail when starting a nested request scope', async function () {
      await di.requestScopeManager.run(async () => {
        expect(() => di.requestScopeManager.run(() => {})).toThrow()
      })
    })

    it('should return the same instance across an await inside the run block', async function () {
      let first!: Ctrl
      let second!: Ctrl

      await di.requestScopeManager.run(async function () {
        first = di.get(Ctrl)
        await new Promise(resolve => setTimeout(resolve, 5))
        second = di.get(Ctrl)

        expect(second).toBe(first)
        expect(destroySpy).not.toHaveBeenCalled()
      })

      expect(ctorSpy).toHaveBeenCalledTimes(1)
      expect(destroySpy).toHaveBeenCalledTimes(1)
    })

    it('should throw when a request-scoped key is resolved after the scope block ended', async function () {
      let afterEnd!: Promise<unknown>

      await di.requestScopeManager.run(function () {
        // A task that outlives the block, the way a body still being piped does. It was created inside the
        // scope, so it still reaches the same context — one that has been destroyed.
        afterEnd = new Promise(resolve => setTimeout(resolve, 5)).then(() => di.get(Ctrl))
      })

      await expect(afterEnd).rejects.toThrow(ErrOutOfScope)
      expect(ctorSpy).not.toHaveBeenCalled()
    })

    it('should destroy request-scoped instances when async run() rejects', async function () {
      await expect(
        di.requestScopeManager.run(async () => {
          di.get(Ctrl)
          throw new Error('request failed')
        }),
      ).rejects.toThrow('request failed')

      expect(destroySpy).toHaveBeenCalledTimes(1)
    })

    describe('non request scoped with a request scope dependency', function () {
      it('should fail to resolve root component when not inside a request scope', function () {
        expect(() => di.get(SingletonWithReq)).toThrow()
      })
    })

    describe('when performing http requests', function () {
      it('should create and destroy one instance per request', async function () {
        const val = 'hello world'

        expect(() => di.get(Ctrl)).toThrow()

        await Supertest(server)
          .get('/')
          .expect(200)
          .expect(res => expect(res.text).toEqual(val))

        await Supertest(server)
          .get('/')
          .expect(200)
          .expect(res => expect(res.text).toEqual(val))

        expect(ctorSpy).toHaveBeenCalledTimes(2)
        expect(initSpy).toHaveBeenCalledTimes(2)
        expect(destroySpy).toHaveBeenCalledTimes(2)

        expect(() => di.get(Ctrl)).toThrow()
      })
    })
  })

  // Request instances live and die with their scope block, so container disposal has nothing of theirs to
  // destroy — and must not fail reaching for an instance that only exists inside a request.
  describe('container disposal', function () {
    it('should not run a request-scoped hook and should not throw', async function () {
      const destroyed = vi.fn()

      class SessionCD {
        readonly id: string = randomUUID()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(SessionCD, t => t.toSelf().lifetime(Scopes.REQUEST).preDestroy(destroyed))
      await di.init()

      await di.requestScopeManager.run(async () => {
        di.get(SessionCD)
      })

      expect(destroyed).toHaveBeenCalledTimes(1)

      await expect(di.dispose()).resolves.toBeUndefined()
      expect(destroyed).toHaveBeenCalledTimes(1)
    })
  })
})

describe('RequestScopeManager.enter', function () {
  async function containerWith(hook?: (session: object) => void | Promise<void>) {
    class Session {}
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Session, t => {
      const spec = t.toSelf().lifetime(Scopes.REQUEST)
      if (hook !== undefined) {
        spec.preDestroy(hook)
      }
    })
    await di.init()
    return { di, Session }
  }

  it('returns what its callback returns, synchronously', async function () {
    const { di } = await containerWith()

    expect(di.requestScopeManager.enter(() => 42)).toBe(42)
  })

  it('resolves a request-scoped key to one instance per scope', async function () {
    const { di, Session } = await containerWith()
    let first: [object, object] | undefined
    let second: object | undefined

    di.requestScopeManager.enter(end => {
      first = [di.get(Session), di.get(Session)]
      void end()
    })
    di.requestScopeManager.enter(end => {
      second = di.get(Session)
      void end()
    })

    expect(first![0]).toBe(first![1])
    expect(second).not.toBe(first![0])
  })

  it('ends with nothing to wait for when no destroy hook was registered', async function () {
    const { di, Session } = await containerWith()
    let ending: unknown = 'not ended'

    di.requestScopeManager.enter(end => {
      di.get(Session)
      ending = end()
    })

    expect(ending).toBe(undefined)
  })

  it('ends with a promise that settles after an async destroy hook', async function () {
    const order: string[] = []
    const { di, Session } = await containerWith(async () => {
      await Promise.resolve()
      order.push('hook')
    })
    let ending: void | Promise<void> = undefined

    di.requestScopeManager.enter(end => {
      di.get(Session)
      ending = end()
    })
    await ending
    order.push('after')

    expect(order).toEqual(['hook', 'after'])
  })

  it('refuses to resolve a request-scoped key once the scope has ended', async function () {
    const { di, Session } = await containerWith()
    let resolveLate: (() => unknown) | undefined

    di.requestScopeManager.enter(end => {
      resolveLate = () => di.get(Session)
      void end()
    })

    expect(resolveLate).toThrow(ErrOutOfScope)
  })

  it('keeps the scope across an await in the callback', async function () {
    const { di, Session } = await containerWith()

    const same = await di.requestScopeManager.enter(async end => {
      const before = di.get(Session)
      await new Promise(resolve => setImmediate(resolve))
      const after = di.get(Session)
      void end()
      return before === after
    })

    expect(same).toBe(true)
  })

  it('refuses a scope inside another, even one opened from a fresh context', async function () {
    const { di } = await containerWith()

    await di.requestScopeManager.run(() => {
      expect(() => di.requestScopeManager.enter(() => 1, ExecutionContext.ROOT)).toThrow(ErrIllegalScopeState)
    })

    di.requestScopeManager.enter(end => {
      expect(() => di.requestScopeManager.enter(() => 1)).toThrow(ErrIllegalScopeState)
      void end()
    })
  })

  it('runs the destroy hooks once however often end is called, handing back the same result', async function () {
    let runs = 0
    const { di, Session } = await containerWith(() => {
      runs++
    })
    let endings: unknown[] = []

    di.requestScopeManager.enter(end => {
      di.get(Session)
      endings = [end(), end()]
    })
    await endings[0]

    expect(runs).toBe(1)
    expect(endings[1]).toBe(endings[0])
  })

  it('makes the slots of the context it is given readable in the callback', async function () {
    const { di } = await containerWith()
    const kTenant = contextKey<string>('tenant')

    const tenant = di.requestScopeManager.enter(
      end => {
        void end()
        return di.get(ContextStorage).getStore()?.get(kTenant)
      },
      ExecutionContext.ROOT.with(kTenant, 'acme'),
    )

    expect(tenant).toBe('acme')
  })

  // The scope is the caller's to end from the moment the callback runs, even when it throws.
  it('leaves the scope open when the callback throws, until end is called', async function () {
    let runs = 0
    const { di, Session } = await containerWith(() => {
      runs++
    })
    let ender: (() => void | Promise<void>) | undefined

    expect(() =>
      di.requestScopeManager.enter(end => {
        ender = end
        di.get(Session)
        throw new Error('the handler failed')
      }),
    ).toThrow('the handler failed')
    expect(runs).toBe(0)

    await ender!()
    expect(runs).toBe(1)
  })

  // A server ends the scope from a socket's close event, outside the request's frame: the hook still sees its request.
  it('runs a destroy hook inside the frame of its request, wherever end is called from', async function () {
    const kTenant = contextKey<string>('tenant')
    let seen: string | undefined
    const { di, Session } = await containerWith(() => {
      seen = di.get(ContextStorage).getStore()?.get(kTenant)
    })

    const end = di.requestScopeManager.enter(
      end => {
        di.get(Session)
        return end
      },
      ExecutionContext.ROOT.with(kTenant, 'acme'),
    )

    expect(di.get(ContextStorage).getStore()).toBe(undefined)
    await end()

    expect(seen).toBe('acme')
  })

  // A server answering at once ends the scope before the callback returns.
  it('ends the scope from inside its own callback', async function () {
    const { di, Session } = await containerWith()

    const late = di.requestScopeManager.enter(end => {
      di.get(Session)
      void end()
      try {
        di.get(Session)
        return 'resolved'
      } catch (err) {
        return err instanceof ErrOutOfScope ? 'refused' : 'other'
      }
    })

    expect(late).toBe('refused')
  })

  // Work a request started can outlive its scope: its continuation still carries the ended scope's frame.
  it('opens a new scope from work that outlives an ended one', async function () {
    const { di, Session } = await containerWith()
    const later = Promise.withResolvers<unknown>()

    di.requestScopeManager.enter(end => {
      void end()
      setImmediate(() => {
        try {
          void di.requestScopeManager.run(() => di.get(Session) instanceof Session).then(later.resolve, later.resolve)
        } catch (err) {
          later.resolve(err)
        }
      })
    })

    expect(await later.promise).toBe(true)
  })
})

describe('the storage a request scope opens in', function () {
  // Two containers may be given one storage: each container's request scope is its own.
  it('keeps two containers on one storage apart', async function () {
    class Session {}
    const storage = new AsyncLocalStorage<ExecutionContext>()
    const a = new CaffeineIoC({ decorators: false }).bindContextStorage(storage)
    const b = new CaffeineIoC({ decorators: false }).bindContextStorage(storage)
    a.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))
    b.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))
    await a.init()
    await b.init()

    await a.requestScopeManager.run(async () => {
      expect(() => b.get(Session)).toThrow(ErrOutOfScope)

      const [own, again] = await b.requestScopeManager.run(() => [b.get(Session), b.get(Session)])

      expect(own).toBeInstanceOf(Session)
      expect(again).toBe(own)
      expect(own).not.toBe(a.get(Session))
    })
  })
})
