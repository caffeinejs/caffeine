import { describe, it, expect, afterAll } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { ErrScopeMismatch } from '../errors.js'
import { provide, allOf } from '../injection.js'
import { Scopes, bindScope, unbindScope } from '../scope.js'
import { ResolutionContext } from '../resolution_context.js'

describe('checks:scopes', function () {
  describe('constructor injection', function () {
    it('allows same scope (singleton → singleton)', async function () {
      const kDep = Symbol('sm-dep-ss')
      const kOwner = Symbol('sm-owner-ss')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows same scope (transient → transient)', async function () {
      const kDep = Symbol('sm-dep-tt')
      const kOwner = Symbol('sm-owner-tt')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.TRANSIENT)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when singleton depends on transient', async function () {
      const kDep = Symbol('sm-dep-st')
      const kOwner = Symbol('sm-owner-st')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when transient depends on singleton', async function () {
      const kDep = Symbol('sm-dep-ts')
      const kOwner = Symbol('sm-owner-ts')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.SINGLETON)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.TRANSIENT)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when singleton depends on refresh', async function () {
      const kDep = Symbol('sm-dep-srf')
      const kOwner = Symbol('sm-owner-srf')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.REFRESH)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows singleton → provide(transient)', async function () {
      const kDep = Symbol('sm-dep-spt')
      const kOwner = Symbol('sm-owner-spt')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [provide(kDep)])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows transient → provide(singleton)', async function () {
      const kDep = Symbol('sm-dep-tps')
      const kOwner = Symbol('sm-owner-tps')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.SINGLETON)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [provide(kDep)])
        .lifetime(Scopes.TRANSIENT)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when allOf injects different-scoped bindings', async function () {
      const kDep = Symbol('sm-dep-allof')
      const kOwner = Symbol('sm-owner-allof')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown[]) => ({}), [allOf(kDep)])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })

  describe('property injection', function () {
    it('throws when property is injected from different scope', async function () {
      class SmPropDep {}
      class SmPropOwner {}

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(SmPropDep)
        .toClass(SmPropDep)
        .lifetime(Scopes.TRANSIENT)
      di.bind(SmPropOwner)
        .toClass(SmPropOwner)
        .lifetime(Scopes.SINGLETON)
        .injectProperty('dep', SmPropDep)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows property injection when scopes match', async function () {
      class SmPropDepOk {}
      class SmPropOwnerOk {}

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(SmPropDepOk)
        .toClass(SmPropDepOk)
        .lifetime(Scopes.SINGLETON)
      di.bind(SmPropOwnerOk)
        .toClass(SmPropOwnerOk)
        .lifetime(Scopes.SINGLETON)
        .injectProperty('dep', SmPropDepOk)

      await expect(di.init()).resolves.not.toThrow()
    })
  })

  describe('method injection', function () {
    it('throws when method param is injected from different scope', async function () {
      class SmMethodDep {}
      class SmMethodOwner {
        init(_dep: SmMethodDep) {}
      }

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(SmMethodDep)
        .toClass(SmMethodDep)
        .lifetime(Scopes.TRANSIENT)
      di.bind(SmMethodOwner)
        .toClass(SmMethodOwner)
        .lifetime(Scopes.SINGLETON)
        .injectMethod('init', SmMethodDep)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })

  describe('multiple violations', function () {
    it('collects all violations before throwing', async function () {
      const kDepA = Symbol('sm-mv-dep-a')
      const kDepB = Symbol('sm-mv-dep-b')
      const kOwner = Symbol('sm-mv-owner')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDepA)
        .toValue('a')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_a: unknown, _b: unknown) => ({}), [kDepA, kDepB])
        .lifetime(Scopes.SINGLETON)

      let caught: ErrScopeMismatch | undefined
      try {
        await di.init()
      } catch (e) {
        caught = e as ErrScopeMismatch
      }

      expect(caught)
        .toBeInstanceOf(ErrScopeMismatch)
      expect(caught!.violations)
        .toHaveLength(1)
    })
  })

  describe('checks: { scopes: \'off\' }', function () {
    it('skips scope validation when scopes check is off', async function () {
      const kDep = Symbol('sm-off-dep')
      const kOwner = Symbol('sm-off-owner')
      const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.SINGLETON)

      await expect(di.init()).resolves.not.toThrow()
    })
  })

  describe('custom scopes', function () {
    it('throws when two different custom scopes are mixed', async function () {
      const kScopeA = Symbol('sm-custom-scope-a')
      const kScopeB = Symbol('sm-custom-scope-b')
      const kDep = Symbol('sm-custom-dep')
      const kOwner = Symbol('sm-custom-owner')

      bindScope(kScopeA, () => ({
        provide: (_, f) => f(_),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        undo: () => {},
        get lazy() { return true },
        get durable() { return true },
      }))
      bindScope(kScopeB, () => ({
        provide: (_, f) => f({} as unknown as ResolutionContext),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        undo: () => {},
        get lazy() { return true },
        get durable() { return true },
      }))

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(kScopeA)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(kScopeB)

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)

      unbindScope(kScopeA)
      unbindScope(kScopeB)
    })
  })

  describe('error message', function () {
    it('mentions both keys and their scopes in violation message', async function () {
      const kDep = Symbol('sm-msg-dep')
      const kOwner = Symbol('sm-msg-owner')
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep)
        .toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner)
        .toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.SINGLETON)

      let caught: ErrScopeMismatch | undefined
      try {
        await di.init()
      } catch (e) {
        caught = e as ErrScopeMismatch
      }

      expect(caught)
        .toBeInstanceOf(ErrScopeMismatch)
      expect(caught!.message.toLowerCase())
        .toContain('transient')
      expect(caught!.message.toLowerCase())
        .toContain('provide(')
    })
  })

  describe('compatible-scopes-only', function () {
    const kNonDurableScope = Symbol('cso-non-durable-scope')

    afterAll(() => {
      unbindScope(kNonDurableScope)
    })

    it('setup: register custom non-durable scope', function () {
      bindScope(kNonDurableScope, () => ({
        provide: (ctx, f) => f(ctx),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        get lazy() { return true },
        get durable() { return false },
      }))
    })

    it('allows durable → durable (singleton → singleton)', async function () {
      const kDep = Symbol('cso-dep-ss')
      const kOwner = Symbol('cso-owner-ss')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows durable → durable (singleton → refresh)', async function () {
      const kDep = Symbol('cso-dep-srf')
      const kOwner = Symbol('cso-owner-srf')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
        .lifetime(Scopes.REFRESH)
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when durable depends on non-durable (singleton → transient)', async function () {
      const kDep = Symbol('cso-dep-st')
      const kOwner = Symbol('cso-owner-st')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when durable depends on non-durable (singleton → custom non-durable)', async function () {
      const kDep = Symbol('cso-dep-snd')
      const kOwner = Symbol('cso-owner-snd')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
        .lifetime(kNonDurableScope)
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows non-durable → durable (transient → singleton)', async function () {
      const kDep = Symbol('cso-dep-ts')
      const kOwner = Symbol('cso-owner-ts')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.TRANSIENT)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows non-durable → durable (custom non-durable → singleton)', async function () {
      const kDep = Symbol('cso-dep-nds')
      const kOwner = Symbol('cso-owner-nds')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])
        .lifetime(kNonDurableScope)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows non-durable → non-durable (transient → transient)', async function () {
      const kDep = Symbol('cso-dep-tt')
      const kOwner = Symbol('cso-owner-tt')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner).toFunction((_: unknown) => ({}), [kDep])
        .lifetime(Scopes.TRANSIENT)

      await expect(di.init()).resolves.not.toThrow()
    })

    it('skips provide() injections regardless of scope mismatch', async function () {
      const kDep = Symbol('cso-dep-prov')
      const kOwner = Symbol('cso-owner-prov')
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep).toValue('dep')
        .lifetime(Scopes.TRANSIENT)
      di.bind(kOwner).toFunction((_: unknown) => ({}), [provide(kDep)])

      await expect(di.init()).resolves.not.toThrow()
    })
  })
})
