import { describe, it, expect, beforeAll } from 'vitest'

import { annotate, createAnnotation } from '../annotations.js'
import { $aop } from '../aop.js'
import type { JoinPoint, MethodAspect } from '../aop.js'
import { CaffeineIoC } from '../container.js'
import { Aspect } from '../decorators/aspect.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { reflect } from '../reflect.js'

// ─── fixtures ───────────────────────────────────────────────────────────────

const ServiceAnn = createAnnotation<{ name: string }>()
const PriorityAnn = createAnnotation<number>()
const TransactionalAnn = createAnnotation<{ isolation: string }>()
const CacheAnn = createAnnotation<{ ttl: number }>()
const DualAnn = createAnnotation<{ level: string }>()

// ─── class-level annotations ─────────────────────────────────────────────────

describe('class-level annotations', function () {
  @ServiceAnn({ name: 'UserService' })
  class UserService {}

  @PriorityAnn(42)
  @ServiceAnn({ name: 'PaymentService' })
  class PaymentService {}

  class Unannotated {}

  it('stores value on a decorated class and reflect.get returns it', function () {
    expect(reflect.get(UserService, ServiceAnn)).toEqual({ name: 'UserService' })
  })

  it('two independent annotations on the same class are independently retrievable', function () {
    expect(reflect.get(PaymentService, ServiceAnn)).toEqual({ name: 'PaymentService' })
    expect(reflect.get(PaymentService, PriorityAnn)).toBe(42)
  })

  it('returns undefined for a class with no such annotation', function () {
    expect(reflect.get(Unannotated, ServiceAnn)).toBeUndefined()
  })

  it('class-level lookup of a member-level annotation returns undefined', function () {
    class WithMemberOnly {
      @TransactionalAnn({ isolation: 'READ_COMMITTED' })
      save() {}
    }
    expect(reflect.get(WithMemberOnly, ServiceAnn)).toBeUndefined()
  })

  it('two distinct createAnnotation() calls produce independent keys — no collision', function () {
    const Ann1 = createAnnotation<string>()
    const Ann2 = createAnnotation<string>()

    @Ann2('second')
    @Ann1('first')
    class Multi {}

    expect(reflect.get(Multi, Ann1)).toBe('first')
    expect(reflect.get(Multi, Ann2)).toBe('second')
  })
})

// ─── member-level annotations ─────────────────────────────────────────────────

describe('member-level annotations', function () {
  class Repo {
    @TransactionalAnn({ isolation: 'SERIALIZABLE' })
    save() {}

    @CacheAnn({ ttl: 60 })
    find() {}

    plain() {}
  }

  it('stores value on a decorated method and reflect.get returns it', function () {
    expect(reflect.get(Repo, TransactionalAnn, 'save')).toEqual({ isolation: 'SERIALIZABLE' })
  })

  it('stores value on a different method independently', function () {
    expect(reflect.get(Repo, CacheAnn, 'find')).toEqual({ ttl: 60 })
  })

  it('returns undefined for an unannotated method on the same class', function () {
    expect(reflect.get(Repo, TransactionalAnn, 'plain')).toBeUndefined()
  })

  it('class-level lookup of a member-level annotation returns undefined', function () {
    expect(reflect.get(Repo, CacheAnn)).toBeUndefined()
  })

  it('two member annotations on different methods are independently retrievable', function () {
    expect(reflect.get(Repo, TransactionalAnn, 'save')).toBeDefined()
    expect(reflect.get(Repo, TransactionalAnn, 'find')).toBeUndefined()
    expect(reflect.get(Repo, CacheAnn, 'find')).toBeDefined()
    expect(reflect.get(Repo, CacheAnn, 'save')).toBeUndefined()
  })

  it('stores value on a decorated field', function () {
    const FieldAnn = createAnnotation<string>()
    class WithField {
      @FieldAnn('hello')
      name = ''
    }
    expect(reflect.get(WithField, FieldAnn, 'name')).toBe('hello')
  })

  it('two distinct createAnnotation() calls produce independent keys — no collision', function () {
    const Ann1 = createAnnotation<string>()
    const Ann2 = createAnnotation<string>()
    class Multi {
      @Ann2('second')
      @Ann1('first')
      method() {}
    }
    expect(reflect.get(Multi, Ann1, 'method')).toBe('first')
    expect(reflect.get(Multi, Ann2, 'method')).toBe('second')
  })
})

// ─── dual-use (class + member) ────────────────────────────────────────────────

