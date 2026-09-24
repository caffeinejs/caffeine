import { CaffeineIoC, type OnDestroy } from '@caffeinejs/di'
import { createApplication, ErrFeatureAlreadyInstalled } from '@caffeinejs/std'
import { DataSource, type DataSourceOptions, type Repository } from 'typeorm'
import { afterEach, describe, expect, it } from 'vitest'

import { type Order, OrderEntity, type User, UserEntity } from './_testdata/entities.testkit.js'
import { ErrMissingDataSourceOptions } from './errors.js'
import { $typeorm } from './injection.js'
import { dataSourceKey } from './keys.js'
import { typeorm } from './plugin.js'

/** What the sql.js driver adds to the entity manager. Not on TypeORM's barrel, so it is named structurally. */
type ExportableManager = { exportDatabase(): Uint8Array }

const opened: Array<() => Promise<unknown>> = []

afterEach(async function () {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
})

function newApplication() {
  return createApplication({ container: new CaffeineIoC({ decorators: false }) })
}

// Both entities always travel together: `Order` declares a relation to `User`, and TypeORM refuses to build
// metadata for half of a relation.
function memory(overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  return {
    type: 'sqljs',
    autoSave: false,
    synchronize: true,
    entities: [UserEntity, OrderEntity],
    ...overrides,
  } as DataSourceOptions
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class Users {
  constructor(readonly users: Repository<User>) {}
}

describe('typeorm() feature', function () {
  it('should refuse a second unnamed instance', function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    // Both would bind under TypeORM's `DataSource`, and the second would silently shadow or fight the first.
    expect(() => app.with(typeorm(t => t.dataSource(memory())))).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('should allow a named instance alongside the unnamed one', function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    expect(() => app.with(typeorm('reports', t => t.dataSource(memory())))).not.toThrow()
  })

  it('should fail ready() when the callback never provides options', async function () {
    const app = newApplication().with(typeorm(() => undefined))

    opened.push(() => app.close())

    // Nothing else can report this: an empty builder would otherwise bind a DataSource with no driver and
    // fail somewhere inside TypeORM.
    await expect(app.ready()).rejects.toThrow(ErrMissingDataSourceOptions)
  })
})

describe('typeorm() over a real database', function () {
  it('should hand a working repository, connected before ready() returns', async function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    app.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    await app.ready()
    opened.push(() => app.close())

    const { users } = app.container.get(Users)

    await users.save({ email: 'ada@example.com' } as User)

    expect(await users.findOneBy({ email: 'ada@example.com' })).toMatchObject({ email: 'ada@example.com' })
    expect(app.container.get(DataSource).isInitialized).toBe(true)
  })

  it('should load a relation declared by the entity schema', async function () {
    class Shop {
      constructor(
        readonly users: Repository<User>,
        readonly orders: Repository<Order>,
      ) {}
    }

    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    app.container.bind(Shop, t => t.toClass(Shop, [$typeorm.repository(UserEntity), $typeorm.repository(OrderEntity)]))

    await app.ready()
    opened.push(() => app.close())

    const shop = app.container.get(Shop)
    const ada = await shop.users.save({ email: 'ada@example.com' } as User)

    await shop.orders.save({ total: 42, user: ada } as Order)
    await shop.orders.save({ total: 8, user: ada } as Order)

    const [loaded] = await shop.users.find({ relations: { orders: true } })

    // The builder hands TypeORM its options untouched, so relations have to work exactly as they would
    // without the feature. A schema this package reshaped would fail right here.
    expect(loaded.orders?.map(order => order.total).sort((a, b) => a - b)).toEqual([8, 42])
  })

  it('should roll back a transaction started from the injected repository', async function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    app.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    await app.ready()
    opened.push(() => app.close())

    const { users } = app.container.get(Users)

    await users.save({ email: 'kept@example.com' } as User)

    await expect(
      users.manager.transaction(async manager => {
        await manager.save(UserEntity, { email: 'rolled@example.com' } as User)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The injected repository runs on the feature's connection rather than a detached one: a repository
    // built over a second connection would not see the rollback, and the count would be two.
    expect(await users.count()).toEqual(1)
    expect(await users.findOneBy({ email: 'rolled@example.com' })).toBeNull()
  })

  it('should hand the same repository instance to every consumer of the entity', async function () {
    class Readers {
      constructor(readonly users: Repository<User>) {}
    }

    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    app.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))
    app.container.bind(Readers, t => t.toClass(Readers, [$typeorm.repository(UserEntity)]))

    await app.ready()
    opened.push(() => app.close())

    // TypeORM caches a repository per entity per manager, which is what lets the stage call `getRepository`
    // on every resolution instead of memoizing one itself.
    expect(app.container.get(Users).users).toBe(app.container.get(Readers).users)
  })

  it('should resolve an instance name and its key to the same connection', async function () {
    class Pair {
      constructor(
        readonly byName: Repository<User>,
        readonly byKey: Repository<User>,
      ) {}
    }

    const app = newApplication().with(typeorm('reports', t => t.dataSource(memory())))

    app.container.bind(Pair, t =>
      t.toClass(Pair, [
        $typeorm.repository(UserEntity, 'reports'),
        $typeorm.repository(UserEntity, dataSourceKey('reports')),
      ]),
    )

    await app.ready()
    opened.push(() => app.close())

    const pair = app.container.get(Pair)

    // The string shorthand has to fold to exactly the key the feature bound, or naming an instance would
    // work in one place and silently miss in the other.
    expect(pair.byName).toBe(pair.byKey)
  })

  it('should keep each named instance on its own connection', async function () {
    class Service {
      constructor(
        readonly main: Repository<User>,
        readonly reports: Repository<User>,
      ) {}
    }

    const app = newApplication()
      .with(typeorm(t => t.dataSource(memory())))
      .with(typeorm('reports', t => t.dataSource(memory())))

    app.container.bind(Service, t =>
      t.toClass(Service, [$typeorm.repository(UserEntity), $typeorm.repository(UserEntity, 'reports')]),
    )

    await app.ready()
    opened.push(() => app.close())

    const service = app.container.get(Service)

    await service.main.save({ email: 'ada@example.com' } as User)
    await service.reports.save({ email: 'grace@example.com' } as User)
    await service.reports.save({ email: 'hedy@example.com' } as User)

    // Two real databases: a row written through one is invisible to the other, which one shared DataSource
    // behind two keys would not satisfy.
    expect(await service.main.count()).toEqual(1)
    expect(await service.reports.count()).toEqual(2)
    expect(app.container.get(DataSource)).not.toBe(app.container.get(dataSourceKey('reports')))
  })

  it('should reopen a database exported before the application closed', async function () {
    const first = newApplication().with(typeorm(t => t.dataSource(memory())))

    first.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    await first.ready()
    await first.container.get(Users).users.save({ email: 'ada@example.com' } as User)

    const snapshot = (first.container.get(DataSource).manager as unknown as ExportableManager).exportDatabase()

    await first.close()

    const second = newApplication().with(typeorm(t => t.dataSource(memory({ synchronize: false, database: snapshot }))))

    second.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    await second.ready()
    opened.push(() => second.close())

    // The writes were real and outlived the connection that made them, so the feature is not just holding
    // rows in a repository cache for the length of one application.
    expect(await second.container.get(Users).users.findOneBy({ email: 'ada@example.com' })).not.toBeNull()
  })
})

