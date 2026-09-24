import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Provides } from '../decorators/provides.js'
import { ProvidesAsync } from '../decorators/provides_async.js'
import { UseAsyncFactory } from '../decorators/use_async_factory.js'
import { ErrInvalidBinding } from '../errors.js'
import { token } from '../key.js'
import { PostProcessor } from '../post_processor.js'
import { ResolutionContext } from '../resolution_context.js'
import { Scopes } from '../scope.js'

describe('Async bindings via decorators', function () {
  it('should pre-cache async provided binding and return T synchronously after initInstances()', async function () {
    class DatabaseConnection {
      constructor(readonly url: string) {}
    }

    @Configuration()
    class AppConfig {
      @ProvidesAsync(DatabaseConnection)
      async provideDb(): Promise<DatabaseConnection> {
        return new Promise(resolve => setTimeout(() => resolve(new DatabaseConnection('postgres://localhost')), 10))
      }
    }

    const di = new CaffeineIoC()
    await di.init()

    const db = di.get(DatabaseConnection)

    expect(db).toBeInstanceOf(DatabaseConnection)
    expect((db as DatabaseConnection).url).toEqual('postgres://localhost')
  })

  it('should support a mix of sync and async dependencies', async function () {
    const kConnectionString = token<string>(Symbol('connection-string'))

    class ConfigValue {
      constructor(readonly url: string) {}
    }

    class DbConnection {
      constructor(readonly cfg: ConfigValue) {}
    }

    @Configuration()
    class AsyncDepConfig {
      @ProvidesAsync(DbConnection, [ConfigValue])
      async provideDb(cfg: ConfigValue): Promise<DbConnection> {
        return new DbConnection(cfg)
      }

      @ProvidesAsync(ConfigValue, [kConnectionString])
      async provideConfig(connectionString: string): Promise<ConfigValue> {
        return new ConfigValue(connectionString)
      }

      @Provides(kConnectionString)
      connectionString() {
        return 'postgres://db'
      }
    }

    @Injectable([DbConnection])
    class Repo {
      constructor(readonly db: DbConnection) {}
    }

    void AsyncDepConfig
    void Repo

    const di = new CaffeineIoC()
    await di.init()

    const db = di.get(DbConnection)

    expect(db).toBeInstanceOf(DbConnection)
    expect((db as DbConnection).cfg.url).toEqual('postgres://db')

    const repo = di.get(Repo)

    expect(repo).toBeInstanceOf(Repo)
    expect(repo.db).toBeInstanceOf(DbConnection)
    expect(repo.db.cfg.url).toEqual('postgres://db')
  })

  it('should support async dependencies regardless of @Provides declaration order', async function () {
    const kConnStr = token<string>(Symbol('conn-str'))

    class Cfg {
      constructor(readonly url: string) {}
    }

    class Db {
      constructor(readonly cfg: Cfg) {}
    }

    @Configuration()
    class ReversedConfig {
      @ProvidesAsync(Db, [Cfg])
      async provideDb(cfg: Cfg): Promise<Db> {
        return new Db(cfg)
      }

      @ProvidesAsync(Cfg, [kConnStr])
      async provideCfg(url: string): Promise<Cfg> {
        return new Cfg(url)
      }

      @Provides(kConnStr)
      connStr() {
        return 'postgres://db'
      }
    }

    void ReversedConfig

    const di = new CaffeineIoC()
    await di.init()

    const db = di.get(Db)
    expect(db).toBeInstanceOf(Db)
    expect(db.cfg).toBeInstanceOf(Cfg)
    expect(db.cfg.url).toEqual('postgres://db')
  })
})