describe('dual-use annotation (class + member)', function () {
  @DualAnn({ level: 'info' })
  class ClassTarget {
    @DualAnn({ level: 'debug' })
    method() {}

    plain() {}
  }

  it('when applied to a class: reflect.get(Cls, Ann) returns value', function () {
    expect(reflect.get(ClassTarget, DualAnn)).toEqual({ level: 'info' })
  })

  it('when applied to a class only: unannotated member lookup returns undefined', function () {
    @DualAnn({ level: 'warn' })
    class ClassOnly {
      anyMember() {}
    }
    expect(reflect.get(ClassOnly, DualAnn, 'anyMember')).toBeUndefined()
  })

  it('when applied to a method: reflect.get(Cls, Ann, name) returns value', function () {
    const MemberOnly = createAnnotation<string>()
    class T {
      @MemberOnly('hello')
      go() {}
    }
    expect(reflect.get(T, MemberOnly, 'go')).toBe('hello')
    expect(reflect.get(T, MemberOnly)).toBeUndefined()
  })

  it('same annotation applied to both class and member: both retrievable independently', function () {
    expect(reflect.get(ClassTarget, DualAnn)).toEqual({ level: 'info' })
    expect(reflect.get(ClassTarget, DualAnn, 'method')).toEqual({ level: 'debug' })
  })

  it('two distinct createAnnotation() calls produce independent keys', function () {
    const A1 = createAnnotation<string>()
    const A2 = createAnnotation<string>()

    @A2('b')
    @A1('a')
    class T {}

    expect(reflect.get(T, A1)).toBe('a')
    expect(reflect.get(T, A2)).toBe('b')
  })
})

// ─── reflect.get ─────────────────────────────────────────────────────────────

describe('reflect.get', function () {
  it('returns undefined for a class with no Symbol.metadata', function () {
    class Bare {}
    expect(reflect.get(Bare, ServiceAnn)).toBeUndefined()
  })

  it('returns undefined when Symbol.metadata exists but has no annotations slot', function () {
    @Injectable()
    class SomeBean {}
    expect(reflect.get(SomeBean, ServiceAnn)).toBeUndefined()
  })
})

// ─── AOP integration ─────────────────────────────────────────────────────────

const RoutAnn = createAnnotation<{ prefix: string }>()
const HandlerAnn = createAnnotation<{ method: string }>()

