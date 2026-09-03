import { describe, it, expect, afterAll } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrScopeMismatch } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { ResolutionContext } from '../resolution_context.js'
import { Scopes, bindScope, unbindScope, type Scope } from '../scope.js'

describe('checks:scopes', function () {
  describe('constructor injection', function () {
    it('allows same scope (singleton → singleton)', async function () {
      const kDep = token<string>(Symbol('sm-dep-ss'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-ss'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep'))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows same scope (transient → transient)', async function () {
      const kDep = token<string>(Symbol('sm-dep-tt'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-tt'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.TRANSIENT))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when singleton depends on transient', async function () {
      const kDep = token<string>(Symbol('sm-dep-st'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-st'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.SINGLETON))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when transient depends on singleton', async function () {
      const kDep = token<string>(Symbol('sm-dep-ts'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-ts'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.SINGLETON))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.TRANSIENT))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when singleton depends on refresh', async function () {
      const kDep = token<string>(Symbol('sm-dep-srf'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-srf'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.REFRESH))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.SINGLETON))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows singleton → $i.provide(transient)', async function () {
      const kDep = token<string>(Symbol('sm-dep-spt'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-spt'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [$i.provide(kDep)]).lifetime(Scopes.SINGLETON))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows transient → $i.provide(singleton)', async function () {
      const kDep = token<string>(Symbol('sm-dep-tps'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-tps'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.SINGLETON))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [$i.provide(kDep)]).lifetime(Scopes.TRANSIENT))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when allOf injects different-scoped bindings', async function () {
      const kDep = token<string>(Symbol('sm-dep-allof'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-owner-allof'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown[]) => ({}), [$i.allOf(kDep)]).lifetime(Scopes.SINGLETON))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })

  describe('property injection', function () {
    it('throws when property is injected from different scope', async function () {
      class SmPropDep {}
      class SmPropOwner {}

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(SmPropDep, t => t.toClass(SmPropDep).lifetime(Scopes.TRANSIENT))
      di.bind(SmPropOwner, t => t.toClass(SmPropOwner).lifetime(Scopes.SINGLETON).injectProperty('dep', SmPropDep))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows property injection when scopes match', async function () {
      class SmPropDepOk {}
      class SmPropOwnerOk {}

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(SmPropDepOk, t => t.toClass(SmPropDepOk).lifetime(Scopes.SINGLETON))
      di.bind(SmPropOwnerOk, t =>
        t.toClass(SmPropOwnerOk).lifetime(Scopes.SINGLETON).injectProperty('dep', SmPropDepOk),
      )

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

      di.bind(SmMethodDep, t => t.toClass(SmMethodDep).lifetime(Scopes.TRANSIENT))
      di.bind(SmMethodOwner, t => t.toClass(SmMethodOwner).lifetime(Scopes.SINGLETON).injectMethod('init', SmMethodDep))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })
  })

  describe('multiple violations', function () {
    it('collects all violations before throwing', async function () {
      const kDepA = token<string>(Symbol('sm-mv-dep-a'))
      const kDepB = token<Record<string, unknown>>(Symbol('sm-mv-dep-b'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-mv-owner'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDepA, t => t.toValue('a').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_a: unknown, _b: unknown) => ({}), [kDepA, kDepB]).lifetime(Scopes.SINGLETON))

      let caught: ErrScopeMismatch | undefined
      try {
        await di.init()
      } catch (e) {
        caught = e as ErrScopeMismatch
      }

      expect(caught).toBeInstanceOf(ErrScopeMismatch)
      expect(caught!.violations).toHaveLength(1)
    })
  })

  describe("checks: { scopes: 'off' }", function () {
    it('skips scope validation when scopes check is off', async function () {
      const kDep = token<string>(Symbol('sm-off-dep'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-off-owner'))
      const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.SINGLETON))

      await expect(di.init()).resolves.not.toThrow()
    })
  })

  describe('custom scopes', function () {
    it('throws when two different custom scopes are mixed', async function () {
      const kScopeA = token<Scope>(Symbol('sm-custom-scope-a'))
      const kScopeB = token<Scope>(Symbol('sm-custom-scope-b'))
      const kDep = token<string>(Symbol('sm-custom-dep'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-custom-owner'))

      bindScope(kScopeA, () => ({
        provide: (_, f) => f(_),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        undo: () => {},
        get lazy() {
          return true
        },
        get durable() {
          return true
        },
      }))
      bindScope(kScopeB, () => ({
        provide: (_, f) => f({} as unknown as ResolutionContext),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        undo: () => {},
        get lazy() {
          return true
        },
        get durable() {
          return true
        },
      }))

      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(kScopeA))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(kScopeB))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)

      unbindScope(kScopeA)
      unbindScope(kScopeB)
    })
  })

  describe('error message', function () {
    it('mentions both keys and their scopes in violation message', async function () {
      const kDep = token<string>(Symbol('sm-msg-dep'))
      const kOwner = token<Record<string, unknown>>(Symbol('sm-msg-owner'))
      const di = new CaffeineIoC({ checks: { scopes: 'no-mix' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.SINGLETON))

      let caught: ErrScopeMismatch | undefined
      try {
        await di.init()
      } catch (e) {
        caught = e as ErrScopeMismatch
      }

      expect(caught).toBeInstanceOf(ErrScopeMismatch)
      expect(caught!.message.toLowerCase()).toContain('transient')
      expect(caught!.message.toLowerCase()).toContain('$i.provide(')
    })
  })

  describe('compatible-scopes-only', function () {
    const kNonDurableScope = token<Scope>(Symbol('cso-non-durable-scope'))

    afterAll(() => {
      unbindScope(kNonDurableScope)
    })

    it('setup: register custom non-durable scope', function () {
      bindScope(kNonDurableScope, () => ({
        provide: (ctx, f) => f(ctx),
        cachedInstance: () => undefined,
        reset: () => {},
        configure: () => {},
        get lazy() {
          return true
        },
        get durable() {
          return false
        },
      }))
    })

    it('allows durable → durable (singleton → singleton)', async function () {
      const kDep = token<string>(Symbol('cso-dep-ss'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-ss'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep'))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows durable → durable (singleton → refresh)', async function () {
      const kDep = token<string>(Symbol('cso-dep-srf'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-srf'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.REFRESH))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('throws when durable depends on non-durable (singleton → transient)', async function () {
      const kDep = token<string>(Symbol('cso-dep-st'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-st'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('throws when durable depends on non-durable (singleton → custom non-durable)', async function () {
      const kDep = token<string>(Symbol('cso-dep-snd'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-snd'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(kNonDurableScope))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]))

      await expect(di.init()).rejects.toThrow(ErrScopeMismatch)
    })

    it('allows non-durable → durable (transient → singleton)', async function () {
      const kDep = token<string>(Symbol('cso-dep-ts'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-ts'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep'))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.TRANSIENT))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows non-durable → durable (custom non-durable → singleton)', async function () {
      const kDep = token<string>(Symbol('cso-dep-nds'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-nds'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep'))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(kNonDurableScope))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('allows non-durable → non-durable (transient → transient)', async function () {
      const kDep = token<string>(Symbol('cso-dep-tt'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-tt'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [kDep]).lifetime(Scopes.TRANSIENT))

      await expect(di.init()).resolves.not.toThrow()
    })

    it('skips $i.provide() injections regardless of scope mismatch', async function () {
      const kDep = token<string>(Symbol('cso-dep-prov'))
      const kOwner = token<Record<string, unknown>>(Symbol('cso-owner-prov'))
      const di = new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' }, decorators: false })

      di.bind(kDep, t => t.toValue('dep').lifetime(Scopes.TRANSIENT))
      di.bind(kOwner, t => t.toFunction((_: unknown) => ({}), [$i.provide(kDep)]))

      await expect(di.init()).resolves.not.toThrow()
    })
  })
})
