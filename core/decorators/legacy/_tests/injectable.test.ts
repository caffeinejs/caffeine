import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Injectable } from '../injectable.js'
import { Inject } from '../inject.js'
import { Lifetime } from '../lifetime.js'
import { Scopes } from '../../../scope.js'

describe('Legacy @Injectable', function () {
  describe('with explicit dependencies array', function () {
    @Injectable()
    class Dep {
      value() {
        return 'dep'
      }
    }

    @Injectable([Dep])
    class Service {
      constructor(readonly dep: Dep) {}
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves service with explicit dep', function () {
      const svc = di.get(Service)
      expect(svc)
        .toBeInstanceOf(Service)
      expect(svc.dep)
        .toBeInstanceOf(Dep)
      expect(svc.dep.value())
        .toBe('dep')
    })
  })

  describe('with design:paramtypes auto-discovery', function () {
    @Injectable()
    class AutoDep {
      hello() {
        return 'hello'
      }
    }

    @Injectable()
    class AutoService {
      constructor(readonly dep: AutoDep) {}
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves service via design:paramtypes', function () {
      const svc = di.get(AutoService)
      expect(svc)
        .toBeInstanceOf(AutoService)
      expect(svc.dep)
        .toBeInstanceOf(AutoDep)
      expect(svc.dep.hello())
        .toBe('hello')
    })
  })

  describe('with @Inject on constructor parameter', function () {
    @Injectable()
    class ParamDep {
      greet() {
        return 'greet'
      }
    }

    @Injectable()
    class ParamService {
      constructor(@Inject(ParamDep) readonly dep: ParamDep) {}
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves service via constructor param @Inject', function () {
      const svc = di.get(ParamService)
      expect(svc)
        .toBeInstanceOf(ParamService)
      expect(svc.dep)
        .toBeInstanceOf(ParamDep)
      expect(svc.dep.greet())
        .toBe('greet')
    })
  })

  describe('with named key', function () {
    const KEY = 'named-legacy-svc'

    @Injectable(KEY)
    class NamedImpl {
      name() {
        return 'named'
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves by named key', function () {
      const byName = di.get<NamedImpl>(KEY)
      const byType = di.get(NamedImpl)

      expect(byName)
        .toEqual(byType)
      expect(byName)
        .toBeInstanceOf(NamedImpl)
      expect(byName.name())
        .toBe('named')
    })
  })

  describe('singleton by default', function () {
    @Injectable()
    class SingletonSvc {
      readonly id = Math.random()
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('returns same instance on multiple gets', function () {
      const a = di.get(SingletonSvc)
      const b = di.get(SingletonSvc)
      expect(a)
        .toBe(b)
      expect(a.id)
        .toBe(b.id)
    })
  })

  describe('@Singleton explicit', function () {
    @Lifetime(Scopes.SINGLETON)
    @Injectable()
    class ExplicitSingleton {
      readonly id = Math.random()
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('returns same instance', function () {
      const a = di.get(ExplicitSingleton)
      const b = di.get(ExplicitSingleton)
      expect(a)
        .toBe(b)
    })
  })
})