describe('Async bindings via manual binding', function () {
  it('should pre-cache async factory and return T synchronously after container is initialized', async function () {
    class Connection {
      constructor(readonly host: string) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(Connection, t =>
      t.toAsyncFactory(async () => {
        return new Promise<Connection>(resolve => setTimeout(() => resolve(new Connection('localhost')), 10))
      }),
    )

    await di.init()

    const conn = di.get(Connection)

    expect(conn).toBeInstanceOf(Connection)
    expect((conn as Connection).host).toEqual('localhost')
  })

  it('should allow container.get() calls from within an async factory', async function () {
    class SyncDep {
      readonly value = 'sync-dep'
    }

    class AsyncSvc {
      constructor(readonly dep: SyncDep) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(SyncDep, t => t.toSelf().lifetime(Scopes.SINGLETON))
    di.bind(AsyncSvc, t =>
      t.toAsyncFactory(async ctx => {
        const dep = ctx.container.get(SyncDep)
        return new AsyncSvc(dep)
      }),
    )

    await di.init()

    const svc = di.get(AsyncSvc)
    expect(svc).toBeInstanceOf(AsyncSvc)
    expect((svc as AsyncSvc).dep.value).toBe('sync-dep')
  })

  it('should throw when an explicit non-singleton scope is applied to an async binding', function () {
    class MyService {}

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()

    expect(() => {
      di.bind(MyService, t => t.toAsyncFactory(async () => new MyService()).lifetime(Scopes.TRANSIENT))
    }).toThrow(ErrInvalidBinding)
  })

  it('should throw when lazy() is called on an async binding', function () {
    class MyService {}

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()

    expect(() => {
      di.bind(MyService, t => t.toAsyncFactory(async () => new MyService()).lazy())
    }).toThrow(ErrInvalidBinding)

    expect(() => {
      di.bind(MyService, t => t.toAsyncFactory(async () => new MyService()).lazy(false))
    }).not.toThrow()
  })
})

describe('Async bindings with RefreshScope', function () {
  it('should not throw when refresh scope is applied to an async binding', function () {
    class MyService {}

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()

    expect(() => {
      di.bind(MyService, t => t.toAsyncFactory(async () => new MyService()).lifetime(Scopes.REFRESH))
    }).not.toThrow()
  })

  it('should pre-cache async refresh-scoped binding and return T synchronously after init()', async function () {
    class APIToken {
      constructor(readonly value: string) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(APIToken, t => t.toAsyncFactory(async () => new APIToken('token-v1')).lifetime(Scopes.REFRESH))

    await di.init()

    const token = di.get(APIToken)

    expect(token).toBeInstanceOf(APIToken)
    expect((token as APIToken).value).toEqual('token-v1')
  })

  it('should produce a new instance after scope.refresh()', async function () {
    class APIToken {
      constructor(readonly value: string) {}
    }

    let counter = 0
    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(APIToken, t => t.toAsyncFactory(async () => new APIToken(`token-v${++counter}`)).lifetime(Scopes.REFRESH))

    await di.init()
    const t1 = di.get(APIToken)

    expect((t1 as APIToken).value).toEqual('token-v1')

    await di.refresher.refresh()

    const t2 = di.get(APIToken)

    expect(t2).not.toBe(t1)
    expect((t2 as APIToken).value).toEqual('token-v2')
  })

  it('should not re-resolve singleton async bindings after a refresh', async function () {
    class DbConn {
      constructor(readonly id: number) {}
    }

    class RefreshedToken {
      constructor(readonly id: number) {}
    }

    let singletonCount = 0
    let refreshCount = 0

    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(DbConn, t => t.toAsyncFactory(async () => new DbConn(++singletonCount)))
    di.bind(RefreshedToken, t =>
      t.toAsyncFactory(async () => new RefreshedToken(++refreshCount)).lifetime(Scopes.REFRESH),
    )

    await di.init()

    expect(singletonCount).toEqual(1)
    expect(refreshCount).toEqual(1)

    await di.refresher.refresh()

    expect(singletonCount).toEqual(1)
    expect(refreshCount).toEqual(2)
  })
})

describe('resetInstance() with async bindings', function () {
  it('should re-initialize a singleton async binding after reset', async function () {
    class Token {
      constructor(readonly value: number) {}
    }

    let counter = 0
    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(Token, t => t.toAsyncFactory(async () => new Token(++counter)))

    await di.init()

    const t1 = di.get(Token)
    expect(t1).toBeInstanceOf(Token)
    expect((t1 as Token).value).toEqual(1)

    await di.resetInstance(Token)

    const t2 = di.get(Token)
    expect(t2).toBeInstanceOf(Token)
    expect((t2 as Token).value).toEqual(2)
    expect(t2).not.toBe(t1)
  })

  it('should re-initialize a refresh-scoped async binding after reset', async function () {
    class RefreshToken {
      constructor(readonly value: number) {}
    }

    let counter = 0
    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(RefreshToken, t => t.toAsyncFactory(async () => new RefreshToken(++counter)).lifetime(Scopes.REFRESH))

    await di.init()

    const t1 = di.get(RefreshToken)
    expect((t1 as RefreshToken).value).toEqual(1)

    await di.resetInstance(RefreshToken)

    const t2 = di.get(RefreshToken)
    expect(t2).toBeInstanceOf(RefreshToken)
    expect((t2 as RefreshToken).value).toEqual(2)
    expect(t2).not.toBe(t1)
  })

  it('should call preDestroy before re-initializing an async binding', async function () {
    const order: string[] = []

    class Conn {
      close() {
        order.push('destroy')
      }
    }

    let counter = 0
    const di = new CaffeineIoC({ decorators: false })
    di.autoWire()
    di.bind(Conn, t =>
      t
        .toAsyncFactory(async () => {
          order.push(`init-${++counter}`)
          return new Conn()
        })
        .preDestroy(v => v.close()),
    )

    await di.init()
    expect(order).toEqual(['init-1'])

    await di.resetInstance(Conn)
    expect(order).toEqual(['init-1', 'destroy', 'init-2'])
  })

  it('should re-initialize only the reset binding when it has an async dependency', async function () {
    class DepA {
      constructor(readonly id: number) {}
    }

    class DepB {
      constructor(
        readonly dep: DepA,
        readonly id: number,
      ) {}
    }

    let aCount = 0
    let bCount = 0

    @Configuration()
    class AsyncDepConfig {
      @ProvidesAsync(DepA)
      async provideA(): Promise<DepA> {
        return new Promise(resolve => setTimeout(() => resolve(new DepA(++aCount)), 10))
      }

      @ProvidesAsync(DepB, [DepA])
      async provideB(a: DepA): Promise<DepB> {
        return new Promise(resolve => setTimeout(() => resolve(new DepB(a, ++bCount)), 10))
      }
    }

    void AsyncDepConfig

    const di = new CaffeineIoC()
    await di.init()

    const a1 = di.get(DepA) as DepA
    const b1 = di.get(DepB) as DepB

    expect(a1.id).toEqual(1)
    expect(b1.id).toEqual(1)
    expect(b1.dep).toBe(a1)

    await di.resetInstance(DepB)

    const a2 = di.get(DepA) as DepA
    const b2 = di.get(DepB) as DepB

    expect(aCount).toEqual(1)
    expect(a2).toBe(a1)
    expect(b2).toBeInstanceOf(DepB)
    expect(b2.id).toEqual(2)
    expect(b2.dep).toBe(a1)
  })
})

describe('@UseAsyncFactory()', function () {
  it('should pre-cache an injectable decorated with @UseAsyncFactory(factory instance) after init()', async function () {
    class Config {
      constructor(readonly dsn: string) {}
    }

    @Injectable()
    @UseAsyncFactory(_ctx => Promise.resolve(new Config('redis://localhost')))
    class Config2 extends Config {
      constructor() {
        super('')
      }
    }

    const di = new CaffeineIoC()
    await di.init()

    const cfg = di.get(Config2)

    expect(cfg).toBeInstanceOf(Config)
    expect((cfg as Config).dsn).toEqual('redis://localhost')
  })
})

describe('async bindings with post-processors', function () {
  it('should call beforeInit and afterInit with the resolved T, not a Promise', async function () {
    class Token {
      constructor(readonly value: string) {}
    }

    const receivedByBeforeInit: unknown[] = []
    const receivedByAfterInit: unknown[] = []

    const pp: PostProcessor = {
      beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
        receivedByBeforeInit.push(instance)
        return instance
      },
      afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
        receivedByAfterInit.push(instance)
        return instance
      },
    }

    const di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(pp)
    di.bind(Token, t => t.toAsyncFactory(async () => new Token('hello')))

    await di.init()

    expect(receivedByBeforeInit).toHaveLength(1)
    expect(receivedByBeforeInit[0]).toBeInstanceOf(Token)
    expect(receivedByBeforeInit[0]).not.toBeInstanceOf(Promise)
    expect(receivedByAfterInit).toHaveLength(1)
    expect(receivedByAfterInit[0]).toBeInstanceOf(Token)
    expect(receivedByAfterInit[0]).not.toBeInstanceOf(Promise)
    expect(di.get(Token) as Token).toBeInstanceOf(Token)
  })

  it('should allow afterInit to replace the resolved instance', async function () {
    class Svc {
      constructor(readonly id: number) {}
    }

    class WrappedSvc extends Svc {}

    const pp: PostProcessor = {
      beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
        return instance
      },
      afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
        if (instance instanceof Svc) {
          return new WrappedSvc(instance.id)
        }
        return instance
      },
    }

    const di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(pp)
    di.bind(Svc, t => t.toAsyncFactory(async () => new Svc(99)))

    await di.init()

    const result = di.get(Svc)
    expect(result).toBeInstanceOf(WrappedSvc)
    expect((result as Svc).id).toBe(99)
  })

  it('should fire postConstruct on the resolved instance', async function () {
    const initiated: string[] = []

    class AsyncBean {
      onInit() {
        initiated.push('postConstruct')
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(AsyncBean, t => t.toAsyncFactory(async () => new AsyncBean()).postConstruct(v => v.onInit()))

    await di.init()

    expect(initiated).toEqual(['postConstruct'])
    expect(di.get(AsyncBean)).toBeInstanceOf(AsyncBean)
  })

  it('should apply user interceptor, then beforeInit, then postConstruct, then afterInit', async function () {
    const order: string[] = []

    class Ordered {
      onInit() {
        order.push('postConstruct')
      }
    }

    const pp: PostProcessor = {
      beforeInit(_ctx: ResolutionContext, instance: unknown): unknown {
        order.push('beforeInit')
        return instance
      },
      afterInit(_ctx: ResolutionContext, instance: unknown): unknown {
        order.push('afterInit')
        return instance
      },
    }

    const di = new CaffeineIoC({ decorators: false })
    di.postProcessors.add(pp)
    di.bind(Ordered, t =>
      t
        .toAsyncFactory(async () => new Ordered())
        .intercept((_ctx, instance) => {
          order.push('interceptor')
          return instance
        })
        .postConstruct(v => v.onInit()),
    )

    await di.init()

    expect(order).toEqual(['interceptor', 'beforeInit', 'postConstruct', 'afterInit'])
  })
})

describe('resolveAsyncBindings() — cached skip on repeated init()', function () {
  it('should skip re-resolving an async binding whose scope already has a cached instance', async function () {
    let callCount = 0

    class DbConn {
      readonly id: number
      constructor() {
        this.id = ++callCount
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(DbConn, t => t.toAsyncFactory(async () => new DbConn()))

    await di.init()
    expect(callCount).toBe(1)

    await di.init()
    expect(callCount).toBe(1)
  })
})

describe('resetBinding() — async path', function () {
  it('should re-resolve an async binding and update the cached value', async function () {
    let callCount = 0

    class Cache {
      readonly version: number
      constructor() {
        this.version = ++callCount
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Cache, t => t.toAsyncFactory(async () => new Cache()))
    await di.init()

    expect(callCount).toBe(1)
    const first = di.get(Cache)

    await di.resetBinding(di.getBinding(Cache))

    expect(callCount).toBe(2)
    const second = di.get(Cache)
    expect(second).toBeInstanceOf(Cache)
    expect(second.version).toBe(2)
    expect(first.version).toBe(1)
  })
})

describe('resetInstance() — mixed async + sync bindings under the same key', function () {
  it('should reset both async and non-async bindings sharing a named key', async function () {
    const kShared = token<Record<string, unknown>>(Symbol('async-sync-shared'))
    let asyncCallCount = 0
    let syncCallCount = 0

    class AsyncSvc {
      readonly id: number
      constructor() {
        this.id = ++asyncCallCount
      }
    }

    class SyncSvc {
      readonly id: number
      constructor() {
        this.id = ++syncCallCount
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(AsyncSvc, t => t.toAsyncFactory(async () => new AsyncSvc()).names(kShared))
    di.bind(SyncSvc, t => t.toSelf().names(kShared))
    await di.init()

    di.get(AsyncSvc)
    di.get(SyncSvc)
    expect(asyncCallCount).toBe(1)
    expect(syncCallCount).toBe(1)

    await di.resetInstance(kShared)

    di.get(AsyncSvc)
    di.get(SyncSvc)
    expect(asyncCallCount).toBe(2)
    expect(syncCallCount).toBe(2)
  })
})

// The type system refuses a promise-returning `@Provides`, but a JavaScript caller never sees that check and
// neither does anything that laundered the factory through `any`. Caching the promise would inject it
// unresolved into every dependant and surface only on first use, which is the defect this guards.
describe('a @Provides factory that returns a promise anyway', function () {
  it('refuses to cache the promise, and names the decorator to use instead', async function () {
    class DataSource {
      query(): void {}
    }

    @Configuration()
    class SneakyConfig {
      // Typed as synchronous, so the compiler is satisfied; the body returns a promise regardless.
      @Provides(DataSource)
      dataSource(): DataSource {
        return Promise.resolve(new DataSource()) as unknown as DataSource
      }
    }
    void SneakyConfig

    // A singleton is eager, so the promise is caught while the container initializes rather than on the
    // first resolution — which is the whole point: nothing is ever handed the unresolved value.
    const di = new CaffeineIoC()

    await expect(di.init()).rejects.toThrow(ErrInvalidBinding)
    await expect(di.init()).rejects.toThrow(/@ProvidesAsync/)
  })
})
