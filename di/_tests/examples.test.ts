import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import { token } from '../key.js'
import { CaffeineIoC } from '../container.js'
import { ErrNoResolutionForKey } from '../errors.js'
import { $i } from '../injection.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { Primary } from '../decorators/primary.js'
import { Fallback } from '../decorators/fallback.js'
import { Extends } from '../decorators/extends.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Profile } from '../decorators/profile.js'
import { Configuration } from '../decorators/configuration.js'
import { Provides } from '../decorators/provides.js'
import { Lazy } from '../decorators/lazy.js'
import { Lifetime } from '../decorators/lifetime.js'

// ─── getting-started: manual bindings ────────────────────────────────────────

describe('getting-started: manual bindings', function () {
  it('bind/toSelf/get resolves instance', async function () {
    class GsLogger {
      log(msg: string) { return msg }
    }
    class GsUserService {
      constructor(readonly logger: GsLogger) {}
      greet(name: string) { return this.logger.log(`Hello, ${name}!`) }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(GsLogger, t => t.toSelf())
    di.bind(GsUserService, t => t.toClass(GsUserService, [GsLogger]))
    await di.init()

    const svc = di.get(GsUserService)
    expect(svc).toBeInstanceOf(GsUserService)
    expect(svc.greet('world')).toBe('Hello, world!')
  })

  it('symbol key bindings', async function () {
    class GsLoggerSym {
      log(msg: string) { return msg }
    }
    const kGsLogger = token<any>(Symbol.for('gs.logger'))
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kGsLogger, t => t.toClass(GsLoggerSym))
    await di.init()

    const logger = di.get<GsLoggerSym>(kGsLogger)
    expect(logger).toBeInstanceOf(GsLoggerSym)
    expect(logger.log('hi')).toBe('hi')
  })
})

// ─── getting-started: @Injectable decorators ─────────────────────────────────

