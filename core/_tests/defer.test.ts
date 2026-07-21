import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { $i } from '../injection.js'
import { ErrScopeMismatch } from '../errors.js'
import { Scopes } from '../scope.js'

describe('$i.defer() composition', function () {
  describe('$i.optional($i.defer())', function () {
    it('injects the instance when dep is registered', async function () {
      class Dep {
        tag() {
          return 'dep'
        }
      }

      class Owner {
        constructor(readonly dep: Dep | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Dep)
        .toSelf()
      di.bind(Owner)
        .toSelf([$i.optional($i.defer(() => Dep))])
      await di.init()

      const owner = di.get(Owner)
      expect(owner.dep)
        .toBeInstanceOf(Dep)
      expect(owner.dep!.tag())
        .toEqual('dep')
    })

    describe('when the deferred key is not registered and marked as optional', function () {
      it('should inject undefined', async function () {
        class MissingDep {}

        class Owner {
          constructor(readonly dep: MissingDep | undefined) {}
        }

        const di = new CaffeineIoC({ decorators: false })
        di.bind(Owner)
          .toSelf([$i.optional($i.defer(() => MissingDep))])
        await di.init()

        const owner = di.get(Owner)
        expect(owner.dep)
          .toBeUndefined()
      })
    })
  })

  describe('$i.allOf($i.defer())', function () {
    it('injects all bindings for the deferred key', async function () {
      const kPlugin = Symbol('plugin')

      class PluginA {
        name() {
          return 'a'
        }
      }

      class PluginB {
        name() {
          return 'b'
        }
      }

      class Host {
        constructor(readonly plugins: { name(): string }[]) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(PluginA)
        .toSelf()
        .names(kPlugin)
      di.bind(PluginB)
        .toSelf()
        .names(kPlugin)
      di.bind(Host)
        .toSelf([$i.allOf($i.defer(() => kPlugin))])
      await di.init()

      const host = di.get(Host)
      expect(host.plugins)
        .toHaveLength(2)
      expect(host.plugins.map(p => p.name())
        .sort())
        .toEqual(['a', 'b'])
    })

    it('injects empty array when no bindings are registered for the deferred key', async function () {
      const kAbsent = Symbol('absent')

      class Host {
        constructor(readonly items: unknown[]) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Host)
        .toSelf([$i.allOf($i.defer(() => kAbsent))])
      await di.init()

      const host = di.get(Host)
      expect(host.items)
        .toEqual([])
    })

    it('strict mode: throws ErrScopeMismatch when SINGLETON depends on TRANSIENT via $i.allOf($i.defer())', async function () {
      class TransientDep {}

      class SingletonOwner {
        constructor(readonly deps: TransientDep[]) {}
      }

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })
      di.bind(TransientDep)
        .toSelf()
        .lifetime(Scopes.TRANSIENT)
      di.bind(SingletonOwner)
        .toSelf([$i.allOf($i.defer(() => TransientDep))])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })
})
