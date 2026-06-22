import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { Lazy } from '../decorators/lazy.js'
import { Profile } from '../decorators/profile.js'
import { DiCaf } from '../container.js'
import { ErrNoResolutionForKey, ErrNoUniqueInjectionForKey } from '../errors.js'
import { optional } from '../injection.js'

describe('Optional Injections', function () {
  describe('with no default values', function () {
    class Repo {}

    interface Service {
      run(): void
    }

    @Injectable([optional(Repo)])
    class OptSvc {
      constructor(readonly repo?: Repo) {}
    }

    @Injectable([Repo])
    @Profile('opt-non-optional')
    @Lazy()
    class NonSvc {
      constructor(readonly repo?: Repo) {}
    }

    @Injectable([optional('service')])
    class Ctrl {
      constructor(readonly service?: Service) {}
    }

    it('should inject undefined values when dependency cannot be resolved and is marked as optional', async function () {
      const di = new DiCaf()
      await di.init()
      const svc = di.get(OptSvc)
      const ctrl = di.get(Ctrl)

      expect(svc.repo)
        .toBeUndefined()
      expect(svc.repo).not.toBe(null)
      expect(ctrl.service)
        .toBeUndefined()
      expect(ctrl.service).not.toBe(null)
    })

    it('should throw at init when a non-optional injection has no binding', async function () {
      const di = new DiCaf({ profiles: ['opt-non-optional'] })
      await expect(di.init()).rejects.toThrow(ErrNoResolutionForKey)
    })
  })

  describe('with default values', function () {
    const kVal = Symbol('test')

    class Dep {
      constructor(readonly value: string) {}
    }

    @Injectable()
    class Reg {}

    @Injectable([optional(kVal)])
    class OptStr {
      constructor(readonly value: string = 'optional') {}
    }

    @Injectable([Reg, optional(Dep)])
    class Test {
      constructor(
        readonly reg: Reg,
        readonly dep: Dep = new Dep('default value'),
      ) {}
    }

    it('should keep the optional value', async function () {
      const di = new DiCaf()
      await di.init()
      const optStr = di.get(OptStr)
      const test = di.get(Test)

      expect(optStr.value)
        .toEqual('optional')
      expect(test.reg)
        .toBeInstanceOf(Reg)
      expect(test.dep)
        .toBeInstanceOf(Dep)
      expect(test.dep.value)
        .toEqual('default value')
    })
  })
})

describe('container.getOptional()', function () {
  it('should return the instance when the key is registered', async function () {
    const di = new DiCaf({ decorators: false })
    di.bind('svc').toValue('hello')
    await di.init()

    expect(di.getOptional('svc')).toBe('hello')
  })

  it('should return undefined when the key is not registered', async function () {
    const di = new DiCaf({ decorators: false })
    await di.init()

    expect(di.getOptional('nonexistent')).toBeUndefined()
  })

  it('should return the primary instance when multiple bindings share a key', async function () {
    const kSvc = Symbol('opt-primary')

    const di = new DiCaf({ decorators: false })
    di.bind('primary-val').toValue('primary')
      .names(kSvc)
      .primary()
    di.bind('secondary-val').toValue('secondary')
      .names(kSvc)
    await di.init()

    expect(di.getOptional(kSvc)).toBe('primary')
  })

  it('should throw ErrNoUniqueInjectionForKey when multiple bindings exist without a primary', async function () {
    const kSvc = Symbol('opt-ambig')

    const di = new DiCaf({ decorators: false })
    di.bind('val-a').toValue('alpha')
      .names(kSvc)
    di.bind('val-b').toValue('bravo')
      .names(kSvc)
    await di.init()

    expect(() => di.getOptional(kSvc)).toThrow(ErrNoUniqueInjectionForKey)
  })
})