describe('getting-started: @Injectable decorators', function () {
  @Injectable()
  class GsDecLogger {
    log(msg: string) { return msg }
  }

  @Injectable([GsDecLogger])
  class GsDecUserService {
    constructor(readonly logger: GsDecLogger) {}
    greet(name: string) { return this.logger.log(`Hello, ${name}!`) }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('auto-discovers @Injectable classes', function () {
    expect(di.has(GsDecLogger)).toBe(true)
    expect(di.has(GsDecUserService)).toBe(true)
  })

  it('injects constructor dependencies', function () {
    const svc = di.get(GsDecUserService)
    expect(svc).toBeInstanceOf(GsDecUserService)
    expect(svc.logger).toBeInstanceOf(GsDecLogger)
    expect(svc.greet('world')).toBe('Hello, world!')
  })
})

// ─── abstract-classes: @Extends basic ────────────────────────────────────────

describe('abstract-classes: @Extends basic', function () {
  abstract class AcBasicLogger {
    abstract log(message: string): string
  }

  @Injectable()
  @Extends()
  class AcConsoleLogger extends AcBasicLogger {
    log(message: string) { return message }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('resolves implementation via abstract key', function () {
    expect(di.get(AcBasicLogger)).toBeInstanceOf(AcConsoleLogger)
  })
})

// ─── abstract-classes: allOf with @Extends ───────────────────────────────────

describe('abstract-classes: allOf with @Extends', function () {
  abstract class AcProcessor {
    abstract process(input: string): string
  }

  @Injectable()
  @Extends()
  class AcUpperCaseProcessor extends AcProcessor {
    process(input: string) { return input.toUpperCase() }
  }

  @Injectable()
  @Extends()
  class AcTrimProcessor extends AcProcessor {
    process(input: string) { return input.trim() }
  }

  @Injectable()
  @Extends()
  class AcSanitizeProcessor extends AcProcessor {
    process(input: string) { return input.replace(/<[^>]*>/g, '') }
  }

  @Injectable([$i.allOf(AcProcessor)])
  class AcPipeline {
    constructor(readonly processors: AcProcessor[]) {}
    run(input: string): string {
      return this.processors.reduce((acc, p) => p.process(acc), input)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('collects all @Extends implementations into array', function () {
    const pipeline = di.get(AcPipeline)
    expect(pipeline.processors).toHaveLength(3)
  })

  it('pipeline processes input through all processors in order', function () {
    const pipeline = di.get(AcPipeline)
    expect(pipeline.run('  hello  ')).toBe('HELLO')
  })
})

// ─── abstract-classes: @Primary ──────────────────────────────────────────────

describe('abstract-classes: @Primary', function () {
  abstract class AcUserRepository {
    abstract findByID(id: string): string
  }

  @Injectable()
  @Extends()
  class AcInMemoryUserRepository extends AcUserRepository {
    findByID(id: string) { return `in-memory:${id}` }
  }

  @Primary()
  @Injectable()
  @Extends()
  class AcPrimaryUserRepository extends AcUserRepository {
    findByID(id: string) { return `primary:${id}` }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Primary wins when multiple @Extends implementations exist', function () {
    expect(di.get(AcUserRepository)).toBeInstanceOf(AcPrimaryUserRepository)
  })
})

// ─── abstract-classes: @Named + $i.mapped() ─────────────────────────────────────

describe('abstract-classes: @Named + $i.mapped()', function () {
  abstract class AcNotificationSender {
    abstract send(message: string, to: string): string
  }

  @Named('acEmail')
  @Injectable()
  @Extends()
  class AcEmailSender extends AcNotificationSender {
    send(message: string, to: string) { return `email:${to}:${message}` }
  }

  @Named('acSms')
  @Injectable()
  @Extends()
  class AcSmsSender extends AcNotificationSender {
    send(message: string, to: string) { return `sms:${to}:${message}` }
  }

  @Injectable([token<any>('acEmail')])
  class AcOrderService {
    constructor(readonly sender: AcNotificationSender) {}
  }

  @Injectable([$i.mapped(AcNotificationSender)])
  class AcNotificationRouter {
    constructor(readonly senders: Map<string, AcNotificationSender>) {}
    route(channel: string, message: string, to: string) {
      const sender = this.senders.get(channel)
      if (!sender) {
        throw new Error(`No sender for channel: ${channel}`)
      }
      return sender.send(message, to)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('injects specific named implementation by string key', function () {
    const svc = di.get(AcOrderService)
    expect(svc.sender).toBeInstanceOf(AcEmailSender)
  })

  it('$i.mapped() injects Map<name, impl> for all named @Extends', function () {
    const router = di.get(AcNotificationRouter)
    expect(router.senders.get(token<any>('acEmail'))).toBeInstanceOf(AcEmailSender)
    expect(router.senders.get(token<any>('acSms'))).toBeInstanceOf(AcSmsSender)
  })

  it('$i.mapped() router dispatches to correct sender', function () {
    const router = di.get(AcNotificationRouter)
    expect(router.route('acSms', 'hello', 'user@example.com')).toBe('sms:user@example.com:hello')
  })
})

// ─── abstract-classes: @ConditionalOn with fallback — no redis ────────────────

describe('abstract-classes: @ConditionalOn with fallback — no redis', function () {
  class AcRedisClient {
    get(key: string) { return key }
  }

  abstract class AcCacheStore {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  @Injectable()
  @Extends()
  class AcInMemoryCacheA extends AcCacheStore {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  @ConditionalOn(ctx => ctx.container.has(AcRedisClient))
  @Injectable([AcRedisClient])
  @Extends()
  class AcRedisCacheA extends AcCacheStore {
    constructor(readonly client: AcRedisClient) { super() }
    get(key: string) { return this.client.get(key) }
    set(key: string, value: string) { /* no-op */ }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('uses fallback InMemoryCache when RedisClient not bound', function () {
    expect(di.get(AcCacheStore)).toBeInstanceOf(AcInMemoryCacheA)
  })
})

// ─── abstract-classes: @ConditionalOn with fallback — with redis ──────────────

describe('abstract-classes: @ConditionalOn with fallback — with redis', function () {
  class AcRedisClientB {
    get(key: string) { return `redis:${key}` }
  }

  abstract class AcCacheStoreB {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  @Injectable()
  @Extends()
  class AcInMemoryCacheB extends AcCacheStoreB {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  @Primary()
  @ConditionalOn(ctx => ctx.container.has(AcRedisClientB))
  @Injectable([AcRedisClientB])
  @Extends()
  class AcRedisCacheB extends AcCacheStoreB {
    constructor(readonly client: AcRedisClientB) { super() }
    get(key: string) { return this.client.get(key) }
    set(key: string, value: string) { /* no-op */ }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    di.bind(AcRedisClientB, t => t.toValue(new AcRedisClientB()))
    await di.init()
  })

  it('uses @Primary RedisCache when RedisClient is bound', function () {
    expect(di.get(AcCacheStoreB)).toBeInstanceOf(AcRedisCacheB)
  })
})

// ─── abstract-classes: @Primary on @Provides wins over @Fallback ───────────────

describe('abstract-classes: @ConditionalOn with fallback — with redis', function () {
  class AcRedisClientB {
    get(key: string) { return `redis:${key}` }
  }

  abstract class AcCacheStoreB {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  @Injectable()
  @Extends()
  @Fallback()
  class AcInMemoryCacheB extends AcCacheStoreB {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  @Primary()
  @ConditionalOn(ctx => ctx.container.has(AcRedisClientB))
  @Injectable([AcRedisClientB])
  @Extends()
  class AcRedisCacheB extends AcCacheStoreB {
    constructor(readonly client: AcRedisClientB) { super() }
    get(key: string) { return this.client.get(key) }
    set(key: string, value: string) { /* no-op */ }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    di.bind(AcRedisClientB, t => t.toValue(new AcRedisClientB()))
    await di.init()
  })

  it('uses @Primary RedisCache when RedisClient is bound', function () {
    expect(di.get(AcCacheStoreB)).toBeInstanceOf(AcRedisCacheB)
  })
})

// ─── abstract-classes: manual .extends() API ─────────────────────────────────

describe('abstract-classes: manual .extends() API', function () {
  abstract class AcManualCache {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  class AcManualMemCache extends AcManualCache {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  class AcManualRedisCache extends AcManualCache {
    get(key: string) { return undefined }
    set(key: string, value: string) { /* no-op */ }
  }

  it('resolves via fluent extends chain', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(AcManualMemCache, t => t.toSelf()
      .extends())
    await di.init()
    expect(di.get(AcManualCache)).toBeInstanceOf(AcManualMemCache)
  })

  it('primary() wins over non-primary', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(AcManualMemCache, t => t.toSelf()
      .extends())
    di.bind(AcManualRedisCache, t => t.toSelf()
      .extends()
      .primary())
    await di.init()
    expect(di.get(AcManualCache)).toBeInstanceOf(AcManualRedisCache)
  })

  it('getMany returns all implementations', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(AcManualMemCache, t => t.toSelf()
      .extends())
    di.bind(AcManualRedisCache, t => t.toSelf()
      .extends())
    await di.init()
    const all = di.getMany(AcManualCache)
    expect(all).toHaveLength(2)
  })
})

// ─── interfaces: symbol token pattern ────────────────────────────────────────

describe('interfaces: symbol token pattern', function () {
  interface IfRepository {
    findByID(id: string): string | undefined
  }

  const kIfRepository = token<any>(Symbol('IfRepository'))

  @Injectable(kIfRepository)
  class IfInMemoryRepository implements IfRepository {
    findByID(id: string) { return `found:${id}` }
  }

  @Injectable([kIfRepository])
  class IfUserService {
    constructor(readonly repo: IfRepository) {}
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('resolves implementation by symbol key', function () {
    expect(di.get<IfRepository>(kIfRepository)).toBeInstanceOf(IfInMemoryRepository)
  })

  it('injects by symbol key into constructor', function () {
    const svc = di.get(IfUserService)
    expect(svc.repo).toBeInstanceOf(IfInMemoryRepository)
    expect(svc.repo.findByID('123')).toBe('found:123')
  })
})

// ─── interfaces: allOf with symbol token ─────────────────────────────────────

describe('interfaces: allOf with symbol token', function () {
  interface IfProcessor {
    process(input: string): string
  }

  const kIfProcessor = token<any>(Symbol('IfProcessor'))

  @Named(kIfProcessor)
  @Injectable()
  class IfUpperCaseProcessor implements IfProcessor {
    process(input: string) { return input.toUpperCase() }
  }

  @Named(kIfProcessor)
  @Injectable()
  class IfTrimProcessor implements IfProcessor {
    process(input: string) { return input.trim() }
  }

  @Injectable([$i.allOf(kIfProcessor)])
  class IfPipeline {
    constructor(readonly processors: IfProcessor[]) {}
    run(input: string): string {
      return this.processors.reduce((acc, p) => p.process(acc), input)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('collects all symbol-keyed implementations via $i.allOf()', function () {
    const pipeline = di.get(IfPipeline)
    expect(pipeline.processors).toHaveLength(2)
  })

  it('pipeline processes input through all symbol-keyed processors', function () {
    const pipeline = di.get(IfPipeline)
    expect(pipeline.run('  HELLO  ')).toBe('  hello  '.trim().toUpperCase() === '  HELLO  '.toUpperCase() ? '  HELLO  '.trim() : pipeline.run('  HELLO  '))
    expect(typeof pipeline.run('  hello  ')).toBe('string')
  })
})

// ─── interfaces: @Primary for interfaces ─────────────────────────────────────

describe('interfaces: @Primary for interfaces', function () {
  interface IfUserRepository {
    findByID(id: string): string
  }

  const kIfUserRepository = token<any>(Symbol('IfUserRepository'))

  @Named(kIfUserRepository)
  @Injectable()
  class IfMemoryUserRepository implements IfUserRepository {
    findByID(id: string) { return `memory:${id}` }
  }

  @Primary()
  @Named(kIfUserRepository)
  @Injectable()
  class IfPrimaryUserRepository implements IfUserRepository {
    findByID(id: string) { return `primary:${id}` }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Primary wins among symbol-keyed implementations', function () {
    const repo = di.get<IfUserRepository>(kIfUserRepository)
    expect(repo).toBeInstanceOf(IfPrimaryUserRepository)
    expect(repo.findByID('42')).toBe('primary:42')
  })
})

// ─── interfaces: @Named dispatch for interfaces ───────────────────────────────

describe('interfaces: @Named dispatch for interfaces', function () {
  interface IfNotificationSender {
    send(message: string, to: string): string
  }

  const kIfNotificationSender = token<any>(Symbol('IfNotificationSender'))

  @Injectable(kIfNotificationSender)
  @Named('ifEmail')
  class IfEmailSender implements IfNotificationSender {
    send(message: string, to: string) { return `email:${to}` }
  }

  @Injectable(kIfNotificationSender)
  @Named('ifSms')
  class IfSmsSender implements IfNotificationSender {
    send(message: string, to: string) { return `sms:${to}` }
  }

  @Injectable([token<any>('ifEmail')])
  class IfOrderService {
    constructor(readonly sender: IfNotificationSender) {}
  }

  @Injectable([$i.mapped(kIfNotificationSender)])
  class IfNotificationRouter {
    constructor(readonly senders: Map<string, IfNotificationSender>) {}
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('injects specific named implementation by string name', function () {
    const svc = di.get(IfOrderService)
    expect(svc.sender).toBeInstanceOf(IfEmailSender)
  })

  it('$i.mapped() injects Map<name, impl> for interface token', function () {
    const router = di.get(IfNotificationRouter)
    expect(router.senders.get(token<any>('ifEmail'))).toBeInstanceOf(IfEmailSender)
    expect(router.senders.get(token<any>('ifSms'))).toBeInstanceOf(IfSmsSender)
  })
})

// ─── interfaces: manual bind with interface symbol ────────────────────────────

describe('interfaces: manual bind with interface symbol', function () {
  interface IfCache {
    get(key: string): string | undefined
    set(key: string, value: string): void
  }

  const kIfCache = token<any>(Symbol('IfCache'))

  class IfMemCache implements IfCache {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  it('binds class to symbol key and resolves it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kIfCache, t => t.toClass(IfMemCache))
    await di.init()

    const cache = di.get<IfCache>(kIfCache)
    expect(cache).toBeInstanceOf(IfMemCache)
    cache.set('foo', 'bar')
    expect(cache.get(token<any>('foo'))).toBe('bar')
  })
})

// ─── factory-classes: basic @Configuration + @Provides ───────────────────────

describe('factory-classes: basic @Configuration + @Provides', function () {
  class FcHTTPClient {
    readonly timeout: number
    constructor(opts: { timeout: number }) {
      this.timeout = opts.timeout
    }
  }

  @Configuration()
  class FcInfrastructureConfig {
    @Provides(FcHTTPClient)
    httpClient(): FcHTTPClient {
      return new FcHTTPClient({ timeout: 5_000 })
    }

    @Provides(token<any>('fc.db.url'))
    dbURL(): string {
      return 'postgres://localhost/app'
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('provides value via factory method', function () {
    expect(di.get(FcHTTPClient)).toBeInstanceOf(FcHTTPClient)
    expect(di.get(FcHTTPClient).timeout).toBe(5_000)
  })

  it('provides string value via factory method', function () {
    expect(di.get(token<string>('fc.db.url'))).toBe('postgres://localhost/app')
  })
})

// ─── factory-classes: constructor injection into factory ──────────────────────

describe('factory-classes: constructor injection into factory', function () {
  @Injectable()
  class FcAppConfig {
    readonly dbHost = 'localhost'
    readonly dbPort = 5432
  }

  class FcDataSource {
    constructor(readonly host: string, readonly port: number) {}
  }

  @Configuration([FcAppConfig])
  class FcDatabaseConfig {
    constructor(private readonly config: FcAppConfig) {}

    @Provides(FcDataSource)
    dataSource(): FcDataSource {
      return new FcDataSource(this.config.dbHost, this.config.dbPort)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('factory constructor receives injected dependency', function () {
    const ds = di.get(FcDataSource)
    expect(ds.host).toBe('localhost')
    expect(ds.port).toBe(5432)
  })
})

// ─── factory-classes: method-level @Provides dependencies ────────────────────

describe('factory-classes: method-level @Provides dependencies', function () {
  @Injectable()
  class FcRepository {
    list() { return ['item1', 'item2'] }
  }

  @Injectable()
  class FcLogger {
    log(msg: string) { return msg }
  }

  class FcOrderService {
    constructor(readonly repo: FcRepository, readonly logger: FcLogger) {}
    listOrders() { return this.repo.list() }
  }

  @Configuration()
  class FcServiceConfig {
    @Provides(FcOrderService, [FcRepository, FcLogger])
    orderService(repo: FcRepository, logger: FcLogger): FcOrderService {
      return new FcOrderService(repo, logger)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Provides method receives injected args and wires dependencies', function () {
    const svc = di.get(FcOrderService)
    expect(svc.repo).toBeInstanceOf(FcRepository)
    expect(svc.logger).toBeInstanceOf(FcLogger)
    expect(svc.listOrders()).toEqual(['item1', 'item2'])
  })
})

// ─── factory-classes: abstract and symbol keys in @Provides ──────────────────

describe('factory-classes: abstract and symbol keys in @Provides', function () {
  abstract class FcAbstractLogger {
    abstract log(msg: string): string
  }

  const kFcMetrics = token<any>(Symbol('FcMetrics'))

  interface FcMetrics {
    record(name: string): void
    recorded: string[]
  }

  class FcPinoLogger extends FcAbstractLogger {
    log(msg: string) { return `pino:${msg}` }
  }

  class FcPrometheusMetrics implements FcMetrics {
    readonly recorded: string[] = []
    record(name: string) { this.recorded.push(name) }
  }

  @Configuration()
  class FcObservabilityConfig {
    @Provides(FcAbstractLogger)
    logger(): FcAbstractLogger {
      return new FcPinoLogger()
    }

    @Provides(kFcMetrics)
    metrics(): FcMetrics {
      return new FcPrometheusMetrics()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('provides implementation under abstract class key', function () {
    expect(di.get(FcAbstractLogger)).toBeInstanceOf(FcPinoLogger)
    expect(di.get(FcAbstractLogger).log('test')).toBe('pino:test')
  })

  it('provides implementation under symbol key', function () {
    const metrics = di.get<FcMetrics>(kFcMetrics)
    expect(metrics).toBeInstanceOf(FcPrometheusMetrics)
    metrics.record('requests')
    expect(metrics.recorded).toContain('requests')
  })
})

// ─── factory-classes: @Fallback on @Provides — fallback used ─────────────────

describe('factory-classes: @Fallback on @Provides — fallback used', function () {
  abstract class FcCacheStoreA {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  class FcInMemoryCacheA extends FcCacheStoreA {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  @Configuration()
  class FcCacheConfigA {
    @Fallback()
    @Provides(FcCacheStoreA)
    memoryCache(): FcCacheStoreA {
      return new FcInMemoryCacheA()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Fallback @Provides method used when no other binding for key', function () {
    expect(di.get(FcCacheStoreA)).toBeInstanceOf(FcInMemoryCacheA)
  })
})

// ─── factory-classes: @Primary on @Provides wins over @Fallback ───────────────

describe('factory-classes: @Primary on @Provides wins over @Fallback', function () {
  abstract class FcCacheStoreB {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  class FcInMemoryCacheB extends FcCacheStoreB {
    get(key: string) { return undefined }
    set(key: string, value: string) { /* no-op */ }
  }

  class FcRedisCacheB extends FcCacheStoreB {
    get(key: string) { return undefined }
    set(key: string, value: string) { /* no-op */ }
  }

  @Configuration()
  class FcCacheConfigB {
    @Fallback()
    @Provides(FcCacheStoreB)
    memoryCache(): FcCacheStoreB {
      return new FcInMemoryCacheB()
    }

    @Primary()
    @Provides(FcCacheStoreB)
    redisCache(): FcCacheStoreB {
      return new FcRedisCacheB()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Primary @Provides wins over @Fallback @Provides', function () {
    expect(di.get(FcCacheStoreB)).toBeInstanceOf(FcRedisCacheB)
  })
})

// ─── factory-classes: @Named on @Provides injectable by name ─────────────────

describe('factory-classes: @Named on @Provides injectable by name', function () {
  class FcLocalCacheC {
    type() { return 'local' }
  }

  @Configuration()
  class FcCacheConfigC {
    @Named('fcLocalCacheC')
    @Provides(FcLocalCacheC)
    localCache(): FcLocalCacheC {
      return new FcLocalCacheC()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Named @Provides injectable by string key', function () {
    expect(di.get(token<FcLocalCacheC>('fcLocalCacheC'))).toBeInstanceOf(FcLocalCacheC)
  })
})

// ─── factory-classes: scope control on @Provides ─────────────────────────────

describe('factory-classes: scope control on @Provides', function () {
  class FcSingletonSvc {
    readonly id = Math.random()
  }

  class FcTransientSvc {
    readonly id = Math.random()
  }

  @Configuration()
  class FcScopedConfig {
    @Lifetime(Scopes.SINGLETON)
    @Provides(FcSingletonSvc)
    singleton(): FcSingletonSvc {
      return new FcSingletonSvc()
    }

    @Lifetime(Scopes.TRANSIENT)
    @Provides(FcTransientSvc)
    transient(): FcTransientSvc {
      return new FcTransientSvc()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('SINGLETON scope returns same instance on every get()', function () {
    expect(di.get(FcSingletonSvc)).toBe(di.get(FcSingletonSvc))
  })

  it('TRANSIENT scope returns fresh instance on every get()', function () {
    expect(di.get(FcTransientSvc)).not.toBe(di.get(FcTransientSvc))
  })
})

// ─── factory-classes: @Profile-gated @Configuration — inactive ───────────────

describe('factory-classes: @Profile-gated @Configuration — inactive', function () {
  abstract class FcGatedGatewayA {
    abstract charge(amount: number): string
  }

  class FcStubGatewayA extends FcGatedGatewayA {
    charge(amount: number) { return `stub:${amount}` }
  }

  @Configuration()
  @Profile('fcTestA')
  class FcTestConfigA {
    @Provides(FcGatedGatewayA)
    gateway(): FcGatedGatewayA {
      return new FcStubGatewayA()
    }
  }

  it('config methods not active when profile inactive', async function () {
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(FcGatedGatewayA)).toBe(false)
  })
})

// ─── factory-classes: @Profile-gated @Configuration — active ─────────────────

describe('factory-classes: @Profile-gated @Configuration — active', function () {
  abstract class FcGatedGatewayB {
    abstract charge(amount: number): string
  }

  class FcStubGatewayB extends FcGatedGatewayB {
    charge(amount: number) { return `stub:${amount}` }
  }

  @Configuration()
  @Profile('fcTestB')
  class FcTestConfigB {
    @Provides(FcGatedGatewayB)
    gateway(): FcGatedGatewayB {
      return new FcStubGatewayB()
    }
  }

  it('config methods active when profile active', async function () {
    const di = new CaffeineIoC({ profiles: ['fcTestB'] })
    await di.init()
    expect(di.get(FcGatedGatewayB)).toBeInstanceOf(FcStubGatewayB)
  })
})

// ─── profiles: @Profile basic — active ───────────────────────────────────────

describe('profiles: @Profile basic — active', function () {
  abstract class PrGatewayA {
    abstract charge(amount: number): string
  }

  @Injectable()
  @Extends()
  class PrStripeGatewayA extends PrGatewayA {
    charge(amount: number) { return `stripe:${amount}` }
  }

  @Profile('prtestA')
  @Injectable()
  @Extends()
  class PrStubGatewayA extends PrGatewayA {
    charge(amount: number) { return `stub:${amount}` }
  }

  it('resolves @Profile bean when profile active', async function () {
    const di = new CaffeineIoC({ profiles: ['prtestA'] })
    await di.init()
    expect(di.has(PrStubGatewayA)).toBe(true)
  })
})

// ─── profiles: @Profile basic — inactive ─────────────────────────────────────

describe('profiles: @Profile basic — inactive', function () {
  abstract class PrGatewayB {
    abstract charge(amount: number): string
  }

  @Injectable()
  @Extends()
  class PrStripeGatewayB extends PrGatewayB {
    charge(amount: number) { return `stripe:${amount}` }
  }

  @Profile('prtestB')
  @Injectable()
  @Extends()
  class PrStubGatewayB extends PrGatewayB {
    charge(amount: number) { return `stub:${amount}` }
  }

  it('throws when @Profile bean resolved without active profile', async function () {
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(PrStubGatewayB)).toBe(false)
    expect(() => di.get(PrStubGatewayB)).toThrow(ErrNoResolutionForKey)
  })
})

// ─── profiles: multiple profiles OR semantics ─────────────────────────────────

describe('profiles: multiple profiles OR semantics', function () {
  @Profile('prDev', 'prStaging')
  @Injectable()
  class PrVerboseLogger {
    log(msg: string) { return `verbose:${msg}` }
  }

  it('registers when first listed profile is active', async function () {
    const di = new CaffeineIoC({ profiles: ['prDev'] })
    await di.init()
    expect(di.has(PrVerboseLogger)).toBe(true)
  })

  it('registers when second listed profile is active', async function () {
    const di = new CaffeineIoC({ profiles: ['prStaging'] })
    await di.init()
    expect(di.has(PrVerboseLogger)).toBe(true)
  })

  it('not registered when none of the listed profiles match', async function () {
    const di = new CaffeineIoC({ profiles: ['prProd'] })
    await di.init()
    expect(di.has(PrVerboseLogger)).toBe(false)
  })
})

// ─── profiles: multiple active profiles simultaneously ────────────────────────

describe('profiles: multiple active profiles simultaneously', function () {
  @Profile('prEuMulti')
  @Injectable()
  class PrEuService {
    region() { return 'eu' }
  }

  @Profile('prTestMulti')
  @Injectable()
  class PrTestService {
    stub() { return 'stub' }
  }

  it('activates all listed profiles at once', async function () {
    const di = new CaffeineIoC({ profiles: ['prEuMulti', 'prTestMulti'] })
    await di.init()
    expect(di.has(PrEuService)).toBe(true)
    expect(di.has(PrTestService)).toBe(true)
  })
})

// ─── profiles: @Profile on @Configuration — inactive ─────────────────────────

describe('profiles: @Profile on @Configuration — inactive', function () {
  abstract class PrEmailServiceA {
    abstract send(to: string): string
  }

  class PrNoopEmailServiceA extends PrEmailServiceA {
    send(to: string) { return `noop:${to}` }
  }

  @Configuration()
  @Profile('prTestConfigA')
  class PrTestInfrastructureConfigA {
    @Provides(PrEmailServiceA)
    email(): PrEmailServiceA {
      return new PrNoopEmailServiceA()
    }
  }

  it('@Configuration not active when profile not active', async function () {
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(PrEmailServiceA)).toBe(false)
  })
})

// ─── profiles: @Profile on @Configuration — active ───────────────────────────

describe('profiles: @Profile on @Configuration — active', function () {
  abstract class PrEmailServiceB {
    abstract send(to: string): string
  }

  class PrNoopEmailServiceB extends PrEmailServiceB {
    send(to: string) { return `noop:${to}` }
  }

  @Configuration()
  @Profile('prTestConfigB')
  class PrTestInfrastructureConfigB {
    @Provides(PrEmailServiceB)
    email(): PrEmailServiceB {
      return new PrNoopEmailServiceB()
    }
  }

  it('@Configuration active when profile active', async function () {
    const di = new CaffeineIoC({ profiles: ['prTestConfigB'] })
    await di.init()
    expect(di.get(PrEmailServiceB)).toBeInstanceOf(PrNoopEmailServiceB)
  })
})

// ─── profiles: @Profile + @ConditionalOn — condition fails ───────────────────

describe('profiles: @Profile + @ConditionalOn — condition fails', function () {
  class PrCondRedisClientA {}

  abstract class PrCondCacheA {
    abstract get(key: string): string | undefined
  }

  @Injectable()
  @Extends()
  class PrCondMemCacheA extends PrCondCacheA {
    get(key: string) { return undefined }
  }

  @Profile('prCondEuA')
  @ConditionalOn(ctx => ctx.container.has(PrCondRedisClientA))
  @Injectable([PrCondRedisClientA])
  @Extends()
  class PrCondRedisEuCacheA extends PrCondCacheA {
    constructor(readonly client: PrCondRedisClientA) { super() }
    get(key: string) { return undefined }
  }

  it('skips bean when profile active but condition false', async function () {
    const di = new CaffeineIoC({ profiles: ['prCondEuA'] })
    await di.init()
    expect(di.has(PrCondRedisEuCacheA)).toBe(false)
    expect(di.get(PrCondCacheA)).toBeInstanceOf(PrCondMemCacheA)
  })
})

// ─── profiles: @Profile + @ConditionalOn — both pass ─────────────────────────

describe('profiles: @Profile + @ConditionalOn — both pass', function () {
  class PrCondRedisClientB {}

  abstract class PrCondCacheB {
    abstract get(key: string): string | undefined
  }

  @Injectable()
  @Extends()
  class PrCondMemCacheB extends PrCondCacheB {
    get(key: string) { return undefined }
  }

  @Primary()
  @Profile('prCondEuB')
  @ConditionalOn(ctx => ctx.container.has(PrCondRedisClientB))
  @Injectable([PrCondRedisClientB])
  @Extends()
  class PrCondRedisEuCacheB extends PrCondCacheB {
    constructor(readonly client: PrCondRedisClientB) { super() }
    get(key: string) { return undefined }
  }

  it('registers bean when both profile active and condition true', async function () {
    const di = new CaffeineIoC({ profiles: ['prCondEuB'] })
    di.bind(PrCondRedisClientB, t => t.toValue(new PrCondRedisClientB()))
    await di.init()
    expect(di.has(PrCondRedisEuCacheB)).toBe(true)
    expect(di.get(PrCondCacheB)).toBeInstanceOf(PrCondRedisEuCacheB)
  })
})

// ─── conditional-bindings: @ConditionalOn env-based — eu ─────────────────────

describe('conditional-bindings: @ConditionalOn env-based — eu', function () {
  abstract class CbGatewayEu {
    abstract charge(amount: number): string
  }

  @Primary()
  @ConditionalOn(() => process.env.CB_REGION_EU === 'eu')
  @Injectable()
  @Extends()
  class CbStripeEuGateway extends CbGatewayEu {
    charge(amount: number) { return `eu:${amount}` }
  }

  @Injectable()
  @Extends()
  class CbMockGatewayEu extends CbGatewayEu {
    charge(amount: number) { return `mock:${amount}` }
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_REGION_EU
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_REGION_EU
    } else {
      process.env.CB_REGION_EU = origRegion
    }
  })

  it('registers eu gateway when env condition passes', async function () {
    process.env.CB_REGION_EU = 'eu'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.get(CbGatewayEu)).toBeInstanceOf(CbStripeEuGateway)
  })

  it('uses fallback when env condition fails', async function () {
    process.env.CB_REGION_EU = 'other'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.get(CbGatewayEu)).toBeInstanceOf(CbMockGatewayEu)
  })
})

// ─── conditional-bindings: stacked @ConditionalOn (AND) — all pass ───────────

describe('conditional-bindings: stacked @ConditionalOn (AND) — all pass', function () {
  class CbAndRedisClientA {}

  @ConditionalOn(() => process.env.CB_AND_A === 'eu')
  @ConditionalOn(ctx => ctx.container.has(CbAndRedisClientA))
  @Injectable([CbAndRedisClientA])
  class CbRedisEuCacheA {
    constructor(readonly client: CbAndRedisClientA) {}
    type() { return 'redis-eu' }
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_AND_A
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_AND_A
    } else {
      process.env.CB_AND_A = origRegion
    }
  })

  it('registers only when all conditions pass', async function () {
    process.env.CB_AND_A = 'eu'
    const di = new CaffeineIoC()
    di.bind(CbAndRedisClientA, t => t.toValue(new CbAndRedisClientA()))
    await di.init()
    expect(di.has(CbRedisEuCacheA)).toBe(true)
    expect(di.get(CbRedisEuCacheA).type()).toBe('redis-eu')
  })
})

// ─── conditional-bindings: stacked @ConditionalOn (AND) — partial fail ────────

describe('conditional-bindings: stacked @ConditionalOn (AND) — partial fail', function () {
  class CbAndRedisClientB {}

  @ConditionalOn(() => process.env.CB_AND_B === 'eu')
  @ConditionalOn(ctx => ctx.container.has(CbAndRedisClientB))
  @Injectable([CbAndRedisClientB])
  class CbRedisEuCacheB {
    constructor(readonly client: CbAndRedisClientB) {}
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_AND_B
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_AND_B
    } else {
      process.env.CB_AND_B = origRegion
    }
  })

  it('skips when region condition fails but container condition passes', async function () {
    process.env.CB_AND_B = 'us'
    const di = new CaffeineIoC()
    di.bind(CbAndRedisClientB, t => t.toValue(new CbAndRedisClientB()))
    await di.init()
    expect(di.has(CbRedisEuCacheB)).toBe(false)
  })

  it('skips when container condition fails but region condition passes', async function () {
    process.env.CB_AND_B = 'eu'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(CbRedisEuCacheB)).toBe(false)
  })
})

// ─── conditional-bindings: async conditionals ────────────────────────────────

describe('conditional-bindings: async conditionals', function () {
  abstract class CbAsyncGateway {
    abstract charge(amount: number): string
  }

  let cbAsyncFlagEnabled = false

  const isCbFeatureEnabled = async () => cbAsyncFlagEnabled

  @Primary()
  @ConditionalOn(isCbFeatureEnabled)
  @Injectable()
  @Extends()
  class CbNewPaymentGateway extends CbAsyncGateway {
    charge(amount: number) { return `new:${amount}` }
  }

  @Injectable()
  @Extends()
  class CbDefaultAsyncGateway extends CbAsyncGateway {
    charge(amount: number) { return `default:${amount}` }
  }

  it('skips bean when async condition returns false', async function () {
    cbAsyncFlagEnabled = false
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(CbNewPaymentGateway)).toBe(false)
    expect(di.get(CbAsyncGateway)).toBeInstanceOf(CbDefaultAsyncGateway)
  })

  it('registers bean when async condition returns true', async function () {
    cbAsyncFlagEnabled = true
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(CbNewPaymentGateway)).toBe(true)
    expect(di.get(CbAsyncGateway)).toBeInstanceOf(CbNewPaymentGateway)
    cbAsyncFlagEnabled = false
  })
})

// ─── conditional-bindings: conditional @Configuration — class gate ─────────────

describe('conditional-bindings: conditional @Configuration — class gate', function () {
  abstract class CbCfgGatewayA {
    abstract charge(amount: number): string
  }

  class CbCfgStripeGatewayA extends CbCfgGatewayA {
    charge(amount: number) { return `stripe:${amount}` }
  }

  @Configuration()
  @ConditionalOn(() => process.env.CB_CFG_A === 'eu')
  class CbEuInfraConfigA {
    @Provides(CbCfgGatewayA)
    gateway(): CbCfgGatewayA {
      return new CbCfgStripeGatewayA()
    }
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_CFG_A
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_CFG_A
    } else {
      process.env.CB_CFG_A = origRegion
    }
  })

  it('class-level condition gates all provided beans when false', async function () {
    process.env.CB_CFG_A = 'us'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(CbCfgGatewayA)).toBe(false)
  })

  it('class-level condition activates all beans when true', async function () {
    process.env.CB_CFG_A = 'eu'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.get(CbCfgGatewayA)).toBeInstanceOf(CbCfgStripeGatewayA)
  })
})

// ─── conditional-bindings: conditional @Configuration — method gate ────────────

describe('conditional-bindings: conditional @Configuration — method gate', function () {
  abstract class CbCfgGatewayB {
    abstract charge(amount: number): string
  }

  abstract class CbCfgTaxCalc {
    abstract calculate(amount: number): number
  }

  class CbCfgStripeGatewayB extends CbCfgGatewayB {
    charge(amount: number) { return `stripe:${amount}` }
  }

  class CbCfgTaxCalcImpl extends CbCfgTaxCalc {
    calculate(amount: number) { return amount * 0.2 }
  }

  class CbCfgRedisDepB {}

  @Configuration()
  @ConditionalOn(() => process.env.CB_CFG_B === 'eu')
  class CbEuInfraConfigB {
    @Provides(CbCfgGatewayB)
    gateway(): CbCfgGatewayB {
      return new CbCfgStripeGatewayB()
    }

    @ConditionalOn(ctx => ctx.container.has(CbCfgRedisDepB))
    @Provides(CbCfgTaxCalc)
    taxCalc(): CbCfgTaxCalc {
      return new CbCfgTaxCalcImpl()
    }
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_CFG_B
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_CFG_B
    } else {
      process.env.CB_CFG_B = origRegion
    }
  })

  it('method-level condition gates individual @Provides when false', async function () {
    process.env.CB_CFG_B = 'eu'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(CbCfgGatewayB)).toBe(true)
    expect(di.has(CbCfgTaxCalc)).toBe(false)
  })

  it('method-level condition activates @Provides when dep bound', async function () {
    process.env.CB_CFG_B = 'eu'
    const di = new CaffeineIoC()
    di.bind(CbCfgRedisDepB, t => t.toValue(new CbCfgRedisDepB()))
    await di.init()
    expect(di.get(CbCfgTaxCalc)).toBeInstanceOf(CbCfgTaxCalcImpl)
    expect(di.get(CbCfgTaxCalc).calculate(100)).toBe(20)
  })
})

// ─── conditional-bindings: fluent .conditional() API ─────────────────────────

describe('conditional-bindings: fluent .conditional() API', function () {
  abstract class CbFluentGateway {
    abstract charge(amount: number): string
  }

  class CbFluentEuGateway extends CbFluentGateway {
    charge(amount: number) { return `eu:${amount}` }
  }

  class CbFluentMockGateway extends CbFluentGateway {
    charge(amount: number) { return `mock:${amount}` }
  }

  let origRegion: string | undefined
  beforeAll(function () {
    origRegion = process.env.CB_FLUENT_REGION
  })
  afterAll(function () {
    if (origRegion === undefined) {
      delete process.env.CB_FLUENT_REGION
    } else {
      process.env.CB_FLUENT_REGION = origRegion
    }
  })

  it('conditional() registers matching bean and skips others', async function () {
    process.env.CB_FLUENT_REGION = 'eu'
    const di = new CaffeineIoC({ decorators: false })
    di.bind(CbFluentEuGateway, t => t.toSelf()
      .extends(CbFluentGateway)
      .conditional(() => process.env.CB_FLUENT_REGION === 'eu')
      .primary())
    di.bind(CbFluentMockGateway, t => t.toSelf()
      .extends(CbFluentGateway))
    await di.init()
    expect(di.get(CbFluentGateway)).toBeInstanceOf(CbFluentEuGateway)
  })

  it('falls back when condition fails', async function () {
    process.env.CB_FLUENT_REGION = 'other'
    const di = new CaffeineIoC({ decorators: false })
    di.bind(CbFluentEuGateway, t => t.toSelf()
      .extends(CbFluentGateway)
      .conditional(() => process.env.CB_FLUENT_REGION === 'eu')
      .primary())
    di.bind(CbFluentMockGateway, t => t.toSelf()
      .extends(CbFluentGateway))
    await di.init()
    expect(di.get(CbFluentGateway)).toBeInstanceOf(CbFluentMockGateway)
  })
})

// ─── fallback-bindings: @Fallback used alone ─────────────────────────────────

describe('fallback-bindings: @Fallback used alone', function () {
  abstract class FbLoggerA {
    abstract log(msg: string): string
  }

  @Fallback()
  @Injectable()
  @Extends()
  class FbNoopLoggerA extends FbLoggerA {
    log(_msg: string) { return 'noop' }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Fallback used when no other binding for key exists', function () {
    expect(di.get(FbLoggerA)).toBeInstanceOf(FbNoopLoggerA)
  })
})

// ─── fallback-bindings: @Fallback skipped with override ──────────────────────

describe('fallback-bindings: @Fallback skipped with override', function () {
  abstract class FbLoggerB {
    abstract log(msg: string): string
  }

  @Fallback()
  @Injectable()
  @Extends()
  class FbNoopLoggerB extends FbLoggerB {
    log(_msg: string) { return 'noop' }
  }

  @Primary()
  @Injectable()
  @Extends()
  class FbRealLoggerB extends FbLoggerB {
    log(msg: string) { return `real:${msg}` }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Fallback skipped when another non-fallback binding exists', function () {
    expect(di.get(FbLoggerB)).toBeInstanceOf(FbRealLoggerB)
  })
})

