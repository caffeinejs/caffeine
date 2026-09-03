import { describe, it, expect, vi } from 'vitest'
import { CaffeineIoC, Aspect, Profile, createAnnotation, reflect, $aop } from '@caffeinejs/di'
import type { JoinPoint, MethodAspect, PointcutClassPredicate, PointcutMethodPredicate, InjectionToken } from '@caffeinejs/di'

// ─── Guard interface ──────────────────────────────────────────────────────────

interface Guard {
  guard(jp: JoinPoint): boolean | Promise<boolean>
}

// ─── UseGuard annotation ──────────────────────────────────────────────────────

const UseGuard = createAnnotation<InjectionToken>()

// ─── Pointcut predicates ──────────────────────────────────────────────────────

const guardClassPred: PointcutClassPredicate = (_desc, cls) => {
  if (reflect.get(cls, UseGuard) !== undefined) {
    return true
  }
  // scan prototype chain once at weave time for method-level annotations
  let proto = (cls as any).prototype
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && reflect.get(cls, UseGuard, name) !== undefined) {
        return true
      }
    }
    proto = Object.getPrototypeOf(proto)
  }
  return false
}

const guardMethodPred: PointcutMethodPredicate = (name, _desc, cls) =>
  reflect.getOverride(cls, UseGuard, name) !== undefined

// ─── GuardAspect ─────────────────────────────────────────────────────────────

@Aspect([$aop.pointcut(guardClassPred, guardMethodPred)], [CaffeineIoC])
@Profile('guard-e2e')
class GuardAspect implements MethodAspect {
  constructor(private readonly container: CaffeineIoC) {}

  before(jp: JoinPoint): void | Promise<void> {
    const key = reflect.getOverride(jp.ctor, UseGuard, jp.methodName)
    if (key === undefined) {
      return
    }
    const guard = this.container.get(key as any) as Guard
    const result = guard.guard(jp)
    // Sync guard: throw immediately so the intercepted method stays synchronous.
    // Async guard: return the Promise so the chain becomes async only when needed.
    if (result instanceof Promise) {
      return result.then(allowed => {
        if (!allowed) {
          throw new Error(`Forbidden: access denied by guard on "${String(jp.methodName)}"`)
        }
      })
    }
    if (!result) {
      throw new Error(`Forbidden: access denied by guard on "${String(jp.methodName)}"`)
    }
  }
}
void GuardAspect

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeContainer(...extra: Array<(di: CaffeineIoC) => void>) {
  const di = new CaffeineIoC({ profiles: ['guard-e2e'] })
  // Container must self-bind so GuardAspect can dynamically resolve guards by key.
  // Framework gap: CaffeineIoC does not auto-register itself; callers must do it manually.
  di.bind(CaffeineIoC, t => t.toValue(di))
  for (const setup of extra) {
    setup(di)
  }
  return di
}

// ─── guard implementations ────────────────────────────────────────────────────

class AllowGuard implements Guard {
  guard(_jp: JoinPoint): boolean { return true }
}

class DenyGuard implements Guard {
  guard(_jp: JoinPoint): boolean { return false }
}

class AsyncAllowGuard implements Guard {
  async guard(_jp: JoinPoint): Promise<boolean> { return true }
}

