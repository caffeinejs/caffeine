import { describe, it, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { OnBootstrap } from '../decorators/on_bootstrap.js'
import { ErrInvalidBinding, ErrInvalidDecorator } from '../errors.js'
import { Scopes } from '../scope.js'

describe('OnBootstrap', function () {
  it('should call the method decorated with @OnBootstrap() during init(), with the resolved instance as `this`', async function () {
    const spy = vi.fn()

    @Injectable()
    class Warmer {
      @OnBootstrap()
      warm() {
        spy(this)
      }
    }

    const di = new CaffeineIoC()
    await di.init()

    const instance = di.get(Warmer)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(instance)
  })

  it('should call the .bootstrap(fn) programmatic hook during init(), with the resolved instance', async function () {
    const spy = vi.fn()

    class Warmer {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Warmer, t => t.toSelf().bootstrap(spy))
    await di.init()

    const instance = di.get(Warmer)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(instance)
  })

  it('should force resolution of a lazy binding that registered a bootstrap hook', async function () {
    const spy = vi.fn()
    let constructed = false

    class LazyWarmer {
      constructor() {
        constructed = true
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(LazyWarmer, t => t.toSelf().lazy().bootstrap(spy))
    await di.init()

    expect(constructed).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('should run hooks in dependency order: a dependency’s hook runs before its dependent’s', async function () {
    const order: string[] = []

    class Repo {}
    class Service {
      constructor(readonly repo: Repo) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Repo, t => t.toSelf().bootstrap(() => order.push('repo')))
    di.bind(Service, t => t.toSelf([Repo]).bootstrap(() => order.push('service')))
    await di.init()

    expect(order).toEqual(['repo', 'service'])
  })

  it('should not let a dependency on a non-hook binding affect hook ordering', async function () {
    const order: string[] = []

    class PlainDep {}
    class Service {
      constructor(readonly dep: PlainDep) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(PlainDep, t => t.toSelf())
    di.bind(Service, t => t.toSelf([PlainDep]).bootstrap(() => order.push('service')))
    await di.init()

    expect(order).toEqual(['service'])
  })

  it('should await each hook before starting the next', async function () {
    const order: string[] = []

    class First {}
    class Second {
      constructor(readonly first: First) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(First, t =>
      t.toSelf().bootstrap(async () => {
        order.push('first:start')
        await Promise.resolve()
        order.push('first:end')
      }),
    )
    di.bind(Second, t =>
      t.toSelf([First]).bootstrap(async () => {
        order.push('second:start')
        await Promise.resolve()
        order.push('second:end')
      }),
    )
    await di.init()

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('should throw ErrInvalidBinding when combined with TRANSIENT scope', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })

    expect(() => {
      di.bind(Svc, t =>
        t
          .toSelf()
          .lifetime(Scopes.TRANSIENT)
          .bootstrap(() => {}),
      )
    }).toThrow(ErrInvalidBinding)
  })

  it('should throw ErrInvalidBinding when combined with REQUEST scope', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })

    expect(() => {
      di.bind(Svc, t =>
        t
          .toSelf()
          .lifetime(Scopes.REQUEST)
          .bootstrap(() => {}),
      )
    }).toThrow(ErrInvalidBinding)
  })

  it('should throw ErrInvalidBinding when combined with REFRESH scope', async function () {
    class Svc {}

    const di = new CaffeineIoC({ decorators: false })

    expect(() => {
      di.bind(Svc, t =>
        t
          .toSelf()
          .lifetime(Scopes.REFRESH)
          .bootstrap(() => {}),
      )
    }).toThrow(ErrInvalidBinding)
  })

  it('should reject init() when a hook throws, leaving the container not ready, and stop remaining hooks', async function () {
    const before = vi.fn()
    const after = vi.fn()

    class A {}
    class B {}
    class C {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(A, t => t.toSelf().bootstrap(before))
    di.bind(B, t =>
      t.toSelf().bootstrap(() => {
        throw new Error('bootstrap boom')
      }),
    )
    di.bind(C, t => t.toSelf().bootstrap(after))

    await expect(di.init()).rejects.toThrow('bootstrap boom')
    expect(di.ready).toBe(false)
    expect(before).toHaveBeenCalledTimes(1)
    expect(after).not.toHaveBeenCalled()
  })

  it('should throw ErrInvalidDecorator when @OnBootstrap() is applied twice on the same class', function () {
    expect(() => {
      @Injectable()
      class Bad {
        @OnBootstrap()
        first() {}

        @OnBootstrap()
        second() {}
      }
      void Bad
    }).toThrow(ErrInvalidDecorator)
  })

  it('should not re-run bootstrap hooks when init() is called a second time', async function () {
    const spy = vi.fn()

    class Warmer {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Warmer, t => t.toSelf().bootstrap(spy))
    await di.init()
    await di.init()

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