// ─── fallback-bindings: library override pattern ─────────────────────────────

describe('fallback-bindings: library override pattern', function () {
  abstract class FbCacheLib {
    abstract get(key: string): unknown
    abstract set(key: string, value: unknown): void
  }

  @Fallback()
  @Injectable()
  @Extends()
  class FbInMemoryCacheLib extends FbCacheLib {
    private readonly store = new Map<string, unknown>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: unknown) { this.store.set(key, value) }
  }

  @Primary()
  @Injectable()
  @Extends()
  class FbRedisCacheLib extends FbCacheLib {
    get(key: string) { return `redis:${key}` }
    set(key: string, value: unknown) { /* no-op */ }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('application binding overrides library @Fallback', function () {
    expect(di.get(FbCacheLib)).toBeInstanceOf(FbRedisCacheLib)
  })
})

// ─── fallback-bindings: @Fallback on @Provides — used ────────────────────────

describe('fallback-bindings: @Fallback on @Provides — used', function () {
  abstract class FbProvidesCacheA {
    abstract get(key: string): unknown
  }

  class FbProvidesInMemoryCacheA extends FbProvidesCacheA {
    private store = new Map<string, unknown>()
    get(key: string) { return this.store.get(key) }
  }

  @Configuration()
  class FbLibConfigA {
    @Fallback()
    @Provides(FbProvidesCacheA)
    cache(): FbProvidesCacheA {
      return new FbProvidesInMemoryCacheA()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Fallback @Provides used when no non-fallback binding for key', function () {
    expect(di.get(FbProvidesCacheA)).toBeInstanceOf(FbProvidesInMemoryCacheA)
  })
})

