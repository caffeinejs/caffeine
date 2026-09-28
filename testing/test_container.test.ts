import {
  $i,
  CaffeineIoC,
  Configuration,
  ErrUnresolvableDependencies,
  Inject,
  Injectable,
  Keys,
  mod,
  Profile,
  Provides,
  ProvidesAsync,
  token,
} from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { newTestContainer, TestContainer } from './test_container.js'
import { InstanceTracker } from './tracker.js'

describe('TestContainer', function () {
  const kMsg = token<string>(Symbol('kMsg'))

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

  @Injectable([$i.optional(UnrelatedService)])
  class WithOptionalDep {
    constructor(readonly dep?: UnrelatedService) {}
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

      expect(di.get(Repository)).toBeInstanceOf(Repository)
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

      expect(di.get(WithPropertyInjection).repo).toBeInstanceOf(Repository)
    })

    it('resolves root with optional dep present', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.get(WithOptionalDep)).toBeInstanceOf(WithOptionalDep)
    })
  })

  describe('empty constructor', function () {
    it('registers decorated types without a source container', async function () {
      const di = new TestContainer().build()
      await di.init()

      expect(di.get(Repository)).toBeInstanceOf(Repository)
    })

    it('newTestContainer() with no arguments matches the empty constructor', async function () {
      const di = newTestContainer().build()
      await di.init()

      expect(di.get(Repository)).toBeInstanceOf(Repository)
    })

    it('modules() still accumulate and run at init', async function () {
      const kClock = token<{ now: () => number }>(Symbol('kClock'))
      const clock = { now: () => 0 }
      const di = new TestContainer()
        .modules(c => {
          c.bind(kClock, t => t.toValue(clock))
        })
        .build()
      await di.init()

      expect(di.get(kClock)).toBe(clock)
      expect(di.get(Repository)).toBeInstanceOf(Repository)
    })
  })

  describe('override()', function () {
    it('replaces a dep with the given value', async function () {
      const mockRepo = { isMock: true } as unknown as Repository
      const source = new CaffeineIoC()
      const di = new TestContainer(source).override(Repository, b => b.toValue(mockRepo)).build()
      await di.init()
      const ctrl = di.get(Controller)

      expect(ctrl.repository).toBe(mockRepo)
    })

    it('allows overriding a named key', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).override(kMsg, b => b.toValue('overridden')).build()
      await di.init()
      const ctrl = di.get(Controller)

      expect(ctrl.message).toBe('overridden')
    })
  })

  describe('isolate()', function () {
    it('isolated key resolves to the provided value', async function () {
      const mockRepo = {} as RepositoryWithExclusive
      const source = new CaffeineIoC()
      const di = new TestContainer(source).isolate(RepositoryWithExclusive, false, b => b.toValue(mockRepo)).build()
      await di.init()

      expect(di.get(RepositoryWithExclusive)).toBe(mockRepo)
    })

    it('exclusive sub-deps of isolated key are pruned', async function () {
      const mockRepo = {} as RepositoryWithExclusive
      const source = new CaffeineIoC()
      const di = new TestContainer(source).isolate(RepositoryWithExclusive, false, b => b.toValue(mockRepo)).build()

      expect(di.has(ExclusiveDep)).toBe(false)
    })

    it('shared dep of isolated key is NOT pruned', async function () {
      const mockRepo = {} as RepositoryWithShared
      const source = new CaffeineIoC()
      const di = new TestContainer(source).isolate(RepositoryWithShared, false, b => b.toValue(mockRepo)).build()
      await di.compile()

      expect(di.has(ControllerWithShared)).toBe(true)
      expect(di.has(SharedDep)).toBe(true)
    })

    it('pruneShared: true removes shared dep regardless', async function () {
      const mockRepo = {} as RepositoryWithShared
      const source = new CaffeineIoC()
      const di = new TestContainer(source).isolate(RepositoryWithShared, true, b => b.toValue(mockRepo)).build()

      expect(di.has(SharedDep)).toBe(false)
    })
  })

  describe('skipAsyncBindings() / skip()', function () {
    const kConn = token<string>(Symbol('kConn'))

    @Configuration()
    class InfraConfig {
      @ProvidesAsync(kConn)
      async connection(): Promise<string> {
        return 'live-connection'
      }
    }

    @Injectable([kConn])
    class ServiceWithAsyncDep {
      constructor(readonly conn: string) {}
    }

    // Focused on the fixtures under test, so the container compiles without every other decorated fixture here.
    it('skipAsyncBindings() with no args strips all async bindings', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(InfraConfig, kConn).skipAsyncBindings().build()
      await di.compile()

      expect(di.has(InfraConfig)).toBe(true)
      expect(di.has(kConn)).toBe(false)
    })

    it('skipAsyncBindings(key) preserves the listed async binding', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(kConn).skipAsyncBindings(kConn).build()
      await di.compile()

      expect(di.has(kConn)).toBe(true)
    })

    it('skip(key) strips an async binding', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Repository, kConn).skip(kConn).build()
      await di.compile()

      expect(di.has(kConn)).toBe(false)
      expect(di.has(Repository)).toBe(true)
    })

    it('skip(key) strips a non-async binding', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Repository, kConn).skip(Repository).build()
      await di.compile()

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

    it('isolate key is exempt from skipAsyncBindings filter', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(kConn)
        .skipAsyncBindings()
        .isolate(kConn, false, b => b.toValue('mock-connection'))
        .build()
      await di.compile()

      expect(di.has(kConn)).toBe(true)
    })

    it('chained calls accumulate exceptions', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(kConn).skipAsyncBindings().skipAsyncBindings(kConn).build()
      await di.compile()

      expect(di.has(kConn)).toBe(true)
    })
  })

  describe('focus()', function () {
    it('keeps root and its transitive deps', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller).build()
      await di.compile()

      expect(di.has(Controller)).toBe(true)
      expect(di.has(Repository)).toBe(true)
    })

    it('drops bindings not in the dep tree', function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller).build()

      expect(di.has(UnrelatedService)).toBe(false)
    })

    it('multi-root keeps union of both trees', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Controller, UnrelatedService).build()
      await di.compile()

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

      expect(di.ready).toBe(false)
    })

    it('can be initialized manually', async function () {
      const source = new CaffeineIoC()
      const di = new TestContainer(source).build()
      await di.init()

      expect(di.ready).toBe(true)
      expect(di.get(Repository)).toBeInstanceOf(Repository)
    })
  })

  // Undecorated, so the containers built by the other tests do not pick up a consumer that needs values.
  describe('values', function () {
    class Settings {
      constructor(readonly host: string) {}
    }

    function sourceWith(values: { host: string }): CaffeineIoC {
      const source = new CaffeineIoC({ decorators: false })
      source.bindConfig(values)
      source.bind(Settings, t => t.toClass(Settings, [$i.config<{ host: string }>(c => c.host)]))
      return source
    }

    it('keeps the values of the source container, so $i.config resolves', async function () {
      const source = sourceWith({ host: 'db.local' })
      await source.init()

      const di = newTestContainer(source).build()
      await di.init()

      expect(di.get(Settings).host).toBe('db.local')
    })

    it('lets a test replace the values on the container it builds', async function () {
      const di = newTestContainer(sourceWith({ host: 'db.local' })).build()
      di.bindConfig({ host: 'test.local' })
      await di.init()

      expect(di.get(Settings).host).toBe('test.local')
    })
  })

  // A test container is lazy by default; these build eagerly so that init() instantiates what they track.
  describe('TestPostProcessor', function () {
    it('records instances created during init()', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).lazy(false).build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Repository)).toBe(true)
      expect(tracker.wasInstantiated(Controller)).toBe(true)
    })

    it('instancesOf() returns the singleton instance', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).lazy(false).build()
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
      const di = new TestContainer(source).focus(Repository).build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Controller)).toBe(false)
      expect(tracker.wasInstantiated(UnrelatedService)).toBe(false)
    })

    it('confirms focus() trimmed bindings were not instantiated', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).focus(Repository).lazy(false).build()
      di.postProcessors.add(tracker)
      await di.init()

      expect(tracker.wasInstantiated(Repository)).toBe(true)
      expect(tracker.wasInstantiated(UnrelatedService)).toBe(false)
      expect(tracker.wasInstantiated(Controller)).toBe(false)
    })

    it('reset() clears all recorded events', async function () {
      const tracker = new InstanceTracker()
      const source = new CaffeineIoC()
      const di = new TestContainer(source).lazy(false).build()
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
      const di = new TestContainer(source).focus(Controller).lazy(false).build()
      di.postProcessors.add(tracker)
      await di.init()

      const keys = tracker.events().map(e => e.key)
      expect(keys.indexOf(Repository)).toBeLessThan(keys.indexOf(Controller))
    })
  })

  describe('complex async graphs', function () {
    class CgDbPool {
      constructor(readonly connStr: string) {}
    }
    class CgDbConn {
      constructor(readonly pool: CgDbPool) {}
    }
    class CgCacheClient {
      constructor(readonly url: string) {}
    }

    const kCgConnStr = token<string>(Symbol('kCgConnStr'))
    const kCgDbPool = token<CgDbPool>(Symbol('kCgDbPool'))
    const kCgDbConn = token<CgDbConn>(Symbol('kCgDbConn'))
    const kCgRedisURL = token<string>(Symbol('kCgRedisURL'))
    const kCgCache = token<CgCacheClient>(Symbol('kCgCache'))

    @Configuration()
    class CgInfraConfig {
      @Provides(kCgConnStr)
      connStr(): string {
        return 'postgres://test'
      }

      @ProvidesAsync(kCgDbPool, [kCgConnStr])
      async dbPool(cs: string): Promise<CgDbPool> {
        return new CgDbPool(cs)
      }

      @ProvidesAsync(kCgDbConn, [kCgDbPool])
      async dbConn(pool: CgDbPool): Promise<CgDbConn> {
        return new CgDbConn(pool)
      }

      @Provides(kCgRedisURL)
      redisURL(): string {
        return 'redis://test'
      }

      @ProvidesAsync(kCgCache, [kCgRedisURL])
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
      const di = new TestContainer(source).focus(CgOrderService).build()
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
      const di = new TestContainer(source).focus(CgOrderService).build()
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

    // Pruning shared dependencies takes CgInfraConfig too, so what else it provides has to be replaced or skipped.
    it('isolate(kCgDbConn, true) prunes the whole db chain, the shared CgInfraConfig included', async function () {
      const fakeConn = new CgDbConn(new CgDbPool('fake'))
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .isolate(kCgDbConn, true, b => b.toValue(fakeConn))
        .overrideWithMock(kCgCache, new CgCacheClient('fake'))
        .skip(kCgRedisURL)
        .build()
      await di.init()

      expect(di.has(kCgDbPool)).toBe(false)
      expect(di.has(kCgConnStr)).toBe(false)
      expect(di.has(CgInfraConfig)).toBe(false)
      expect(di.get(CgOrderService).conn).toBe(fakeConn)
    })

    it('isolate(kCgDbConn, false) prunes exclusive db deps, preserves CgInfraConfig shared by cache', async function () {
      const fakeConn = new CgDbConn(new CgDbPool('fake'))
      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .isolate(kCgDbConn, false, b => b.toValue(fakeConn))
        .build()
      await di.compile()

      expect(di.has(kCgDbPool)).toBe(false)
      expect(di.has(kCgConnStr)).toBe(false)
      expect(di.has(CgInfraConfig)).toBe(true)
      expect(di.has(kCgCache)).toBe(true)
    })

    it('modules() registers a test-local binding not in the source', async function () {
      const kTestClock = token<{ now: () => number }>(Symbol('kTestClock'))
      const fakeClock = { now: () => 0 }

      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .modules(c => {
          c.bind(kTestClock, t => t.toValue(fakeClock))
        })
        .build()
      await di.init()

      expect(di.get(kTestClock)).toBe(fakeClock)
    })

    // The filters reach every binding, including the ones a test-local module adds.
    it('focus() drops a test-local module binding nothing in the focused graph depends on', async function () {
      const kTestClock = token<{ now: () => number }>(Symbol('kTestClock-unreached'))

      const source = new CaffeineIoC()
      const di = new TestContainer(source)
        .focus(CgOrderService)
        .modules(c => {
          c.bind(kTestClock, t => t.toValue({ now: () => 0 }))
        })
        .build()
      await di.compile()

      expect(di.has(kTestClock)).toBe(false)
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
      const di = new TestContainer(source).focus(CgCiOnlyService).build()
      await di.init()

      expect(di.get(CgCiOnlyService).env).toBe('ci')
    })

    describe('assertResolvable()', function () {
      it('does not throw when all deps are wired', async function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source).focus(CgOrderService).build()

        await expect(di.assertResolvable()).resolves.toBeUndefined()
      })

      it('throws ErrUnresolvableDependencies when a binding is missing after skip', async function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source).focus(CgOrderService).skip(kCgDbConn).build()

        await expect(di.assertResolvable()).rejects.toThrow(ErrUnresolvableDependencies)
      })

      it('collects all broken edges before throwing — not just the first', async function () {
        const source = new CaffeineIoC()
        const di = new TestContainer(source).focus(CgOrderService).skip(kCgDbConn).skip(kCgCache).build()

        let error: ErrUnresolvableDependencies | undefined
        try {
          await di.assertResolvable()
        } catch (e) {
          error = e as ErrUnresolvableDependencies
        }

        expect(error).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(error!.issues.length).toBeGreaterThanOrEqual(2)
      })
    })

    describe('overrideWithMock() / isolateWithMock()', function () {
      it('overrideWithMock is shorthand for override(key, b => b.toValue(mock))', async function () {
        const fakeConn = new CgDbConn(new CgDbPool('fake'))
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .skipAsyncBindings()
          .overrideWithMock(kCgDbConn, fakeConn)
          .overrideWithMock(kCgCache, new CgCacheClient('r'))
          .build()
        await di.init()

        expect(di.get(CgOrderService).conn).toBe(fakeConn)
      })

      it('overrideWithMock accepts a duck-typed object without a type assertion', async function () {
        const fake = { isMock: true }
        const source = new CaffeineIoC()
        const di = new TestContainer(source).overrideWithMock(Repository, fake).build()
        await di.init()

        expect(di.get(Repository)).toBe(fake)
      })

      it('isolateWithMock is shorthand for isolate(key, pruneShared, b => b.toValue(mock))', async function () {
        const fakeConn = new CgDbConn(new CgDbPool('fake'))
        const source = new CaffeineIoC()
        const di = new TestContainer(source)
          .focus(CgOrderService)
          .isolateWithMock(kCgDbConn, false, fakeConn)
          .overrideWithMock(kCgCache, new CgCacheClient('r'))
          .build()
        await di.init()

        expect(di.get(CgOrderService).conn).toBe(fakeConn)
        expect(di.has(kCgDbPool)).toBe(false)
      })
    })
  })

  // The filters and replacements run once every binding is registered, so they reach a binding however it was made:
  // decorated, bound by hand or bound by one of the source's modules.
  describe('every kind of binding', function () {
    const kModuleDep = token<string>(Symbol('kModuleDep'))
    const kHandDep = token<string>(Symbol('kHandDep'))

    @Injectable()
    @Profile('tc-reach')
    class DecoratedDep {
      readonly kind: string = 'real'
    }

    @Injectable([kModuleDep, kHandDep, DecoratedDep])
    @Profile('tc-reach')
    class ReachRoot {
      constructor(
        readonly moduleDep: string,
        readonly handDep: string,
        readonly decorated: DecoratedDep,
      ) {}
    }

    function source(): CaffeineIoC {
      const di = new CaffeineIoC({
        profiles: ['tc-reach'],
        modules: [mod('tc-reach-infra', c => c.bind(kModuleDep, t => t.toValue('from-module')))],
      })
      di.bind(kHandDep, t => t.toValue('by-hand'))
      return di
    }

    it("carries the source's modules into the test container", async function () {
      const di = new TestContainer(source()).focus(ReachRoot).build()
      await di.init()

      expect(di.get(ReachRoot).moduleDep).toBe('from-module')
    })

    it('overrides a module binding, a binding made by hand and a decorated binding', async function () {
      const di = new TestContainer(source())
        .focus(ReachRoot)
        .overrideWithMock(kModuleDep, 'mock-module')
        .overrideWithMock(kHandDep, 'mock-hand')
        .overrideWithMock(DecoratedDep, { kind: 'mock' })
        .build()
      await di.init()

      const root = di.get(ReachRoot)
      expect(root.moduleDep).toBe('mock-module')
      expect(root.handDep).toBe('mock-hand')
      expect(root.decorated.kind).toBe('mock')
    })

    it('skips a module binding and a decorated binding', async function () {
      const di = new TestContainer(source()).focus(ReachRoot).skip(kModuleDep, DecoratedDep).build()

      await expect(di.assertResolvable()).rejects.toThrow(ErrUnresolvableDependencies)
      expect(di.has(kModuleDep)).toBe(false)
      expect(di.has(DecoratedDep)).toBe(false)
      expect(di.has(kHandDep)).toBe(true)
    })

    it('focuses away a module binding and a decorated binding nothing depends on', async function () {
      const di = new TestContainer(source()).focus(DecoratedDep).build()
      await di.compile()

      expect(di.has(DecoratedDep)).toBe(true)
      expect(di.has(kModuleDep)).toBe(false)
      expect(di.has(ReachRoot)).toBe(false)
    })

    it('isolates a decorated binding, pruning what only it needed', async function () {
      const di = new TestContainer(source())
        .focus(ReachRoot)
        .isolateWithMock(ReachRoot, false, { moduleDep: '', handDep: '', decorated: { kind: '' } })
        .build()
      await di.compile()

      expect(di.has(kModuleDep)).toBe(false)
      expect(di.has(kHandDep)).toBe(false)
      expect(di.has(DecoratedDep)).toBe(false)
    })
  })

  // `internal()` only marks a binding for tools: every filter reaches a marked binding as it reaches any other.
  describe('a binding marked internal', function () {
    const kLeaf = token<string>(Symbol('tc-internal-leaf'))
    const kMarked = token<string>(Symbol('tc-internal-marked'))
    const kRoot = token<string>(Symbol('tc-internal-root'))

    function source(): CaffeineIoC {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kLeaf, t => t.toValue('leaf'))
      di.bind(kMarked, t => t.toFunction((leaf: string) => `marked:${leaf}`, [kLeaf]).internal())
      di.bind(kRoot, t => t.toFunction((marked: string) => `root:${marked}`, [kMarked]))
      return di
    }

    it('keeps what a focused root reaches through it', async function () {
      const di = new TestContainer(source()).focus(kRoot).build()
      await di.init()

      expect(di.get(kRoot)).toBe('root:marked:leaf')
    })

    it("is dropped when no focused root reaches it, as the container's own bindings are", async function () {
      const di = new TestContainer(source()).focus(kLeaf).build()
      await di.compile()

      expect(di.has(kMarked)).toBe(false)
      expect(di.has(Keys.kRefresher)).toBe(false)
    })

    it('is skipped', async function () {
      const di = new TestContainer(source()).skip(kMarked).build()

      await expect(di.assertResolvable()).rejects.toThrow(ErrUnresolvableDependencies)
      expect(di.has(kMarked)).toBe(false)
    })

    it('is pruned with the isolated binding that alone needs it', async function () {
      const di = new TestContainer(source()).isolateWithMock(kRoot, false, 'mock').build()
      await di.compile()

      expect(di.has(kMarked)).toBe(false)
      expect(di.has(kLeaf)).toBe(false)
    })
  })

  describe('source profiles', function () {
    @Injectable()
    @Profile('tc-test-only')
    class TestOnlyService {}

    @Injectable()
    @Profile('tc-prod-only')
    class ProdOnlyService {}

    it("activates the source's profiles by default", async function () {
      const di = new TestContainer(new CaffeineIoC({ profiles: ['tc-prod-only'] }))
        .focus(ProdOnlyService, TestOnlyService)
        .build()
      await di.compile()

      expect(di.has(ProdOnlyService)).toBe(true)
      expect(di.has(TestOnlyService)).toBe(false)
    })

    it('replaces them with the profiles it is given, registering a class the source left out', async function () {
      const di = new TestContainer(new CaffeineIoC({ profiles: ['tc-prod-only'] }))
        .profiles('tc-test-only')
        .focus(ProdOnlyService, TestOnlyService)
        .build()
      await di.compile()

      expect(di.has(TestOnlyService)).toBe(true)
      expect(di.has(ProdOnlyService)).toBe(false)
    })
  })

  describe('built from scratch', function () {
    // The empty container registers the decorated bindings once: a second registration would be a duplicate.
    it('registers the decorated bindings once', async function () {
      const di = new TestContainer().focus(Repository).build()

      await expect(di.init()).resolves.toBeUndefined()
      expect(di.getBindings(Repository)).toHaveLength(1)
    })
  })
})
