import { describe, it, expect } from 'vitest'
import { DiCaf } from '../container.js'
import { allOf, defer, optional } from '../injection.js'
import { ErrScopeMismatch } from '../errors.js'
import { Scopes } from '../scope.js'

describe('defer() composition', function () {
  describe('optional(defer())', function () {
    it('injects the instance when dep is registered', async function () {
      class Dep {
        tag() {
          return 'dep'
        }
      }

      class Owner {
        constructor(readonly dep: Dep | undefined) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(Dep)
        .toSelf()
      di.bind(Owner)
        .toSelf([optional(defer(() => Dep))])
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

        const di = new DiCaf({ decorators: false })
        di.bind(Owner)
          .toSelf([optional(defer(() => MissingDep))])
        await di.init()

        const owner = di.get(Owner)
        expect(owner.dep)
          .toBeUndefined()
      })
    })
  })

  describe('allOf(defer())', function () {
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

      const di = new DiCaf({ decorators: false })
      di.bind(PluginA)
        .toSelf()
        .names(kPlugin)
      di.bind(PluginB)
        .toSelf()
        .names(kPlugin)
      di.bind(Host)
        .toSelf([allOf(defer(() => kPlugin))])
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

      const di = new DiCaf({ decorators: false })
      di.bind(Host)
        .toSelf([allOf(defer(() => kAbsent))])
      await di.init()

      const host = di.get(Host)
      expect(host.items)
        .toEqual([])
    })

    it('strict mode: throws ErrScopeMismatch when SINGLETON depends on TRANSIENT via allOf(defer())', async function () {
      class TransientDep {}

      class SingletonOwner {
        constructor(readonly deps: TransientDep[]) {}
      }

      const di = new DiCaf({ checks: { scopes: 'no-mix' }, decorators: false })
      di.bind(TransientDep)
        .toSelf()
        .lifetime(Scopes.TRANSIENT)
      di.bind(SingletonOwner)
        .toSelf([allOf(defer(() => TransientDep))])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })
})