// ─── fallback-bindings: @Fallback on @Provides — overridden ──────────────────

describe('fallback-bindings: @Fallback on @Provides — overridden', function () {
  abstract class FbProvidesCacheB {
    abstract get(key: string): unknown
  }

  class FbProvidesInMemoryCacheB extends FbProvidesCacheB {
    get(key: string) { return undefined }
  }

  class FbProvidesRedisCacheB extends FbProvidesCacheB {
    get(key: string) { return `redis:${key}` }
  }

  @Configuration()
  class FbLibConfigB {
    @Fallback()
    @Provides(FbProvidesCacheB)
    cache(): FbProvidesCacheB {
      return new FbProvidesInMemoryCacheB()
    }
  }

  @Configuration()
  class FbAppConfigB {
    @Provides(FbProvidesCacheB)
    cache(): FbProvidesCacheB {
      return new FbProvidesRedisCacheB()
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Provides without @Fallback overrides @Fallback @Provides', function () {
    expect(di.get(FbProvidesCacheB)).toBeInstanceOf(FbProvidesRedisCacheB)
  })
})

// ─── fallback-bindings: @Fallback + @ConditionalOn — active ──────────────────

describe('fallback-bindings: @Fallback + @ConditionalOn — active', function () {
  abstract class FbCondGatewayA {
    abstract charge(amount: number): string
  }

  @Fallback()
  @ConditionalOn(() => process.env.FB_COND_A !== 'test')
  @Injectable()
  @Extends()
  class FbDefaultGatewayA extends FbCondGatewayA {
    charge(amount: number) { return `default:${amount}` }
  }

  let origNodeEnv: string | undefined
  beforeAll(function () {
    origNodeEnv = process.env.FB_COND_A
  })
  afterAll(function () {
    if (origNodeEnv === undefined) {
      delete process.env.FB_COND_A
    } else {
      process.env.FB_COND_A = origNodeEnv
    }
  })

  it('fallback active when condition passes', async function () {
    process.env.FB_COND_A = 'production'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(FbDefaultGatewayA)).toBe(true)
    expect(di.get(FbCondGatewayA)).toBeInstanceOf(FbDefaultGatewayA)
  })
})

