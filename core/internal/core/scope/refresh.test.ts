import { describe, it, expect, vi } from 'vitest'
import { v4 } from 'uuid'
import { Scopes } from '../../../scope.js'
import { DiCaf } from '../../../container.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { Injectable } from '../../../decorators/injectable.js'
import { PreDestroy } from '../../../decorators/pre_destroy.js'

describe('Refresh Scope', function () {
  @Injectable()
  @Lifetime(Scopes.REFRESH)
  class Dep {
    readonly id: string = v4()

    fn(): string {
      return 'test'
    }
  }

  @Injectable([Dep])
  @Lifetime(Scopes.REFRESH)
  class Root {
    readonly id: string = v4()

    constructor(readonly dep: Dep) {}

    msg(): string {
      return this.dep.fn() + ' dev'
    }
  }

  @Injectable()
  class Out {
    readonly id: string = v4()

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
        @PreDestroy()
        cleanup() {
          spy()
        }
      }

      const di = new DiCaf({ decorators: false })
      di.bind(WithCustomDestroy)
        .toSelf()
      await di.init()

      di.get(WithCustomDestroy)

      const scope = di.refresher
      await scope.refresh()

      expect(spy)
        .toHaveBeenCalledTimes(1)
    })
  })

  describe('when request a scope refresh', function () {
    it('should reset refresh scoped components', async function () {
      const di = new DiCaf()
      await di.init()
      const scope = di.refresher

      const root = di.get(Root)
      const out = di.get(Out)

      expect(scope)
        .toBeDefined()
      expect(root)
        .toEqual(di.get(Root))
      expect(root.id)
        .toEqual(di.get(Root).id)
      expect(root.msg())
        .toEqual('test dev')
      expect(out)
        .toEqual(di.get(Out))
      expect(out.id)
        .toEqual(di.get(Out).id)
      expect(out.hi())
        .toEqual('tchau')

      await scope?.refresh()

      const rootAfter = di.get(Root)
      const outAfter = di.get(Out)

      expect(root).not.toEqual(rootAfter)
      expect(root.id).not.toEqual(rootAfter.id)
      expect(root.msg())
        .toEqual('test dev')
      expect(out)
        .toEqual(outAfter)
      expect(out.id)
        .toEqual(outAfter.id)
      expect(out.hi())
        .toEqual('tchau')
    })
  })
})
