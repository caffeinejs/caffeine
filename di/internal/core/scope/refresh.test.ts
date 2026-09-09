import { randomUUID } from 'node:crypto'

import { describe, it, expect, vi } from 'vitest'

import { CaffeineIoC } from '../../../container.js'
import { Injectable } from '../../../decorators/injectable.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { token } from '../../../key.js'
import { kSelfRefresh, SelfRefreshable } from '../../../refresher.js'
import { Scopes } from '../../../scope.js'

describe('Refresh Scope', function () {
  @Injectable()
  @Lifetime(Scopes.REFRESH)
  class Dep {
    readonly id: string = randomUUID()

    fn(): string {
      return 'test'
    }
  }

  @Injectable([Dep])
  @Lifetime(Scopes.REFRESH)
  class Root {
    readonly id: string = randomUUID()

    constructor(readonly dep: Dep) {}

    msg(): string {
      return this.dep.fn() + ' dev'
    }
  }

  @Injectable()
  class Out {
    readonly id: string = randomUUID()

    hi(): string {
      return 'tchau'
    }
  }

  describe('preDestroy on refresh', function () {
    it('should call the actual preDestroy method name, not the literal string "preDestroy"', async function () {
      const spy = vi.fn()

      @Injectable()
      @Lifetime(Scopes.REFRESH)
      class WithCustomDestroy {
        onDestroy() {
          spy()
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(WithCustomDestroy, t => t.toSelf())
      await di.init()

      di.get(WithCustomDestroy)

      const scope = di.refresher
      await scope.refresh()

      expect(spy).toHaveBeenCalledTimes(1)
    })
  })

  describe('when a refresh-scoped instance implements SelfRefreshable', function () {
    const selfRefreshSpy = vi.fn()

    class WithSelfRefresh implements SelfRefreshable {
      readonly id: string

      constructor() {
        this.id = randomUUID()
      }

      [kSelfRefresh](): void {
        selfRefreshSpy()
      }
    }

    it('calls [kSelfRefresh] instead of recreating the instance', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(WithSelfRefresh, t => t.toSelf().lifetime(Scopes.REFRESH))
      await di.init()

      const before = di.get(WithSelfRefresh)
      await di.refresher.refresh()
      const after = di.get(WithSelfRefresh)

      expect(selfRefreshSpy).toHaveBeenCalledTimes(1)
      expect(before).toBe(after)
      expect(before.id).toBe(after.id)
    })

    it('still resets instances that do not implement SelfRefreshable', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const root = di.get(Root)
      await di.refresher.refresh()
      const rootAfter = di.get(Root)

      expect(root).not.toBe(rootAfter)
      expect(root.id).not.toBe(rootAfter.id)
    })
  })

  describe('when refreshing by label', function () {
    it('only resets bindings tagged with the given label', async function () {
      const kLabel = Symbol('refresh-label-a')

      class LabeledA {
        readonly id = Math.random()
      }

      class LabeledB {
        readonly id = Math.random()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(LabeledA, t => t.toSelf().lifetime(Scopes.REFRESH).labels(kLabel))
      di.bind(LabeledB, t => t.toSelf().lifetime(Scopes.REFRESH))
      await di.init()

      const a1 = di.get(LabeledA)
      const b1 = di.get(LabeledB)

      await di.refresher.refresh(kLabel)

      expect(di.get(LabeledA).id).not.toBe(a1.id)
      expect(di.get(LabeledB).id).toBe(b1.id)
    })

    it('leaves all bindings untouched when label matches nothing', async function () {
      const kLabel = Symbol('refresh-label-unused')

      class StableA {
        readonly id = Math.random()
      }

      class StableB {
        readonly id = Math.random()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(StableA, t => t.toSelf().lifetime(Scopes.REFRESH))
      di.bind(StableB, t => t.toSelf().lifetime(Scopes.REFRESH))
      await di.init()

      const a1 = di.get(StableA)
      const b1 = di.get(StableB)

      await di.refresher.refresh(kLabel)

      expect(di.get(StableA).id).toBe(a1.id)
      expect(di.get(StableB).id).toBe(b1.id)
    })
  })

  describe('when request a scope refresh', function () {
    it('should reset refresh scoped components', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const scope = di.refresher

      const root = di.get(Root)
      const out = di.get(Out)

      expect(scope).toBeDefined()
      expect(root).toEqual(di.get(Root))
      expect(root.id).toEqual(di.get(Root).id)
      expect(root.msg()).toEqual('test dev')
      expect(out).toEqual(di.get(Out))
      expect(out.id).toEqual(di.get(Out).id)
      expect(out.hi()).toEqual('tchau')

      await scope?.refresh()

      const rootAfter = di.get(Root)
      const outAfter = di.get(Out)

      expect(root).not.toEqual(rootAfter)
      expect(root.id).not.toEqual(rootAfter.id)
      expect(root.msg()).toEqual('test dev')
      expect(out).toEqual(outAfter)
      expect(out.id).toEqual(outAfter.id)
      expect(out.hi()).toEqual('tchau')
    })
  })
})
