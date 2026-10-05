import { describe, it, expect, beforeAll } from 'vitest'

import { createAnnotation } from '../annotations.js'
import { $aop } from '../aop.js'
import type { JoinPoint, MethodAspect } from '../aop.js'
import { CaffeineIoC } from '../container.js'
import { Aspect } from '../decorators/aspect.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { ErrInvalidDecorator } from '../errors.js'
import { type Annotation, reflect } from '../reflect.js'
import type { AnyClass } from '../types.js'

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

// ─── reflect.effective ─────────────────────────────────────────────────────

describe('reflect.effective', function () {
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
    expect(reflect.effective(AdminCtrl, Roles, 'delete')).toEqual(['superadmin'])
  })

  it('falls back to class value when member has no annotation', function () {
    expect(reflect.effective(AdminCtrl, Roles, 'list')).toEqual(['admin'])
  })

  it('returns undefined when neither class nor member is annotated', function () {
    expect(reflect.effective(Unannotated, Roles, 'run')).toBeUndefined()
  })

  it('returns class value when only class is annotated', function () {
    const ClassOnly = createAnnotation<string>()

    @ClassOnly('cls')
    class T {
      method() {}
    }

    expect(reflect.effective(T, ClassOnly, 'method')).toBe('cls')
  })

  it('returns member value when only member is annotated', function () {
    const MemberOnly = createAnnotation<number>()

    class T {
      @MemberOnly(42)
      go() {}
    }

    expect(reflect.effective(T, MemberOnly, 'go')).toBe(42)
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

// ─── reflect.annotate() primitive ─────────────────────────────────────────────────────

describe('reflect.annotate()', function () {
  it('can be used inside a decorator factory to write class-level annotations', function () {
    const Key = createAnnotation<string>()
    function Tag(value: string) {
      return (_: unknown, ctx: ClassDecoratorContext) => {
        reflect.annotate(ctx, Key, value)
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
        reflect.annotate(ctx, Key, n)
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
        reflect.annotate(ctx, Key, value, member)
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

// ─── usage: where an annotation goes ─────────────────────────────────────────

type MethodDecorator = (target: Function, context: ClassMethodDecoratorContext) => void

const Entity = createAnnotation.on('class')<{ table: string }>()
const Route = createAnnotation.on('method')<string>()
const Column = createAnnotation.on('field')<{ type: string }>()
const Observed = createAnnotation.on('accessor')()
const Computed = createAnnotation.on('getter')()
const Secured = createAnnotation.on('class', 'method')<string[]>()
const Path = createAnnotation.on('method')((path: string) => ({ path }))

describe('usage: createAnnotation.on restricts where an annotation goes', function () {
  @Entity({ table: 'users' })
  @Secured(['user'])
  class Users {
    @Column({ type: 'text' })
    name = ''

    @Observed()
    accessor count = 0

    @Route('/users')
    @Path('/users')
    @Secured(['admin'])
    list() {}

    @Route('/users/new')
    static create() {
      return new Users()
    }

    @Computed()
    get total() {
      return this.count
    }

    remove() {}
  }

  it('a class-only annotation stores the class slot', function () {
    expect(reflect.get(Users, Entity)).toEqual({ table: 'users' })
  })

  it('a method-only annotation stores instance and static method slots', function () {
    expect(reflect.get(Users, Route, 'list')).toBe('/users')
    expect(reflect.get(Users, Route, 'create', { static: true })).toBe('/users/new')
  })

  it('a field-only annotation stores the field slot', function () {
    expect(reflect.get(Users, Column, 'name')).toEqual({ type: 'text' })
  })

  it('accessor-only and getter-only markers store true', function () {
    expect(reflect.get(Users, Observed, 'count')).toBe(true)
    expect(reflect.get(Users, Computed, 'total')).toBe(true)
  })

  it('a class-or-method annotation reads with effective and merge', function () {
    expect(reflect.effective(Users, Secured, 'list')).toEqual(['admin'])
    expect(reflect.effective(Users, Secured, 'remove')).toEqual(['user'])
    expect(reflect.merge(Users, Secured, 'list')).toEqual(['user', 'admin'])
  })

  it('a restricted transform infers its arguments and stores its result', function () {
    expect(reflect.get(Users, Path, 'list')).toEqual({ path: '/users' })
  })

  it('applied outside its targets through a cast, it throws when the class is defined', function () {
    expect(() => {
      class Misplaced {
        @(Entity({ table: 'x' }) as unknown as MethodDecorator)
        list() {}
      }
      void Misplaced
    }).toThrow(ErrInvalidDecorator)
  })
})

// ─── usage: hand-written annotations ─────────────────────────────────────────

type AsyncMethod = (...args: any[]) => Promise<unknown>

const Retry: ((
  attempts: number,
) => (target: AsyncMethod, context: ClassMethodDecoratorContext<unknown, AsyncMethod>) => void) &
  Annotation<number, 'method'> = attempts => (_target, context) => {
  if (attempts < 1) {
    throw new ErrInvalidDecorator(
      `Cannot apply @Retry to method "${String(context.name)}": attempts must be at least 1`,
    )
  }
  reflect.annotate(context, Retry, attempts)
}

interface Events {
  'user.created': { id: string }
  'user.deleted': { id: string; reason: string }
}

const On: (<E extends keyof Events>(
  event: E,
) => (target: (payload: Events[E]) => unknown, context: ClassMethodDecoratorContext) => void) &
  Annotation<keyof Events, 'method'> = event => (_target, context) => {
  reflect.annotate(context, On, event)
}

const Min: ((min: number) => (target: undefined, context: ClassFieldDecoratorContext<unknown, number>) => void) &
  Annotation<number, 'field'> = min => (_target, context) => {
  reflect.annotate(context, Min, min)
}

const Factory: (() => (target: Function, context: ClassMethodDecoratorContext & { static: true }) => void) &
  Annotation<true, 'method'> = () => (_target, context) => {
  reflect.annotate(context, Factory, true)
}

const Exposed: (() => (target: Function, context: ClassMethodDecoratorContext & { private: false }) => void) &
  Annotation<true, 'method'> = () => (_target, context) => {
  reflect.annotate(context, Exposed, true)
}

const Listener: (() => (target: Function, context: ClassMethodDecoratorContext & { name: `on${string}` }) => void) &
  Annotation<true, 'method'> = () => (_target, context) => {
  reflect.annotate(context, Listener, true)
}

abstract class Repository {
  abstract find(id: string): unknown
}

const RepositoryOf: ((
  name: string,
) => (target: abstract new (...args: any[]) => Repository, context: ClassDecoratorContext) => void) &
  Annotation<string, 'class'> = name => (_target, context) => {
  reflect.annotate(context, RepositoryOf, name)
}

const Singleton: (() => (target: new () => unknown, context: ClassDecoratorContext) => void) &
  Annotation<true, 'class'> = () => (_target, context) => {
  reflect.annotate(context, Singleton, true)
}

describe('usage: hand-written annotations', function () {
  @RepositoryOf('users')
  @Singleton()
  class UsersRepository extends Repository {
    @Min(0)
    limit = 10

    override find(id: string) {
      return { id }
    }

    @Retry(3)
    async load(id: string) {
      return this.find(id)
    }

    @On('user.created')
    created(event: { id: string }) {
      return event.id
    }

    @Exposed()
    @Listener()
    onSave() {}

    @Factory()
    static create() {
      return new UsersRepository()
    }
  }

  it('each decorator stores its value under itself', function () {
    expect(reflect.get(UsersRepository, RepositoryOf)).toBe('users')
    expect(reflect.get(UsersRepository, Singleton)).toBe(true)
    expect(reflect.get(UsersRepository, Min, 'limit')).toBe(0)
    expect(reflect.get(UsersRepository, Retry, 'load')).toBe(3)
    expect(reflect.get(UsersRepository, On, 'created')).toBe('user.created')
    expect(reflect.get(UsersRepository, Exposed, 'onSave')).toBe(true)
    expect(reflect.get(UsersRepository, Listener, 'onSave')).toBe(true)
    expect(reflect.get(UsersRepository, Factory, 'create', { static: true })).toBe(true)
  })

  it('a decorator can validate its arguments when the class is defined', function () {
    expect(() => {
      class Impatient {
        @Retry(0)
        async load() {}
      }
      void Impatient
    }).toThrow(ErrInvalidDecorator)
  })
})

// ─── usage: annotation values ────────────────────────────────────────────────

interface CacheOptions {
  ttl: number
  stale: boolean
}

const Deprecated = createAnnotation()

const Cache = createAnnotation.on('method')((options: Partial<CacheOptions> = {}): CacheOptions => ({
  ttl: 30,
  stale: false,
  ...options,
}))

const kVersion = Symbol('version')

const Version = (version: number) => (_target: AnyClass, context: ClassDecoratorContext) => {
  reflect.annotate(context, kVersion, version)
}

const ColumnName: ((name?: string) => (target: undefined, context: ClassFieldDecoratorContext) => void) &
  Annotation<string, 'field'> = name => (_target, context) => {
  reflect.annotate(context, ColumnName, name ?? String(context.name))
}

const timedCalls: string[] = []

const Timed: (() => <T extends (...args: any[]) => any>(target: T, context: ClassMethodDecoratorContext) => T) &
  Annotation<true, 'method'> = () => (target, context) => {
  reflect.annotate(context, Timed, true)
  return function (this: unknown, ...args: unknown[]) {
    timedCalls.push(String(context.name))
    return target.apply(this, args)
  } as typeof target
}

const Prefix = createAnnotation.on('class')<string>()

const Resource =
  (prefix: string, ...roles: string[]) =>
  (target: AnyClass, context: ClassDecoratorContext) => {
    Prefix(prefix)(target, context)
    Secured(roles)(target, context)
  }

describe('usage: annotation values', function () {
  @Deprecated()
  @Version(2)
  @Resource('/accounts', 'admin')
  class Accounts {
    @ColumnName()
    owner = ''

    @ColumnName('created_at')
    createdAt = 0

    @Cache()
    list() {}

    @Cache({ ttl: 60 })
    find() {}

    @Timed()
    total(a: number, b: number) {
      return a + b
    }
  }

  it('a marker takes no argument and stores true', function () {
    expect(reflect.get(Accounts, Deprecated)).toBe(true)
  })

  it('a symbol-keyed annotation reads back with an explicit type', function () {
    const version: number | undefined = reflect.get<number>(Accounts, kVersion)
    expect(version).toBe(2)
  })

  it('a transform fills in defaults', function () {
    expect(reflect.get(Accounts, Cache, 'list')).toEqual({ ttl: 30, stale: false })
    expect(reflect.get(Accounts, Cache, 'find')).toEqual({ ttl: 60, stale: false })
  })

  it('a value can derive from the decorated member', function () {
    expect(reflect.get(Accounts, ColumnName, 'owner')).toBe('owner')
    expect(reflect.get(Accounts, ColumnName, 'createdAt')).toBe('created_at')
  })

  it('a decorator can replace the method it annotates', function () {
    expect(new Accounts().total(1, 2)).toBe(3)
    expect(timedCalls).toEqual(['total'])
    expect(reflect.get(Accounts, Timed, 'total')).toBe(true)
  })

  it('one decorator can apply several annotations', function () {
    expect(reflect.get(Accounts, Prefix)).toBe('/accounts')
    expect(reflect.get(Accounts, Secured)).toEqual(['admin'])
  })
})

// ─── usage: reading while decorating and listing members ─────────────────────

const AuditTable = createAnnotation.on('class')<string>()

const Controller = () => (_target: AnyClass, context: ClassDecoratorContext) => {
  if (reflect.members(context, Route).size === 0) {
    throw new ErrInvalidDecorator(
      `Cannot apply @Controller to class "${String(context.name)}": it declares no @Route method`,
    )
  }
}

const Audited = () => (_target: AnyClass, context: ClassDecoratorContext) => {
  const entity = reflect.get(context, Entity)
  reflect.annotate(context, AuditTable, entity === undefined ? 'audit' : `audit_${entity.table}`)
}

const Header: ((name: string, value: string) => (target: Function, context: ClassMethodDecoratorContext) => void) &
  Annotation<Record<string, string>, 'method'> = (name, value) => (_target, context) => {
  const headers = reflect.get(context, Header, context.name) ?? {}
  reflect.annotate(context, Header, { ...headers, [name]: value })
}

describe('usage: reading while decorating and listing members', function () {
  it('a class decorator sees the routes its members declared', function () {
    @Controller()
    class Ok {
      @Route('/ok')
      ok() {}
    }
    void Ok

    expect(() => {
      @Controller()
      class Empty {
        plain() {}
      }
      void Empty
    }).toThrow(ErrInvalidDecorator)
  })

  it('a class decorator reads what an inner class decorator wrote', function () {
    @Audited()
    @Entity({ table: 'users' })
    class Users {}

    expect(reflect.get(Users, AuditTable)).toBe('audit_users')
  })

  it('a context read sees only the class being decorated, not its base', function () {
    @Entity({ table: 'users' })
    class Users {}

    @Audited()
    class Admins extends Users {}

    expect(reflect.get(Admins, Entity)).toEqual({ table: 'users' })
    expect(reflect.get(Admins, AuditTable)).toBe('audit')
  })

  it('lists annotated fields, base-class fields included, the nearest declaration winning', function () {
    class Row {
      @Column({ type: 'int' })
      id = 0

      @Column({ type: 'text' })
      name = ''

      plain = true
    }

    class Account extends Row {
      @Column({ type: 'varchar' })
      override name = ''

      @Column({ type: 'decimal' })
      balance = 0
    }

    expect(Object.fromEntries(reflect.members(Row, Column))).toEqual({ id: { type: 'int' }, name: { type: 'text' } })
    expect(Object.fromEntries(reflect.members(Account, Column))).toEqual({
      id: { type: 'int' },
      name: { type: 'varchar' },
      balance: { type: 'decimal' },
    })
  })

  it('lists static members apart from instance members', function () {
    class Api {
      @Route('/list')
      list() {}

      @Route('/create')
      static create() {}
    }

    expect([...reflect.members(Api, Route)]).toEqual([['list', '/list']])
    expect([...reflect.members(Api, Route, { static: true })]).toEqual([['create', '/create']])
  })

  it('a hand-written annotation merges repeated applications through its own slot', function () {
    class Client {
      @Header('accept', 'application/json')
      @Header('x-trace', 'on')
      fetch() {}
    }

    expect(reflect.get(Client, Header, 'fetch')).toEqual({ accept: 'application/json', 'x-trace': 'on' })
  })
})

// ─── usage: repeated application ─────────────────────────────────────────────

const Tags = createAnnotation.on('class', 'method')<string>({ repeatable: true })

const MaybeRoute = createAnnotation.on('class', 'method')((path?: string) => path)

describe('usage: repeated application', function () {
  it('applying an annotation twice to one target throws and names the target', function () {
    let error: unknown
    try {
      class Twice {
        @Route('/1')
        @Route('/2')
        list() {}
      }
      void Twice
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(ErrInvalidDecorator)
    expect((error as Error).message).toContain('Cannot apply an annotation twice to method "list"')
    expect((error as Error).message).toContain('repeatable: true')
  })

  it('a second application throws even after one that stored undefined', function () {
    // Decorators apply innermost first: the bare `@MaybeRoute()` writes `undefined` before the other runs.
    expect(() => {
      class OnMethod {
        @MaybeRoute('/x')
        @MaybeRoute()
        list() {}
      }
      void OnMethod
    }).toThrow('Cannot apply an annotation twice to method "list"')

    expect(() => {
      class InReverse {
        @MaybeRoute()
        @MaybeRoute('/x')
        list() {}
      }
      void InReverse
    }).toThrow(ErrInvalidDecorator)

    expect(() => {
      @MaybeRoute('/x')
      @MaybeRoute()
      class OnClass {}
      void OnClass
    }).toThrow('Cannot apply an annotation twice to class "OnClass"')

    expect(() => {
      class OnStatic {
        @MaybeRoute('/x')
        @MaybeRoute()
        static list() {}
      }
      void OnStatic
    }).toThrow('Cannot apply an annotation twice to method "list"')
  })

  it('one application that stored undefined still reads as absent', function () {
    class Jobs {
      @MaybeRoute()
      static run() {}

      @MaybeRoute()
      run() {}
    }

    expect(reflect.get(Jobs, MaybeRoute, 'run')).toBeUndefined()
    expect(reflect.get(Jobs, MaybeRoute, 'run', { static: true })).toBeUndefined()
  })

  it('a repeatable annotation collects its values in source order', function () {
    @Tags('a')
    @Tags('b')
    class Tagged {
      @Tags('x')
      @Tags('y')
      run() {}
    }

    expect(reflect.get(Tagged, Tags)).toEqual(['a', 'b'])
    expect(reflect.get(Tagged, Tags, 'run')).toEqual(['x', 'y'])
    expect(reflect.merge(Tagged, Tags, 'run')).toEqual(['a', 'b', 'x', 'y'])
  })

  it('a static and an instance member of one name each take the annotation once', function () {
    class Jobs {
      @Route('/static')
      static run() {}

      @Route('/instance')
      run() {}
    }

    expect(reflect.get(Jobs, Route, 'run')).toBe('/instance')
    expect(reflect.get(Jobs, Route, 'run', { static: true })).toBe('/static')
  })

  it('a subclass may apply the annotation its base applied', function () {
    @Entity({ table: 'base' })
    class Base {}

    @Entity({ table: 'sub' })
    class Sub extends Base {}

    expect(reflect.get(Base, Entity)).toEqual({ table: 'base' })
    expect(reflect.get(Sub, Entity)).toEqual({ table: 'sub' })
  })
})

// ─── usage: inheritance and merge rules ──────────────────────────────────────

interface Timeouts {
  connect: number
  read: number
}

const Owned = createAnnotation.on('class', 'method')<string>({ inherit: 'own' })

const Permissions = createAnnotation.on(
  'class',
  'method',
)<string[]>({
  inherit: 'accumulate',
  combine: (outer, inner) => [...outer, ...inner],
})

const Timeout = createAnnotation.on(
  'class',
  'method',
)<Partial<Timeouts>>({
  combine: (outer, inner) => ({ ...outer, ...inner }),
})

const Lazy = createAnnotation.on('class', 'method')<boolean>({ combine: outer => outer })

const RoleGroups = createAnnotation.on('class', 'method')((...roles: string[]) => roles, {
  repeatable: true,
  combine: (outer, inner) => [...outer, ...inner],
})

describe('usage: inheritance and merge rules', function () {
  it("inherit 'own': a subclass sees neither its base's class value nor its base's members", function () {
    @Owned('base')
    class Base {
      @Owned('base:list')
      list() {}
    }

    class Plain extends Base {}

    @Owned('sub')
    class Sub extends Base {}

    expect(reflect.get(Base, Owned)).toBe('base')
    expect(reflect.get(Base, Owned, 'list')).toBe('base:list')
    expect(reflect.get(Plain, Owned)).toBeUndefined()
    expect(reflect.get(Plain, Owned, 'list')).toBeUndefined()
    expect(reflect.members(Plain, Owned).size).toBe(0)
    expect(reflect.get(Sub, Owned)).toBe('sub')
  })

  it("inherit 'accumulate': values add up from the base class to the subclass", function () {
    @Permissions(['read'])
    class Resource {
      @Permissions(['delete'])
      remove() {}
    }

    @Permissions(['write'])
    class Documents extends Resource {
      @Permissions(['purge'])
      override remove() {}
    }

    expect(reflect.get(Resource, Permissions)).toEqual(['read'])
    expect(reflect.get(Documents, Permissions)).toEqual(['read', 'write'])
    expect(reflect.get(Documents, Permissions, 'remove')).toEqual(['delete', 'purge'])
    expect(Object.fromEntries(reflect.members(Documents, Permissions))).toEqual({ remove: ['delete', 'purge'] })
  })

  it('combine merges class defaults into a member value', function () {
    @Timeout({ connect: 1000, read: 5000 })
    class Client {
      @Timeout({ read: 30000 })
      download() {}

      ping() {}
    }

    expect(reflect.effective(Client, Timeout, 'download')).toEqual({ connect: 1000, read: 30000 })
    expect(reflect.effective(Client, Timeout, 'ping')).toEqual({ connect: 1000, read: 5000 })
  })

  it('combine can keep the class value over the member value', function () {
    @Lazy(true)
    class Config {
      @Lazy(false)
      cache() {}
    }

    expect(reflect.effective(Config, Lazy, 'cache')).toBe(true)
    expect(reflect.get(Config, Lazy, 'cache')).toBe(false)
  })

  it('repeatable groups combine into class groups, then method groups', function () {
    @RoleGroups('admin', 'manager')
    class Payroll {
      @RoleGroups('finance')
      @RoleGroups('approver')
      approve() {}
    }

    expect(reflect.effective(Payroll, RoleGroups, 'approve')).toEqual([['admin', 'manager'], ['finance'], ['approver']])
  })

  it('an accumulating annotation without combine is refused when created', function () {
    expect(() => createAnnotation({ inherit: 'accumulate' } as never)).toThrow(ErrInvalidDecorator)
  })
})

// ─── usage: finding annotated bindings ───────────────────────────────────────

const Cron = createAnnotation.on('method')<string>()
const HealthCheck = createAnnotation.on('class')<string>()

describe('usage: finding annotated bindings', function () {
  class Reports {
    @Cron('0 * * * *')
    hourly() {}

    @Cron('0 0 * * *')
    daily() {}
  }

  @HealthCheck('db')
  class Database {}

  class Plain {}

  class Unbound {
    @Cron('* * * * *')
    tick() {}
  }

  async function containerWith(...classes: (new () => unknown)[]): Promise<CaffeineIoC> {
    const di = new CaffeineIoC({ decorators: false })
    for (const cls of classes) {
      di.bind(cls, t => t.toSelf())
    }
    await di.init()
    return di
  }

  it('a scheduler finds every bound class with a @Cron method and schedules each method', async function () {
    const di = await containerWith(Reports, Database, Plain)

    const scheduled: string[] = []
    for (const { binding } of di.getBindingsByAnnotation(Cron)) {
      for (const [method, expression] of reflect.members(binding.type!, Cron)) {
        scheduled.push(`${String(method)} ${expression}`)
      }
    }

    expect(scheduled.sort()).toEqual(['daily 0 0 * * *', 'hourly 0 * * * *'])
    expect(reflect.members(Unbound, Cron).size).toBe(1)
  })

  it('finds a class-level carrier too', async function () {
    const di = await containerWith(Reports, Database, Plain)

    expect(di.getBindingsByAnnotation(HealthCheck).map(descriptor => descriptor.key)).toEqual([Database])
  })

  it('finds nothing before the container compiles', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Reports, t => t.toSelf())

    expect(di.getBindingsByAnnotation(Cron)).toEqual([])
  })

  it("follows the annotation's inherit rule", async function () {
    const Scheduled = createAnnotation.on('method')<string>()
    const OwnScheduled = createAnnotation.on('method')<string>({ inherit: 'own' })

    class Job {
      @Scheduled('@hourly')
      @OwnScheduled('@hourly')
      run() {}
    }

    class NightlyJob extends Job {}

    const di = await containerWith(NightlyJob)

    expect(di.getBindingsByAnnotation(Scheduled).map(descriptor => descriptor.key)).toEqual([NightlyJob])
    expect(di.getBindingsByAnnotation(OwnScheduled)).toEqual([])
  })
})

// ─── usage: what does not compile ────────────────────────────────────────────

/**
 * Compile-time contract of annotation placement and typing. Never called: the assertions are the
 * `@ts-expect-error` comments, which fail the build if the error they mark stops happening.
 */
function annotationUsageTypeChecks(): void {
  @Entity({ table: 'ok' })
  class Placement {
    // @ts-expect-error a class-only annotation does not apply to a method
    @Entity({ table: 'x' })
    method() {}

    // @ts-expect-error a class-only annotation does not apply to a field
    @Entity({ table: 'x' })
    field = 1

    // @ts-expect-error a method-only annotation does not apply to a field
    @Route('/x')
    routeField = 1

    // @ts-expect-error a field-only annotation does not apply to a method
    @Column({ type: 'text' })
    columnMethod() {}

    // @ts-expect-error an accessor-only annotation does not apply to a field
    @Observed()
    observedField = 1

    // @ts-expect-error an accessor-only annotation does not apply to a method
    @Observed()
    observedMethod() {}

    // @ts-expect-error a getter-only annotation does not apply to a setter
    @Computed()
    set computedSetter(_value: number) {}

    // @ts-expect-error a getter-only annotation does not apply to a method
    @Computed()
    computedMethod() {}

    // @ts-expect-error a class-or-method annotation does not apply to a field
    @Secured(['x'])
    securedField = 1

    // @ts-expect-error a class-or-method annotation does not apply to a getter
    @Secured(['x'])
    get securedGetter() {
      return 1
    }

    // @ts-expect-error a restricted transform does not apply to a field
    @Path('/x')
    pathField = 1
  }

  // @ts-expect-error a method-only annotation does not apply to a class
  @Route('/x')
  class RouteOnClass {}

  // @ts-expect-error the value must match the annotation's type
  @Entity({ table: 1 })
  class WrongValue {}

  // @ts-expect-error a marker takes no argument
  @Deprecated('x')
  class MarkerWithArgument {}

  // @ts-expect-error a class-only annotation has no member slot to read
  reflect.get(Placement, Entity, 'method')

  // @ts-expect-error a method-only annotation has no class slot to read
  reflect.get(Placement, Route)

  // @ts-expect-error a class-only annotation has no members to list
  reflect.members(Placement, Entity)

  class HandWritten {
    // @ts-expect-error @Retry only applies to async methods
    @Retry(3)
    sync() {}

    // @ts-expect-error the handler must accept the event's payload
    @On('user.deleted')
    deleted(event: { name: number }) {
      return event
    }

    // @ts-expect-error @Min only applies to number fields
    @Min(0)
    label = ''

    // @ts-expect-error @Factory only applies to static methods
    @Factory()
    make() {}

    // @ts-expect-error @Exposed does not apply to private methods
    @Exposed()
    #hidden() {}

    callHidden() {
      this.#hidden()
    }

    // @ts-expect-error @Listener only applies to methods named on*
    @Listener()
    save() {}
  }

  // @ts-expect-error @RepositoryOf only applies to subclasses of Repository
  @RepositoryOf('x')
  class NotARepository {}

  // @ts-expect-error @Singleton needs a constructor without arguments
  @Singleton()
  class NeedsArguments {
    constructor(readonly id: string) {}
  }

  // @ts-expect-error a repeatable annotation still takes one value per application
  @Tags(['a'])
  class RepeatableWithArray {}

  // @ts-expect-error an accumulating annotation needs a combine rule
  createAnnotation.on('class')<string[]>({ inherit: 'accumulate' })

  // @ts-expect-error combine returns the stored type
  createAnnotation.on('method')<number>({ combine: (outer, inner) => String(outer + inner) })

  const wrongWrites = (_target: Function, context: ClassMethodDecoratorContext): void => {
    // @ts-expect-error the value must match the annotation's type
    reflect.annotate(context, Retry, '3')
    // @ts-expect-error a class-only annotation is not written from a method decorator
    reflect.annotate(context, Entity, { table: 'x' })
  }

  const wrongMemberWrite = (_target: AnyClass, context: ClassDecoratorContext): void => {
    // @ts-expect-error a class-only annotation has no member slot to write
    reflect.annotate(context, Entity, { table: 'x' }, 'method')
  }

  void [
    Placement,
    RouteOnClass,
    WrongValue,
    MarkerWithArgument,
    HandWritten,
    NotARepository,
    NeedsArguments,
    wrongWrites,
    wrongMemberWrite,
    RepeatableWithArray,
  ]
}

void annotationUsageTypeChecks
