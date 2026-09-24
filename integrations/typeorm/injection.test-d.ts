import type { Ctor, InjectionsFor, ResolveInjection } from '@caffeinejs/di'
import { $i, token } from '@caffeinejs/di'
import type { Repository } from 'typeorm'

import { type Order, OrderEntity, type User, UserEntity } from './_testdata/entities.testkit.js'
import { $typeorm } from './injection.js'
import { dataSourceKey } from './keys.js'

// Stands in for what `@Injectable` and `.toClass` do with their injection list, so a mismatch reports on one
// call rather than on a decorator.
declare function injections<A extends unknown[]>(ctor: Ctor<unknown, A>, deps: [...InjectionsFor<A>]): void

declare function exact<T>(): <U extends T>(value: [T] extends [U] ? U : never) => void

class Users {
  constructor(readonly users: Repository<User>) {}
}

class Orders {
  constructor(readonly orders: Repository<Order>) {}
}

class Both {
  constructor(
    readonly users: Repository<User>,
    readonly orders: Repository<Order>,
  ) {}
}

class MaybeUsers {
  constructor(readonly users: Repository<User> | undefined) {}
}

// The entity's row type reaches the repository: an `EntitySchema<User>` resolves to `Repository<User>`, not
// to `Repository<ObjectLiteral>`.
declare const resolved: ResolveInjection<ReturnType<typeof $typeorm.repository<User>>>
exact<Repository<User>>()(resolved)

// The brand survives the package boundary, which is what makes a third-party helper usable at all.
injections(Users, [$typeorm.repository(UserEntity)])
injections(Orders, [$typeorm.repository(OrderEntity, dataSourceKey('orders'))])
injections(Both, [$typeorm.repository(UserEntity), $typeorm.repository(OrderEntity)])

// It composes with the built-in helpers rather than being a special case.
injections(MaybeUsers, [$i.optional($typeorm.repository(UserEntity))])

// @ts-expect-error - a Repository<User> injection does not satisfy a Repository<Order> parameter
injections(Orders, [$typeorm.repository(UserEntity)])

// A required repository still fills an optional slot: the brand is covariant in what it resolves to, so
// widening is allowed and only narrowing is not.
injections(MaybeUsers, [$typeorm.repository(UserEntity)])

// A bare string is the instance name, folded through `dataSourceKey` — the shorthand for the token above.
injections(Orders, [$typeorm.repository(OrderEntity, 'reports')])

// @ts-expect-error - an unbranded symbol does not name a DataSource
injections(Users, [$typeorm.repository(UserEntity, Symbol('orders'))])

// @ts-expect-error - a token branded for another type does not name a DataSource
injections(Users, [$typeorm.repository(UserEntity, token<User>(Symbol('user')))])