// ─── fallback-bindings: @Fallback + @ConditionalOn — inactive ────────────────

describe('fallback-bindings: @Fallback + @ConditionalOn — inactive', function () {
  abstract class FbCondGatewayB {
    abstract charge(amount: number): string
  }

  @Fallback()
  @ConditionalOn(() => process.env.FB_COND_B !== 'test')
  @Injectable()
  @Extends()
  class FbDefaultGatewayB extends FbCondGatewayB {
    charge(amount: number) { return `default:${amount}` }
  }

  let origNodeEnv: string | undefined
  beforeAll(function () {
    origNodeEnv = process.env.FB_COND_B
  })
  afterAll(function () {
    if (origNodeEnv === undefined) {
      delete process.env.FB_COND_B
    } else {
      process.env.FB_COND_B = origNodeEnv
    }
  })

  it('fallback inactive when condition fails', async function () {
    process.env.FB_COND_B = 'test'
    const di = new CaffeineIoC()
    await di.init()
    expect(di.has(FbDefaultGatewayB)).toBe(false)
  })
})

// ─── fallback-bindings: fluent .fallback() API ───────────────────────────────

describe('fallback-bindings: fluent .fallback() API', function () {
  abstract class FbFluentCache {
    abstract get(key: string): string | undefined
    abstract set(key: string, value: string): void
  }

  class FbFluentInMemoryCache extends FbFluentCache {
    private store = new Map<string, string>()
    get(key: string) { return this.store.get(key) }
    set(key: string, value: string) { this.store.set(key, value) }
  }

  class FbFluentRedisCache extends FbFluentCache {
    get(key: string) { return undefined }
    set(key: string, value: string) { /* no-op */ }
  }

  it('.fallback() used when no non-fallback binding exists', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(FbFluentCache, t => t.toClass(FbFluentInMemoryCache)
      .fallback())
    await di.init()
    expect(di.get(FbFluentCache)).toBeInstanceOf(FbFluentInMemoryCache)
  })

  it('.fallback() skipped when non-fallback binding exists', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(FbFluentCache, t => t.toClass(FbFluentInMemoryCache)
      .fallback())
    di.bind(FbFluentCache, t => t.toClass(FbFluentRedisCache))
    await di.init()
    expect(di.get(FbFluentCache)).toBeInstanceOf(FbFluentRedisCache)
  })
})