class AsyncDenyGuard implements Guard {
  async guard(_jp: JoinPoint): Promise<boolean> { return false }
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('AOP guard — class-level annotation', function () {
  @UseGuard(AllowGuard)
  class Resource {
    get(id: number): number { return id }
    create(name: string): string { return `created:${name}` }
  }

  it('allows access when class-level guard returns true', async function () {
    const di = makeContainer(d => {
      d.bind(Resource, t => t.toSelf())
      d.bind(AllowGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(Resource)
    expect(svc.get(42)).toBe(42)
    expect(svc.create('item')).toBe('created:item')
  })

  it('denies access when class-level guard returns false', async function () {
    @UseGuard(DenyGuard)
    class Restricted {
      action(): string { return 'done' }
    }

    const di = makeContainer(d => {
      d.bind(Restricted, t => t.toSelf())
      d.bind(DenyGuard, t => t.toSelf())
    })
    await di.init()

    expect(() => di.get(Restricted).action()).toThrow(/Forbidden/)
  })

  it('every method on the class is guarded', async function () {
    const callCount = { get: 0, create: 0 }

    class TrackingGuard implements Guard {
      guard(jp: JoinPoint): boolean {
        callCount[jp.methodName as 'get' | 'create']++
        return true
      }
    }

    @UseGuard(TrackingGuard)
    class TrackedResource {
      get(): string { return 'get' }
      create(): string { return 'create' }
    }

    const di = makeContainer(d => {
      d.bind(TrackedResource, t => t.toSelf())
      d.bind(TrackingGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(TrackedResource)
    svc.get()
    svc.create()

    expect(callCount.get).toBe(1)
    expect(callCount.create).toBe(1)
  })
})

describe('AOP guard — method-level annotation', function () {
  class PartialService {
    @UseGuard(DenyGuard)
    sensitive(): string { return 'secret' }

    open(): string { return 'public' }
  }

  it('guards only the annotated method', async function () {
    const di = makeContainer(d => {
      d.bind(PartialService, t => t.toSelf())
      d.bind(DenyGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(PartialService)
    expect(() => svc.sensitive()).toThrow(/Forbidden/)
    expect(svc.open()).toBe('public')
  })

  it('unannotated method is never intercepted', async function () {
    const guardSpy = vi.fn(() => true)

    class SpyGuard implements Guard {
      guard(_jp: JoinPoint): boolean { return guardSpy() }
    }

    class SemiGuarded {
      @UseGuard(SpyGuard)
      guarded(): string { return 'guarded' }

      free(): string { return 'free' }
    }

    const di = makeContainer(d => {
      d.bind(SemiGuarded, t => t.toSelf())
      d.bind(SpyGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(SemiGuarded)
    svc.free()
    expect(guardSpy).not.toHaveBeenCalled()

    svc.guarded()
    expect(guardSpy).toHaveBeenCalledOnce()
  })
})

describe('AOP guard — method-level overrides class-level', function () {
  class TwoGuardService {
    @UseGuard(AllowGuard)
    allowed(): string { return 'allowed' }

    blocked(): string { return 'blocked' }
  }
  Object.defineProperty(TwoGuardService, 'name', { value: 'TwoGuardService' })

  it('method annotation overrides class annotation', async function () {
    @UseGuard(DenyGuard)
    class OverrideService {
      @UseGuard(AllowGuard)
      allowed(): string { return 'allowed' }

      blocked(): string { return 'blocked' }
    }

    const di = makeContainer(d => {
      d.bind(OverrideService, t => t.toSelf())
      d.bind(AllowGuard, t => t.toSelf())
      d.bind(DenyGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(OverrideService)
    expect(svc.allowed()).toBe('allowed')
    expect(() => svc.blocked()).toThrow(/Forbidden/)
  })
})

describe('AOP guard — async guards', function () {
  it('async guard returning true allows the call', async function () {
    @UseGuard(AsyncAllowGuard)
    class AsyncResource {
      fetch(): string { return 'data' }
    }

    const di = makeContainer(d => {
      d.bind(AsyncResource, t => t.toSelf())
      d.bind(AsyncAllowGuard, t => t.toSelf())
    })
    await di.init()

    await expect(di.get(AsyncResource).fetch()).resolves.toBe('data')
  })

  it('async guard returning false denies the call', async function () {
    @UseGuard(AsyncDenyGuard)
    class AsyncRestricted {
      action(): string { return 'done' }
    }

    const di = makeContainer(d => {
      d.bind(AsyncRestricted, t => t.toSelf())
      d.bind(AsyncDenyGuard, t => t.toSelf())
    })
    await di.init()

    await expect(di.get(AsyncRestricted).action()).rejects.toThrow(/Forbidden/)
  })
})

describe('AOP guard — unannotated class is not intercepted', function () {
  it('class without @UseGuard is never proxied through the guard', async function () {
    const guardSpy = vi.fn(() => true)

    class NoGuardService {
      run(): string { return 'running' }
    }

    class UnusedGuard implements Guard {
      guard(_jp: JoinPoint): boolean { return guardSpy() }
    }

    const di = makeContainer(d => {
      d.bind(NoGuardService, t => t.toSelf())
      d.bind(UnusedGuard, t => t.toSelf())
    })
    await di.init()

    di.get(NoGuardService).run()
    expect(guardSpy).not.toHaveBeenCalled()
  })
})

describe('AOP guard — JoinPoint fields inside guard', function () {
  it('guard receives correct methodName, args, and cls', async function () {
    const captured: { methodName: string | symbol, args: unknown[], cls: unknown }[] = []

    class InspectGuard implements Guard {
      guard(jp: JoinPoint): boolean {
        captured.push({ methodName: jp.methodName, args: [...jp.args], cls: jp.ctor })
        return true
      }
    }

    @UseGuard(InspectGuard)
    class InspectedService {
      compute(x: number, y: number): number { return x + y }
    }

    const di = makeContainer(d => {
      d.bind(InspectedService, t => t.toSelf())
      d.bind(InspectGuard, t => t.toSelf())
    })
    await di.init()

    di.get(InspectedService).compute(3, 7)

    expect(captured).toHaveLength(1)
    expect(captured[0].methodName).toBe('compute')
    expect(captured[0].args).toEqual([3, 7])
    expect(captured[0].cls).toBe(InspectedService)
  })
})

describe('AOP guard — multiple guard implementations', function () {
  it('different guards protect different methods independently', async function () {
    class AdminGuard implements Guard {
      guard(_jp: JoinPoint): boolean { return true }
    }

    class OwnerGuard implements Guard {
      guard(_jp: JoinPoint): boolean { return false }
    }

    class MultiGuardedService {
      @UseGuard(AdminGuard)
      adminAction(): string { return 'admin' }

      @UseGuard(OwnerGuard)
      ownerAction(): string { return 'owner' }
    }

    const di = makeContainer(d => {
      d.bind(MultiGuardedService, t => t.toSelf())
      d.bind(AdminGuard, t => t.toSelf())
      d.bind(OwnerGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(MultiGuardedService)
    expect(svc.adminAction()).toBe('admin')
    expect(() => svc.ownerAction()).toThrow(/Forbidden/)
  })

  it('guard singleton is shared across all calls to the same method', async function () {
    let instanceCount = 0

    class CountingGuard implements Guard {
      constructor() { instanceCount++ }
      guard(_jp: JoinPoint): boolean { return true }
    }

    @UseGuard(CountingGuard)
    class RepeatService {
      ping(): string { return 'pong' }
    }

    const di = makeContainer(d => {
      d.bind(RepeatService, t => t.toSelf())
      d.bind(CountingGuard, t => t.toSelf())
    })
    await di.init()

    const svc = di.get(RepeatService)
    svc.ping()
    svc.ping()
    svc.ping()

    // Singleton: constructed once regardless of call count
    expect(instanceCount).toBe(1)
  })
})
