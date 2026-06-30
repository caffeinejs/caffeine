import { describe, expect, it } from 'vitest'
import {
  Async,
  CaffeineIoC,
  Configuration,
  ErrUnresolvableDependencies,
  Inject,
  Injectable,
  Profile,
  Provides,
  optional,
} from '@caffeinejs/core'
import { InstanceTracker } from './tracker.js'
import { TestContainer } from './test_container.js'

describe('TestContainer', function () {
  const kMsg = Symbol('kMsg')

  @Injectable()
  class Repository {}

  @Injectable()
  class UnrelatedService {}

  @Configuration()
  class AppConfig {
    @Provides(kMsg)
    message(): string {
      return 'hello'
    }
  }

  @Injectable([Repository, kMsg])
  class Controller {
    constructor(
      readonly repository: Repository,
      readonly message: string,
    ) {}
  }

  @Injectable()
  class WithPropertyInjection {
    @Inject(Repository)
    repo!: Repository
  }

  @Injectable([optional(UnrelatedService)])
  class WithOptionalDep {
    constructor(readonly dep: UnrelatedService | undefined = undefined) {}
  }

  @Injectable()
  class ExclusiveDep {}

  @Injectable([ExclusiveDep])
  class RepositoryWithExclusive {
    constructor(readonly dep: ExclusiveDep) {}
  }

  @Injectable()
  class SharedDep {}

  @Injectable([SharedDep])
  class RepositoryWithShared {
    constructor(readonly dep: SharedDep) {}
  }

  @Injectable([RepositoryWithShared, SharedDep])
  class ControllerWithShared {
    constructor(
      readonly repo: RepositoryWithShared,
      readonly shared: SharedDep,
    ) {}
  }

  describe('base()', function () {
    it('resolves the root type', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.get(Repository))
        .toBeInstanceOf(Repository)
    })

    it('resolves root with all its dependencies', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()
      const ctrl = di.get(Controller)

      expect(ctrl).toBeInstanceOf(Controller)
      expect(ctrl.repository).toBeInstanceOf(Repository)
      expect(ctrl.message).toBe('hello')
    })

    it('includes all bindings — not focused to one root', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.has(Repository)).toBe(true)
      expect(di.has(UnrelatedService)).toBe(true)
      expect(di.has(AppConfig)).toBe(true)
    })

    it('resolves property injection', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.get(WithPropertyInjection).repo)
        .toBeInstanceOf(Repository)
    })

    it('resolves root with optional dep present', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.get(WithOptionalDep))
        .toBeInstanceOf(WithOptionalDep)
    })
  })

  describe('override()', function () {
    it('replaces a dep with the given value', async function () {
      const mockRepo = { isMock: true } as unknown as Repository
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .override(Repository, b => b.toValue(mockRepo))
        .build()
      await di.init()
      const ctrl = di.get(Controller)

      expect(ctrl.repository)
        .toBe(mockRepo)
    })

    it('allows overriding a named key', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .override(kMsg, b => b.toValue('overridden'))
        .build()
      await di.init()
      const ctrl = di.get(Controller)

      expect(ctrl.message)
        .toBe('overridden')
    })
  })

  describe('isolate()', function () {
    it('isolated key resolves to the provided value', async function () {
      const mockRepo = {} as RepositoryWithExclusive
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .isolate(RepositoryWithExclusive, false, b => b.toValue(mockRepo))
        .build()
      await di.init()

      expect(di.get(RepositoryWithExclusive))
        .toBe(mockRepo)
    })

    it('exclusive sub-deps of isolated key are pruned', async function () {
      const mockRepo = {} as RepositoryWithExclusive
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .isolate(RepositoryWithExclusive, false, b => b.toValue(mockRepo))
        .build()

      expect(di.has(ExclusiveDep))
        .toBe(false)
    })

    it('shared dep of isolated key is NOT pruned', async function () {
      const mockRepo = {} as RepositoryWithShared
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .isolate(RepositoryWithShared, false, b => b.toValue(mockRepo))
        .build()

      expect(di.has(ControllerWithShared)).toBe(true)
      expect(di.has(SharedDep)).toBe(true)
    })

    it('pruneShared: true removes shared dep regardless', async function () {
      const mockRepo = {} as RepositoryWithShared
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .isolate(RepositoryWithShared, true, b => b.toValue(mockRepo))
        .build()

      expect(di.has(SharedDep)).toBe(false)
    })
  })

  describe('skipAsyncBindings() / skip()', function () {
    const kConn = Symbol('kConn')

    @Configuration()
    class InfraConfig {
      @Provides(kConn)
      @Async()
      async connection(): Promise<string> {
        return 'live-connection'
      }
    }

    @Injectable([kConn])
    class ServiceWithAsyncDep {
      constructor(readonly conn: string) {}
    }

    it('skipAsyncBindings() with no args strips all async bindings', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).skipAsyncBindings()
        .build()

      expect(di.has(InfraConfig)).toBe(true)
      expect(di.has(kConn)).toBe(false)
    })

    it('skipAsyncBindings(key) preserves the listed async binding', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).skipAsyncBindings(kConn)
        .build()

      expect(di.has(kConn)).toBe(true)
    })

    it('skip(key) strips an async binding', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).skip(kConn)
        .build()

      expect(di.has(kConn)).toBe(false)
      expect(di.has(Repository)).toBe(true)
    })

    it('skip(key) strips a non-async binding', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).skip(Repository)
        .build()

      expect(di.has(Repository)).toBe(false)
      expect(di.has(kConn)).toBe(true)
    })

    it('override key is exempt from skipAsyncBindings filter and resolves', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(ServiceWithAsyncDep)
        .skipAsyncBindings()
        .override(kConn, b => b.toValue('mock-connection'))
        .build()
      await di.init()

      expect(di.get<string>(kConn)).toBe('mock-connection')
      expect(di.get(ServiceWithAsyncDep).conn).toBe('mock-connection')
    })

    it('isolate key is exempt from skipAsyncBindings filter', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .skipAsyncBindings()
        .isolate(kConn, false, b => b.toValue('mock-connection'))
        .build()

      expect(di.has(kConn)).toBe(true)
    })

    it('chained calls accumulate exceptions', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .skipAsyncBindings()
        .skipAsyncBindings(kConn)
        .build()

      expect(di.has(kConn)).toBe(true)
    })
  })

  describe('focus()', function () {
    it('keeps root and its transitive deps', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller)
        .build()

      expect(di.has(Controller)).toBe(true)
      expect(di.has(Repository)).toBe(true)
    })

    it('drops bindings not in the dep tree', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller)
        .build()

      expect(di.has(UnrelatedService)).toBe(false)
    })

    it('multi-root keeps union of both trees', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller, UnrelatedService)
        .build()

      expect(di.has(Controller)).toBe(true)
      expect(di.has(UnrelatedService)).toBe(true)
    })

    it('composes with isolate — dep analysis reflects focused scope', async function () {
      const mockRepo = {} as Repository
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(Controller)
        .isolate(Repository, false, b => b.toValue(mockRepo))
        .build()
      await di.init()

      expect(di.get(Controller).repository).toBe(mockRepo)
    })
  })

  describe('build()', function () {
    it('returns an uninitialized CaffeineIoC', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()

      expect(di.ready)
        .toBe(false)
    })

    it('can be initialized manually', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.ready).toBe(true)
      expect(di.get(Repository)).toBeInstanceOf(Repository)
    })
  })

  describe('TestPostProcessor', function () {
    it('records instances created during init()', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Repository)).toBe(true)
      expect(tracker.wasInstantiated(Controller)).toBe(true)
    })

    it('instancesOf() returns the singleton instance', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      di.postProcessors.add(tracker)
      await di.init()

      const instances = tracker.instancesOf(Repository)
      expect(instances).toHaveLength(1)
      expect(instances[0]).toBeInstanceOf(Repository)
      expect(instances[0]).toBe(di.get(Repository))
    })

    it('wasInstantiated() returns false for classes outside the focused graph', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Repository)
        .build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Controller)).toBe(false)
      expect(tracker.wasInstantiated(UnrelatedService)).toBe(false)
    })

    it('confirms focus() trimmed bindings were not instantiated', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Repository)
        .build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Repository)).toBe(true)
      expect(tracker.wasInstantiated(UnrelatedService)).toBe(false)
      expect(tracker.wasInstantiated(Controller)).toBe(false)
    })

    it('reset() clears all recorded events', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Repository)).toBe(true)
      tracker.reset()
      expect(tracker.wasInstantiated(Repository)).toBe(false)
      expect(tracker.events()).toHaveLength(0)
    })

    it('events() preserves dep-before-dependent order', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller)
        .build()
      di.postProcessors.add(tracker)
      await di.init()

      const keys = tracker.events().map(e => e.key)
      expect(keys.indexOf(Repository)).toBeLessThan(keys.indexOf(Controller))
    })
  })

  describe('complex async graphs', function () {
    const kCgConnStr = Symbol('kCgConnStr')
    const kCgDbPool = Symbol('kCgDbPool')
    const kCgDbConn = Symbol('kCgDbConn')
    const kCgRedisUrl = Symbol('kCgRedisUrl')
    const kCgCache = Symbol('kCgCache')

    class CgDbPool {
      constructor(readonly connStr: string) {}
    }
    class CgDbConn {
      constructor(readonly pool: CgDbPool) {}
    }
    class CgCacheClient {
      constructor(readonly url: string) {}
    }

    @Configuration()
    class CgInfraConfig {
      @Provides(kCgConnStr)
      connStr(): string {
        return 'postgres://test'
      }

      @Async()
      @Provides(kCgDbPool, [kCgConnStr])
      async dbPool(cs: string): Promise<CgDbPool> {
        return new CgDbPool(cs)
      }

      @Async()
      @Provides(kCgDbConn, [kCgDbPool])
      async dbConn(pool: CgDbPool): Promise<CgDbConn> {
        return new CgDbConn(pool)
      }

      @Provides(kCgRedisUrl)
      redisUrl(): string {
        return 'redis://test'
      }

      @Async()
      @Provides(kCgCache, [kCgRedisUrl])
      async cacheClient(url: string): Promise<CgCacheClient> {
        return new CgCacheClient(url)
      }
    }

    @Injectable([kCgDbConn])
    class CgUserRepo {
      constructor(readonly conn: CgDbConn) {}
    }

    @Injectable([kCgCache, CgUserRepo])
    class CgUserService {
      constructor(
        readonly cache: CgCacheClient,
        readonly repo: CgUserRepo,
      ) {}
    }

    @Injectable([kCgDbConn, CgUserService])
    class CgOrderService {
      constructor(
        readonly conn: CgDbConn,
        readonly userSvc: CgUserService,
      ) {}
    }

    @Injectable()
    @Profile('ci')
    class CgCiOnlyService {
      readonly env = 'ci'
    }

    it('resolves the full 3-level async chain end-to-end', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(CgOrderService)
        .build()
      await di.init()

      const ord = di.get(CgOrderService)
      expect(ord).toBeInstanceOf(CgOrderService)
      expect(ord.conn).toBeInstanceOf(CgDbConn)
      expect(ord.conn.pool).toBeInstanceOf(CgDbPool)
      expect(ord.conn.pool.connStr).toBe('postgres://test')
      expect(ord.userSvc).toBeInstanceOf(CgUserService)
      expect(ord.userSvc.cache).toBeInstanceOf(CgCacheClient)
      expect(ord.userSvc.cache.url).toBe('redis://test')
      expect(ord.userSvc.repo).toBeInstanceOf(CgUserRepo)
    })

    it('kCgDbConn is a singleton — CgOrderService and CgUserRepo share the same instance', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(CgOrderService)
        .build()
      await di.init()

      const ord = di.get(CgOrderService)
      expect(ord.conn).toBe(ord.userSvc.repo.conn)
    })

    it('focus + skipAsyncBindings + overrides — integration test pattern', async function () {
      const fakeConn = new CgDbConn(new CgDbPool('fake'))
      const fakeCache = new CgCacheClient('fake-redis')

      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .skipAsyncBindings()
        .override(kCgDbConn, b => b.toValue(fakeConn))
        .override(kCgCache, b => b.toValue(fakeCache))
        .build()
      await di.init()

      expect(di.has(kCgDbPool)).toBe(false)
      const ord = di.get(CgOrderService)
      expect(ord.conn).toBe(fakeConn)
      expect(ord.userSvc.cache).toBe(fakeCache)
    })

    it('two TestContainers from the same snapshot are independent', async function () {
      const source = new CaffeineIoC()
      const snap = source.snapshot()

      const fake1 = new CgDbConn(new CgDbPool('snap1'))
      const fake2 = new CgDbConn(new CgDbPool('snap2'))

      const di1 = new TestContainer(snap)
        .focus(CgOrderService)
        .skipAsyncBindings()
        .override(kCgDbConn, b => b.toValue(fake1))
        .override(kCgCache, b => b.toValue(new CgCacheClient('r1')))
        .build()

      const di2 = new TestContainer(snap)
        .focus(CgOrderService)
        .skipAsyncBindings()
        .override(kCgDbConn, b => b.toValue(fake2))
        .override(kCgCache, b => b.toValue(new CgCacheClient('r2')))
        .build()

      await di1.init()
      await di2.init()

      expect(di1.get(CgOrderService).conn).toBe(fake1)
      expect(di2.get(CgOrderService).conn).toBe(fake2)
      expect(di1.get(CgOrderService).conn).not.toBe(di2.get(CgOrderService).conn)
    })

    it('isolate(kCgDbConn, true) prunes the db chain, leaving the cache chain intact', function () {
      const fakeConn = new CgDbConn(new CgDbPool('fake'))
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .isolate(kCgDbConn, true, b => b.toValue(fakeConn))
        .build()

      expect(di.has(kCgDbPool)).toBe(false)
      expect(di.has(kCgConnStr)).toBe(false)
      expect(di.has(kCgCache)).toBe(true)
      expect(di.has(kCgRedisUrl)).toBe(true)
    })

    it('isolate(kCgDbConn, false) prunes exclusive db deps, preserves CgInfraConfig shared by cache', function () {
      const fakeConn = new CgDbConn(new CgDbPool('fake'))
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .isolate(kCgDbConn, false, b => b.toValue(fakeConn))
        .build()

      expect(di.has(kCgDbPool)).toBe(false)
      expect(di.has(kCgConnStr)).toBe(false)
      expect(di.has(CgInfraConfig)).toBe(true)
      expect(di.has(kCgCache)).toBe(true)
    })

    it('modules() registers a test-local binding not in the source', async function () {
      const kTestClock = Symbol('kTestClock')
      const fakeClock = { now: () => 0 }

      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .skipAsyncBindings()
        .override(kCgDbConn, b => b.toValue(new CgDbConn(new CgDbPool('f'))))
        .override(kCgCache, b => b.toValue(new CgCacheClient('f')))
        .modules(c => {
          c.bind(kTestClock).toValue(fakeClock)
        })
        .build()
      await di.init()

      expect(di.get(kTestClock)).toBe(fakeClock)
    })

    it('profiles() makes active profiles accessible during init', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .skipAsyncBindings()
        .profiles('staging')
        .override(kCgDbConn, b => b.toValue(new CgDbConn(new CgDbPool('f'))))
        .override(kCgCache, b => b.toValue(new CgCacheClient('f')))
        .build()
      await di.init()

      expect(di.profiles.has('staging')).toBe(true)
    })

    it('snapshot from profile-aware source captures @Profile-gated classes', async function () {
      const source = new CaffeineIoC({ profiles: ['ci'] })
      const di = new TestContainer(source).focus(CgCiOnlyService)
        .build()
      await di.init()

      expect(di.get(CgCiOnlyService).env).toBe('ci')
    })

    describe('assertResolvable()', function () {
      it('does not throw when all deps are wired', function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source).focus(CgOrderService)
          .build()

        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('throws ErrUnresolvableDependencies when a binding is missing after skip', function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .skip(kCgDbConn)
          .build()

        expect(() => di.assertResolvable()).toThrow(ErrUnresolvableDependencies)
      })

      it('collects all broken edges before throwing — not just the first', function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .skip(kCgDbConn)
          .skip(kCgCache)
          .build()

        let error: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          error = e as ErrUnresolvableDependencies
        }

        expect(error).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(error!.issues.length).toBeGreaterThanOrEqual(2)
      })
    })

    describe('overrideWithValue() / isolateWithValue()', function () {
      it('overrideWithValue is shorthand for override(key, b => b.toValue(value))', async function () {
        const fakeConn = new CgDbConn(new CgDbPool('fake'))
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .skipAsyncBindings()
          .overrideWithValue(kCgDbConn, fakeConn)
          .overrideWithValue(kCgCache, new CgCacheClient('r'))
          .build()
        await di.init()

        expect(di.get(CgOrderService).conn).toBe(fakeConn)
      })

      it('isolateWithValue is shorthand for isolate(key, pruneShared, b => b.toValue(value))', async function () {
        const fakeConn = new CgDbConn(new CgDbPool('fake'))
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .isolateWithValue(kCgDbConn, false, fakeConn)
          .overrideWithValue(kCgCache, new CgCacheClient('r'))
          .build()
        await di.init()

        expect(di.get(CgOrderService).conn).toBe(fakeConn)
        expect(di.has(kCgDbPool)).toBe(false)
      })
    })
  })
})