describe('typeorm() lifecycle', function () {
  it('should let a shutdown hook still use the repository', async function () {
    class AuditLog implements OnDestroy {
      rowsAtShutdown = -1

      constructor(readonly users: Repository<User>) {}

      async onDestroy(): Promise<void> {
        await this.users.save({ email: 'flushed@example.com' } as User)
        this.rowsAtShutdown = await this.users.count()
      }
    }

    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    app.container.bind(AuditLog, t => t.toClass(AuditLog, [$typeorm.repository(UserEntity)]))

    await app.ready()
    opened.push(() => app.close())

    const audit = app.container.get(AuditLog)

    // Precondition: teardown has not run. Without it a hook that never fired would pass the assertion below.
    expect(audit.rowsAtShutdown).toEqual(-1)

    await app.close()

    // Disposal runs in reverse creation order, so a service outlives the DataSource it was built from and a
    // flush-on-shutdown still has a connection. Invert that order and this write throws inside dispose,
    // surfacing as an AggregateError out of close().
    expect(audit.rowsAtShutdown).toEqual(1)
  })

  it('should wait for the connection to close before close() resolves', async function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    await app.ready()
    opened.push(() => app.close())

    const dataSource = app.container.get(DataSource)
    const inner = dataSource.destroy.bind(dataSource)
    let settled = 0

    dataSource.destroy = async () => {
      await sleep(50)
      await inner()
      settled += 1
    }

    // Precondition: teardown has not started. Without it this test would pass on a hook that never ran.
    expect(settled).toEqual(0)

    await app.close()

    // Shutdown awaited the close, so the process does not exit with a connection still draining.
    expect(settled).toEqual(1)
    expect(dataSource.isInitialized).toBe(false)
  })

  it('should leave close() safe to call twice', async function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory())))

    await app.ready()

    const dataSource = app.container.get(DataSource)
    const inner = dataSource.destroy.bind(dataSource)
    let destroyed = 0

    dataSource.destroy = async () => {
      destroyed += 1
      await inner()
    }

    await app.close()
    expect(destroyed).toEqual(1)

    // Shutdown paths double up in practice — a signal handler and an explicit close, or a test teardown
    // after the test already closed. The second call must not reach the driver again.
    await expect(app.close()).resolves.toBeUndefined()
    expect(destroyed).toEqual(1)
  })

  it('should reject ready() when the database cannot be opened', async function () {
    const app = newApplication().with(typeorm(t => t.dataSource(memory({ database: new Uint8Array([1, 2, 3, 4, 5]) }))))

    app.container.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    // The failure belongs to start-up: a driver that cannot open its database must stop the application
    // rather than hand out repositories that throw on first use.
    await expect(app.ready()).rejects.toThrow()

    // Nothing was left resolvable, and shutting the half-started application down is still safe.
    expect(() => app.container.get(DataSource)).toThrow()
    await expect(app.close()).resolves.toBeUndefined()
  })

  it('should close every instance when several are installed', async function () {
    const app = newApplication()
      .with(typeorm(t => t.dataSource(memory())))
      .with(typeorm('reports', t => t.dataSource(memory())))

    await app.ready()

    const main = app.container.get(DataSource)
    const reports = app.container.get(dataSourceKey('reports'))

    expect(main.isInitialized && reports.isInitialized).toBe(true)

    await app.close()

    // A second instance is disposed by the same pass as the first: one left open leaks a connection pool
    // for the life of the process.
    expect(main.isInitialized).toBe(false)
    expect(reports.isInitialized).toBe(false)
  })
})