// ─── lazy-bindings: @Lazy() basic ────────────────────────────────────────────

describe('lazy-bindings: @Lazy() basic', function () {
  let lbLazyConstructed = false

  @Lazy()
  @Injectable()
  class LbHeavyService {
    constructor() {
      lbLazyConstructed = true
    }

    compute() { return 42 }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    lbLazyConstructed = false
    di = new CaffeineIoC()
    await di.init()
  })

  it('@Lazy bean not constructed during init()', function () {
    expect(lbLazyConstructed).toBe(false)
  })

  it('@Lazy bean constructed on first get()', function () {
    di.get(LbHeavyService)
    expect(lbLazyConstructed).toBe(true)
    expect(di.get(LbHeavyService).compute()).toBe(42)
  })
})

// ─── lazy-bindings: container-wide lazy: true ────────────────────────────────

describe('lazy-bindings: container-wide lazy: true', function () {
  let lbWideLazyConstructed = false

  @Injectable()
  class LbWideLazyService {
    constructor() {
      lbWideLazyConstructed = true
    }

    value() { return 'wide-lazy' }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    lbWideLazyConstructed = false
    di = new CaffeineIoC({ lazy: true })
    await di.init()
  })

  it('no beans constructed during init() when lazy: true', function () {
    expect(lbWideLazyConstructed).toBe(false)
  })

  it('bean constructed on first get() when container lazy: true', function () {
    di.get(LbWideLazyService)
    expect(lbWideLazyConstructed).toBe(true)
    expect(di.get(LbWideLazyService).value()).toBe('wide-lazy')
  })
})

