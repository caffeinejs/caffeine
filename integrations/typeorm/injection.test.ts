import { $i, CaffeineIoC, token } from '@caffeinejs/di'
import { DataSource, type Repository } from 'typeorm'
import { describe, expect, it } from 'vitest'

import { type FakeRepository, FakeDataSource } from './_testdata/datasource.testkit.js'
import { type Order, OrderEntity, type User, UserEntity } from './_testdata/entities.testkit.js'
import { ErrNoDataSource, ErrNoUniqueDataSource } from './errors.js'
import { $typeorm } from './injection.js'
import { dataSourceKey } from './keys.js'

/** The fake behind an injected repository, so a test can say which DataSource produced it. */
function fake(repository: Repository<unknown & object>): FakeRepository {
  return repository as unknown as FakeRepository
}

class Users {
  constructor(readonly users: Repository<User>) {}
}

describe('$typeorm.repository()', function () {
  it('should resolve the entity repository from the DataSource bound under TypeORM class', async function () {
    const source = new FakeDataSource('main')
    const di = new CaffeineIoC({ decorators: false })

    di.bind(DataSource, t => t.toValue(source.asDataSource()))
    di.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    await di.init()

    // Both halves matter: the right DataSource, asked for the right entity. Either alone would pass for a
    // helper that ignored its argument.
    expect(fake(di.get(Users).users).source).toEqual('main')
    expect(fake(di.get(Users).users).target).toBe(UserEntity)
  })

  it('should take each repository from the DataSource its token names', async function () {
    const main = new FakeDataSource('main')
    const orders = new FakeDataSource('orders')
    const kOrders = dataSourceKey('orders')

    class Service {
      constructor(
        readonly users: Repository<User>,
        readonly orders: Repository<Order>,
      ) {}
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(DataSource, t => t.toValue(main.asDataSource()))
    di.bind(kOrders, t => t.toValue(orders.asDataSource()))
    di.bind(Service, t =>
      t.toClass(Service, [$typeorm.repository(UserEntity), $typeorm.repository(OrderEntity, kOrders)]),
    )

    await di.init()

    const service = di.get(Service)

    // A second instance is a separate connection, not a view of the first: neither DataSource was asked for
    // the other's entity.
    expect(fake(service.users).source).toEqual('main')
    expect(fake(service.orders).source).toEqual('orders')
    expect(main.handed).toHaveLength(1)
    expect(orders.handed).toHaveLength(1)
  })

  it('should fail at init() rather than at first use when no DataSource is bound', async function () {
    const di = new CaffeineIoC({ decorators: false })

    di.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity)]))

    // The whole point of deciding this while the container compiles: a misconfigured application never
    // reaches a request handler that would fail one caller at a time.
    await expect(di.init()).rejects.toThrow(ErrNoDataSource)
  })

  it('should name the entity and the key it could not resolve', async function () {
    const di = new CaffeineIoC({ decorators: false })

    di.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity, dataSourceKey('reports'))]))

    // Without both, the message leaves the reader to guess which of several repositories is unwired.
    await expect(di.init()).rejects.toThrow(/"User"/)
    await expect(di.init()).rejects.toThrow(/datasource:reports/)
  })

  it('should fail when several DataSources answer to the key and none is primary', async function () {
    const kShared = dataSourceKey('shared')
    const di = new CaffeineIoC({ decorators: false })

    di.bind(token<DataSource>(Symbol('a')), t => t.toValue(new FakeDataSource('a').asDataSource()).names(kShared))
    di.bind(token<DataSource>(Symbol('b')), t => t.toValue(new FakeDataSource('b').asDataSource()).names(kShared))
    di.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity, kShared)]))

    // Picking one silently would make which database a write lands in depend on registration order.
    await expect(di.init()).rejects.toThrow(ErrNoUniqueDataSource)
  })

  it('should take the primary DataSource when several answer to the key', async function () {
    const kShared = dataSourceKey('shared')
    const di = new CaffeineIoC({ decorators: false })

    di.bind(token<DataSource>(Symbol('a')), t => t.toValue(new FakeDataSource('a').asDataSource()).names(kShared))
    di.bind(token<DataSource>(Symbol('b')), t =>
      t.toValue(new FakeDataSource('b').asDataSource()).names(kShared).primary(),
    )
    di.bind(Users, t => t.toClass(Users, [$typeorm.repository(UserEntity, kShared)]))

    await di.init()

    // Same ambiguity as above, resolved the way the container resolves every other one.
    expect(fake(di.get(Users).users).source).toEqual('b')
  })

  it('should yield undefined for an optional repository when no DataSource is bound', async function () {
    class MaybeUsers {
      constructor(readonly users: Repository<User> | undefined) {}
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(MaybeUsers, t => t.toClass(MaybeUsers, [$i.optional($typeorm.repository(UserEntity))]))

    await di.init()

    // Composing with `$i.optional` is what the shared descriptor brand buys: the helper is not a special case.
    expect(di.get(MaybeUsers).users).toBeUndefined()
  })

  it('should inject a repository into a property', async function () {
    class PropertyUsers {
      users!: Repository<User>
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(DataSource, t => t.toValue(new FakeDataSource('main').asDataSource()))
    di.bind(PropertyUsers, t => t.toSelf().injectProperty('users', $typeorm.repository(UserEntity)))

    await di.init()

    // The stage runs for a member injection too, which is the path `@Inject($typeorm.repository(...))` takes.
    expect(fake(di.get(PropertyUsers).users).source).toEqual('main')
  })
})
