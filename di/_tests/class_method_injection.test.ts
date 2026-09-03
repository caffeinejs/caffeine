import { randomUUID } from 'node:crypto'

import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Named } from '../decorators/named.js'
import { Profile } from '../decorators/profile.js'
import { ErrInvalidBinding } from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

describe('Method Injections', function () {
  const kVal = token<string>(Symbol('testVal'))
  const kBase = token<Base>(Symbol('base'))
  const kBs = token<Base>(Symbol('bs'))

  @Injectable()
  @Lifetime(Scopes.TRANSIENT)
  class TransientDep {
    readonly id: string = randomUUID()
  }

  @Injectable()
  class SingletonDep {
    readonly id: string = randomUUID()
  }

  abstract class Base {
    abstract test(): string
  }

  @Injectable()
  @Named(kBs)
  class B1 extends Base {
    test(): string {
      return 'b1'
    }
  }

  @Injectable()
  @Named(kBs, kBase)
  class B2 extends Base {
    test(): string {
      return 'b2'
    }
  }

  describe('when setting a transient dependency in a singleton component - using $i.provide()', function () {
    @Injectable()
    class SingleInject {
      id: string = randomUUID()
      transient!: Provider<TransientDep>

      @Inject([$i.provide(TransientDep)])
      setOneParameter(transient: Provider<TransientDep>) {
        this.transient = transient
      }
    }

    it('should inject a Provider<T> into a method resolving the dependency on demand on every .get()', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const r1 = di.get(SingleInject)
      const id1 = r1.transient.get()?.id
      const r2 = di.get(SingleInject)
      const id2 = r2.transient.get()?.id

      expect(r1).toBeInstanceOf(SingleInject)
      expect(r1.id).toEqual(r2.id)
      expect(r1.transient.get()).toBeInstanceOf(TransientDep)
      expect(r2.transient.get()).toBeInstanceOf(TransientDep)
      expect(r1.transient.get()?.id).not.toEqual(r2.transient.get()?.id)
      expect(id1).not.toEqual(id2)
    })
  })

  describe('when setting a singleton dependency in a transient component', function () {
    @Injectable()
    @Lifetime(Scopes.TRANSIENT)
    class Tr {
      id: string = randomUUID()
      dep!: Provider<SingletonDep>

      @Inject([$i.provide(SingletonDep)])
      setDep(dep: Provider<SingletonDep>) {
        this.dep = dep
      }
    }

    it('should init class on every resolution and inject the same singleton dependency', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const res1 = di.get(Tr)
      const res2 = di.get(Tr)

      expect(res1).toBeInstanceOf(Tr)
      expect(res2).toBeInstanceOf(Tr)
      expect(res1.id).not.toEqual(res2.id)
      expect(res1.dep.get()?.id).toEqual(res2.dep.get()?.id)
    })
  })

  describe('when setter method contains multiple and different injection types', function () {
    @Injectable()
    @Profile('method-injections-comp')
    class Comp {
      transient!: Provider<TransientDep>
      val!: string
      bases!: Base[]

      @Inject([$i.provide(TransientDep), kVal, $i.allOf(kBs)])
      setDiff(transient: Provider<TransientDep>, val: string, bases: Base[]) {
        this.transient = transient
        this.val = val
        this.bases = bases
      }
    }

    it('should resolve and inject all parameters', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['method-injections-comp'] })
      di.bind(TransientDep, t => t.toSelf())
      di.bind(B1, t => t.toSelf().names(kBs))
      di.bind(B2, t => t.toSelf().names(kBs, kBase))
      di.bind(kVal, t => t.toValue('test'))
      di.bind(Comp, t => t.toSelf().injectMethod('setDiff', $i.provide(TransientDep), kVal, $i.allOf(kBs)))

      await di.init()

      const instance = di.get(Comp)

      expect(instance).toBeInstanceOf(Comp)
      expect(instance.transient.get()).toBeInstanceOf(TransientDep)
      expect(instance.val).toEqual('test')
      expect(instance.bases).toHaveLength(2)
    })
  })

  describe('when class contains multiple setter methods', function () {
    @Injectable()
    @Profile('method-injections-test')
    class Test {
      id: string = randomUUID()
      transient!: Provider<TransientDep>
      val!: string
      bases!: Base[]
      base!: Base

      @Inject([$i.provide(TransientDep)])
      setTransient(transient: Provider<TransientDep>) {
        this.transient = transient
      }

      @Inject([kVal])
      setValue(val: string) {
        this.val = val
      }

      @Inject([$i.allOf(kBs), kBase])
      setBase(bases: Base[], base: Base) {
        this.bases = bases
        this.base = base
      }
    }

    it('should inject dependencies in all setter methods', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['method-injections-test'] })
      di.bind(TransientDep, t => t.toSelf().lifetime(Scopes.TRANSIENT))
      di.bind(B1, t => t.toSelf().names(kBs))
      di.bind(B2, t => t.toSelf().names(kBs, kBase))
      di.bind(kVal, t => t.toValue('test'))
      di.bind(Test, t =>
        t
          .toSelf()
          .injectMethod('setTransient', $i.provide(TransientDep))
          .injectMethod('setValue', kVal)
          .injectMethod('setBase', $i.allOf(kBs), kBase),
      )

      await di.init()

      const r1 = di.get(Test)
      const id1 = r1.transient.get()?.id
      const r2 = di.get(Test)
      const id2 = r2.transient.get()?.id

      expect(r1).toBeInstanceOf(Test)
      expect(r1.id).toEqual(r2.id)
      expect(r1.transient.get()).toBeInstanceOf(TransientDep)
      expect(r2.transient.get()).toBeInstanceOf(TransientDep)
      expect(r1.transient.get()?.id).not.toEqual(r2.transient.get()?.id)
      expect(id1).not.toEqual(id2)
      expect(r1.val).toEqual('test')
      expect(r1.bases).toHaveLength(2)
      expect(r1.base).toBeInstanceOf(B2)
    })
  })

  describe('given the injection order, constructor, properties and setter methods', function () {
    const kValue = token<string>(Symbol('value'))
    const kMethodValue = token<string>(Symbol('method_value'))

    @Injectable()
    @Profile('method-injections-dep')
    class Dep {
      @Inject(kValue)
      value!: string

      methodValue!: string

      @Inject([kMethodValue])
      setMethodValue(methodValue: string) {
        expect(this.value).toEqual('test')
        this.methodValue = methodValue
      }
    }

    it('should inject dependencies on setter methods after property injections', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['method-injections-dep'] })
      di.bind(kValue, t => t.toValue('test'))
      di.bind(kMethodValue, t => t.toValue('method_test'))
      di.bind(Dep, t => t.toSelf().injectProperty('value', kValue).injectMethod('setMethodValue', kMethodValue))

      await di.init()

      const res = di.get(Dep)

      expect(res.value).toEqual('test')
      expect(res.methodValue).toEqual('method_test')
    })
  })

  describe('BindingSpec.injectMethod() — happy paths', function () {
    it('should inject a single dep into a method', async function () {
      const kVal = token<string>(Symbol('val'))

      class Svc {
        val!: string
        setVal(v: string) {
          this.val = v
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kVal, t => t.toValue('hello'))
      di.bind(Svc, t => t.toSelf().injectMethod('setVal', kVal))

      await di.init()

      expect(di.get(Svc).val).toEqual('hello')
    })

    it('should inject multiple deps into a method in correct order', async function () {
      const kA = token<string>(Symbol('a'))
      const kB = token<number>(Symbol('b'))

      class Svc {
        a!: string
        b!: number
        setDeps(a: string, b: number) {
          this.a = a
          this.b = b
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kA, t => t.toValue('foo'))
      di.bind(kB, t => t.toValue(42))
      di.bind(Svc, t => t.toSelf().injectMethod('setDeps', kA, kB))
      await di.init()

      const instance = di.get(Svc)
      expect(instance.a).toEqual('foo')
      expect(instance.b).toEqual(42)
    })

    it('should inject deps into multiple methods via chaining', async function () {
      const kA = token<string>(Symbol('a'))
      const kB = token<number>(Symbol('b'))

      class Svc {
        a!: string
        b!: number
        setA(a: string) {
          this.a = a
        }

        setB(b: number) {
          this.b = b
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kA, t => t.toValue('foo'))
      di.bind(kB, t => t.toValue(42))
      di.bind(Svc, t => t.toSelf().injectMethod('setA', kA).injectMethod('setB', kB))
      await di.init()

      const instance = di.get(Svc)
      expect(instance.a).toEqual('foo')
      expect(instance.b).toEqual(42)
    })

    it('should work alongside constructor injections', async function () {
      class DepA {}
      class DepB {}

      class Svc {
        constructor(readonly depA: DepA) {}
        depB!: DepB
        setDepB(b: DepB) {
          this.depB = b
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA, t => t.toSelf())
      di.bind(DepB, t => t.toSelf())
      di.bind(Svc, t => t.toSelf([DepA]).injectMethod('setDepB', DepB))
      await di.init()

      const instance = di.get(Svc)
      expect(instance.depA).toBeInstanceOf(DepA)
      expect(instance.depB).toBeInstanceOf(DepB)
    })

    it('should leave optional dep as undefined when absent from container', async function () {
      const kOpt = token<Record<string, unknown>>(Symbol('opt'))

      class Svc {
        opt: string | undefined = 'initial'
        setOpt(v: string | undefined) {
          this.opt = v
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toSelf().injectMethod('setOpt', $i.optional(kOpt)))
      await di.init()

      expect(di.get(Svc).opt).toBeUndefined()
    })
  })

  describe('BindingSpec.injectMethod() — validation', function () {
    it('should throw ErrInvalidBinding for a symbol key', function () {
      const k = token<string>(Symbol('x'))
      const di = new CaffeineIoC({ decorators: false })
      expect(() => di.bind(k, t => t.toValue('v').injectMethod('setVal', k))).toThrow(ErrInvalidBinding)
    })

    it('should throw ErrInvalidBinding for a string key', function () {
      const di = new CaffeineIoC({ decorators: false })
      expect(() =>
        di.bind(token<string>('key'), t =>
          t.toValue('v').injectMethod('setVal', token<Record<string, unknown>>('key')),
        ),
      ).toThrow(ErrInvalidBinding)
    })
  })
})