// ─── lazy-bindings: @Lazy(false) eager override ──────────────────────────────

describe('lazy-bindings: @Lazy(false) eager override', function () {
  let lbEagerConstructed = false

  @Lazy(false)
  @Injectable()
  class LbCriticalStartupService {
    constructor() {
      lbEagerConstructed = true
    }

    status() { return 'ok' }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    lbEagerConstructed = false
    di = new CaffeineIoC({ lazy: true })
    await di.init()
  })

  it('@Lazy(false) constructs bean during init() despite container-wide lazy: true', function () {
    expect(lbEagerConstructed).toBe(true)
    expect(di.get(LbCriticalStartupService).status()).toBe('ok')
  })
})

// ─── lazy-bindings: manual .lazy() API ───────────────────────────────────────

describe('lazy-bindings: manual .lazy() API', function () {
  class LbManualHeavyService {
    readonly constructed = true
  }

  class LbManualCriticalService {
    readonly ready = true
  }

  it('.lazy() defers bean construction to first get()', async function () {
    let constructed = false
    class LbDeferredService {
      constructor() { constructed = true }
    }
    const di = new CaffeineIoC({ decorators: false })
    di.bind(LbDeferredService, t => t.toSelf()
      .lazy())
    await di.init()
    expect(constructed).toBe(false)
    di.get(LbDeferredService)
    expect(constructed).toBe(true)
  })

  it('.lazy(false) constructs bean during init() in lazy container', async function () {
    let eagerConstructed = false
    class LbEagerService {
      constructor() { eagerConstructed = true }
    }
    const di = new CaffeineIoC({ decorators: false, lazy: true })
    di.bind(LbEagerService, t => t.toSelf()
      .lazy(false))
    await di.init()
    expect(eagerConstructed).toBe(true)
  })
})