describe('AOP integration', function () {
  describe('PointcutClassPredicate receives annotations', function () {
    const classAnnSpy: { prefix: string | undefined }[] = []

    @RoutAnn({ prefix: '/api' })
    @Injectable()
    class ApiController {
      handle() {
        return 'ok'
      }
    }

    @Injectable()
    class PlainService {
      run() {
        return 'ok'
      }
    }

    @Aspect([$aop.pointcut((_desc, cls) => reflect.get(cls, RoutAnn) !== undefined)])
    @Profile('aop-ann-class-pred')
    class ClassPredAspect implements MethodAspect {
      before(_jp: JoinPoint) {
        classAnnSpy.push({ prefix: reflect.get(_jp.ctor, RoutAnn)?.prefix })
      }
    }
    void ClassPredAspect

    it('only weaves classes carrying the annotation', async function () {
      classAnnSpy.length = 0
      const di = new CaffeineIoC({ profiles: ['aop-ann-class-pred'] })
      di.bind(ApiController, t => t.toSelf())
      di.bind(PlainService, t => t.toSelf())
      await di.init()

      di.get(ApiController).handle()
      di.get(PlainService).run()

      expect(classAnnSpy).toHaveLength(1)
      expect(classAnnSpy[0].prefix).toBe('/api')
    })
  })

  describe('PointcutMethodPredicate receives annotations', function () {
    const methodAnnSpy: { method: string | undefined; name: string | symbol }[] = []

    @Injectable()
    class HttpController {
      @HandlerAnn({ method: 'GET' })
      getUsers() {
        return []
      }

      @HandlerAnn({ method: 'POST' })
      createUser() {
        return {}
      }

      notAHandler() {
        return null
      }
    }

    @Aspect([$aop.forClass(HttpController, (name, _desc, cls) => reflect.get(cls, HandlerAnn, name) !== undefined)])
    @Profile('aop-ann-method-pred')
    class MethodPredAspect implements MethodAspect {
      before(jp: JoinPoint) {
        methodAnnSpy.push({ method: reflect.get(jp.ctor, HandlerAnn, jp.methodName)?.method, name: jp.methodName })
      }
    }
    void MethodPredAspect

    it('only weaves methods carrying the annotation', async function () {
      methodAnnSpy.length = 0
      const di = new CaffeineIoC({ profiles: ['aop-ann-method-pred'] })
      di.bind(HttpController, t => t.toSelf())
      await di.init()

      const ctrl = di.get(HttpController)
      ctrl.getUsers()
      ctrl.createUser()
      ctrl.notAHandler()

      expect(methodAnnSpy).toHaveLength(2)
      const names = methodAnnSpy.map(e => e.name).sort()
      expect(names).toEqual(['createUser', 'getUsers'])
    })

    it('reflect.get(jp.cls, HandlerAnn, methodName) returns the annotation value', async function () {
      methodAnnSpy.length = 0
      const di = new CaffeineIoC({ profiles: ['aop-ann-method-pred'] })
      di.bind(HttpController, t => t.toSelf())
      await di.init()

      di.get(HttpController).getUsers()

      const e = methodAnnSpy.find(m => m.name === 'getUsers')
      expect(e?.method).toBe('GET')
    })
  })

  describe('JoinPoint.cls', function () {
    const jpAnnSpy: { classAnn: unknown; memberAnn: unknown }[] = []

    const SvcAnn = createAnnotation<string>()
    const OpAnn = createAnnotation<string>()

    @SvcAnn('payment-svc')
    @Injectable()
    class PaySvc {
      @OpAnn('charge')
      charge() {
        return 'charged'
      }
    }

    @Aspect([$aop.forClass(PaySvc, 'charge')])
    @Profile('aop-ann-jp')
    class JpAspect implements MethodAspect {
      before(jp: JoinPoint) {
        jpAnnSpy.push({
          classAnn: reflect.get(jp.ctor, SvcAnn),
          memberAnn: reflect.get(jp.ctor, OpAnn, jp.methodName),
        })
      }
    }
    void JpAspect

    let di: CaffeineIoC

    beforeAll(async function () {
      di = new CaffeineIoC({ profiles: ['aop-ann-jp'] })
      di.bind(PaySvc, t => t.toSelf())
      await di.init()
    })

    it('reflect.get(jp.cls, ClassAnn) returns class-level annotation', function () {
      jpAnnSpy.length = 0
      di.get(PaySvc).charge()
      expect(jpAnnSpy[0].classAnn).toBe('payment-svc')
    })

    it('reflect.get(jp.cls, MemberAnn, methodName) returns member-level annotation', function () {
      jpAnnSpy.length = 0
      di.get(PaySvc).charge()
      expect(jpAnnSpy[0].memberAnn).toBe('charge')
    })

    it('jp.cls is the class constructor — same reference on every call', function () {
      const clsRefs: unknown[] = []

      @Injectable()
      class ClsRefSvc {
        run() {}
      }

      @Aspect([$aop.forClass(ClsRefSvc, 'run')])
      @Profile('aop-ann-cls-ref')
      class ClsRefAspect implements MethodAspect {
        before(jp: JoinPoint) {
          clsRefs.push(jp.ctor)
        }
      }
      void ClsRefAspect

      const localDi = new CaffeineIoC({ profiles: ['aop-ann-cls-ref'] })
      localDi.bind(ClsRefSvc, t => t.toSelf())
      return localDi.init().then(() => {
        const svc = localDi.get(ClsRefSvc)
        svc.run()
        svc.run()
        svc.run()
        expect(clsRefs[0]).toBe(ClsRefSvc)
        expect(clsRefs[1]).toBe(ClsRefSvc)
        expect(clsRefs[2]).toBe(ClsRefSvc)
      })
    })
  })
})

// ─── reflect.getOverride ─────────────────────────────────────────────────────

describe('reflect.getOverride', function () {
  const Roles = createAnnotation<string[]>()

  @Roles(['admin'])
  class AdminCtrl {
    @Roles(['superadmin'])
    delete() {}

    list() {}
  }

  class Unannotated {
    run() {}
  }

  it('returns member value when present', function () {
    expect(reflect.getOverride(AdminCtrl, Roles, 'delete')).toEqual(['superadmin'])
  })

  it('falls back to class value when member has no annotation', function () {
    expect(reflect.getOverride(AdminCtrl, Roles, 'list')).toEqual(['admin'])
  })

  it('returns undefined when neither class nor member is annotated', function () {
    expect(reflect.getOverride(Unannotated, Roles, 'run')).toBeUndefined()
  })

  it('returns class value when only class is annotated', function () {
    const ClassOnly = createAnnotation<string>()

    @ClassOnly('cls')
    class T {
      method() {}
    }

    expect(reflect.getOverride(T, ClassOnly, 'method')).toBe('cls')
  })

  it('returns member value when only member is annotated', function () {
    const MemberOnly = createAnnotation<number>()

    class T {
      @MemberOnly(42)
      go() {}
    }

    expect(reflect.getOverride(T, MemberOnly, 'go')).toBe(42)
  })
})