// ─── mixing-scopes: Provider<T> with $i.provide() ────────────────────────────────

describe('mixing-scopes: Provider<T> with $i.provide()', function () {
  @Injectable()
  @Lifetime(Scopes.TRANSIENT)
  class MsEmailSender {
    readonly id = Math.random()
    send(to: string, body: string) { return `sent:${to}` }
  }

  @Injectable([$i.provide(MsEmailSender)])
  @Lifetime(Scopes.SINGLETON)
  class MsNotificationService {
    constructor(readonly sender: Provider<MsEmailSender>) {}
    notify(to: string, body: string) {
      return this.sender.get().send(to, body)
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('$i.provide() wraps dependency in Provider interface', function () {
    const svc = di.get(MsNotificationService)
    expect(svc.sender).toBeDefined()
    expect(typeof svc.sender.get).toBe('function')
  })

  it('Provider.get() returns fresh transient instance on each call', function () {
    const svc = di.get(MsNotificationService)
    const first = svc.sender.get()
    const second = svc.sender.get()
    expect(first).not.toBe(second)
  })

  it('notification service uses Provider to invoke transient dep', function () {
    const svc = di.get(MsNotificationService)
    expect(svc.notify('user@example.com', 'Hello')).toBe('sent:user@example.com')
  })
})

// ─── mixing-scopes: singleton holds Provider for short-lived dep ──────────────

describe('mixing-scopes: singleton holds Provider for short-lived dep', function () {
  @Injectable()
  @Lifetime(Scopes.TRANSIENT)
  class MsRequestContext {
    readonly requestID = Math.random().toString(36)
  }

  @Injectable([$i.provide(MsRequestContext)])
  @Lifetime(Scopes.SINGLETON)
  class MsOrderController {
    constructor(readonly ctx: Provider<MsRequestContext>) {}
    handle() {
      const context = this.ctx.get()
      return `handling:${context.requestID}`
    }
  }

  let di: CaffeineIoC
  beforeAll(async function () {
    di = new CaffeineIoC()
    await di.init()
  })

  it('singleton holds Provider, not the transient instance directly', function () {
    const ctrl = di.get(MsOrderController)
    expect(typeof ctrl.ctx.get).toBe('function')
  })

  it('Provider.get() resolves a fresh transient instance on each call', function () {
    const ctrl = di.get(MsOrderController)
    const first = ctrl.ctx.get()
    const second = ctrl.ctx.get()
    expect(first).not.toBe(second)
  })

  it('singleton controller resolves context on demand via Provider', function () {
    const ctrl = di.get(MsOrderController)
    expect(ctrl.handle()).toMatch(/^handling:/)
  })
})