// ─── createAnnotation with transform ─────────────────────────────────────────

describe('createAnnotation with transform', function () {
  const Roles = createAnnotation((...roles: string[]) => roles)
  const Weight = createAnnotation((n: number) => n * 2)

  @Roles('admin', 'user')
  class AdminCtrl {
    @Roles('superadmin')
    delete() {}

    unannotated() {}
  }

  @Weight(5)
  class Heavy {}

  it('stores transform result on a decorated class', function () {
    expect(reflect.get(AdminCtrl, Roles)).toEqual(['admin', 'user'])
  })

  it('stores transform result on a decorated method', function () {
    expect(reflect.get(AdminCtrl, Roles, 'delete')).toEqual(['superadmin'])
  })

  it('returns undefined for unannotated member', function () {
    expect(reflect.get(AdminCtrl, Roles, 'unannotated')).toBeUndefined()
  })

  it('transform is applied before storing — result is not the raw args array', function () {
    expect(reflect.get(Heavy, Weight)).toBe(10)
  })
})

// ─── annotate() primitive ─────────────────────────────────────────────────────

describe('annotate()', function () {
  it('can be used inside a decorator factory to write class-level annotations', function () {
    const Key = createAnnotation<string>()
    function Tag(value: string) {
      return (_: unknown, ctx: ClassDecoratorContext) => {
        annotate(ctx, Key, value)
      }
    }
    @Tag('service')
    class T {}
    expect(reflect.get(T, Key)).toBe('service')
  })

  it('can be used inside a decorator factory to write member-level annotations', function () {
    const Key = createAnnotation<number>()
    function Weight(n: number) {
      return (_: unknown, ctx: ClassMemberDecoratorContext) => {
        annotate(ctx, Key, n)
      }
    }
    class T {
      @Weight(42)
      run() {}
    }
    expect(reflect.get(T, Key, 'run')).toBe(42)
  })

  it('memberName parameter writes to a specific member slot regardless of decorator kind', function () {
    const Key = createAnnotation<string>()
    function TagWithSlot(value: string, member: string) {
      return (_: unknown, ctx: ClassDecoratorContext) => {
        annotate(ctx, Key, value, member)
      }
    }
    @TagWithSlot('hello', 'synthetic')
    class T {}
    expect(reflect.get(T, Key, 'synthetic')).toBe('hello')
    expect(reflect.get(T, Key)).toBeUndefined()
  })
})

// ─── reflect.merge ───────────────────────────────────────────────────────────

describe('reflect.merge', function () {
  const Perms = createAnnotation<string[]>()

  @Perms(['read', 'write'])
  class ResourceCtrl {
    @Perms(['delete'])
    destroy() {}

    list() {}
  }

  class Unannotated {
    run() {}
  }

  it('concatenates class and member arrays — class values first', function () {
    expect(reflect.merge(ResourceCtrl, Perms, 'destroy')).toEqual(['read', 'write', 'delete'])
  })

  it('returns class array only when member is not annotated', function () {
    expect(reflect.merge(ResourceCtrl, Perms, 'list')).toEqual(['read', 'write'])
  })

  it('returns empty array when neither class nor member is annotated', function () {
    expect(reflect.merge(Unannotated, Perms, 'run')).toEqual([])
  })

  it('returns member array only when class is not annotated', function () {
    const MemberPerms = createAnnotation<string[]>()

    class T {
      @MemberPerms(['exec'])
      run() {}
    }

    expect(reflect.merge(T, MemberPerms, 'run')).toEqual(['exec'])
  })

  it('two distinct annotations merge independently', function () {
    const A = createAnnotation<string[]>()
    const B = createAnnotation<string[]>()

    @A(['a1'])
    @B(['b1'])
    class T {
      @A(['a2'])
      @B(['b2'])
      method() {}
    }

    expect(reflect.merge(T, A, 'method')).toEqual(['a1', 'a2'])
    expect(reflect.merge(T, B, 'method')).toEqual(['b1', 'b2'])
  })
})
