# @caffeinejs/typeorm

TypeORM for Caffeine applications: a feature that owns a `DataSource`, and an injection helper that hands a
controller or service the repository for an entity.

```sh
npm install @caffeinejs/typeorm typeorm
```

## Quick start

Entities are [`EntitySchema`](https://typeorm.io/docs/entity/separating-entity-definition/), not decorated
classes — see [Entities](#entities).

```ts
import { $typeorm, typeorm } from '@caffeinejs/typeorm'

const app = createApplication().with(
  typeorm(t => t.dataSource({ type: 'postgres', url: process.env.DATABASE_URL, entities: [UserEntity] })),
)

@Injectable([$typeorm.repository(UserEntity)])
class Users {
  constructor(private readonly users: Repository<User>) {}

  byEmail(email: string) {
    return this.users.findOneBy({ email })
  }
}
```

The connection is open before `ready()` returns and closed during `close()`, after everything that used it.

## Configuration

`dataSource` takes TypeORM's own `DataSourceOptions`, in full. This package restates none of them, so every
driver option works and a TypeORM upgrade needs no change here. Entities travel in those options.

Settings from the configuration tree arrive the way every feature receives them — the application's callback
reads its own schema and hands the values over:

```ts
app.with(
  typeorm<AppConfig>((t, { config }) =>
    t.dataSource({ type: 'postgres', url: config.app.db.url, entities: [UserEntity] }),
  ),
)
```

## Several databases

An unnamed feature binds its DataSource under TypeORM's `DataSource`. A named one binds under
`dataSourceKey(name)` and nothing else, so the two never contend:

```ts
const app = createApplication()
  .with(typeorm(t => t.dataSource(mainOptions)))
  .with(typeorm('reports', t => t.dataSource(reportsOptions)))

@Injectable([$typeorm.repository(UserEntity), $typeorm.repository(EventEntity, 'reports')])
class Dashboard {
  constructor(
    private readonly users: Repository<User>,
    private readonly events: Repository<Event>,
  ) {}
}
```

The second argument is the instance name, written exactly as it was installed. `dataSourceKey('reports')`
produces the same key and is what you pass when you hold a token rather than a name.

The name is folded into the feature's identity (`typeorm` vs `typeorm:reports`), so installing the same
instance twice throws `ErrFeatureAlreadyInstalled`.

## Providing the DataSource yourself

The feature is optional. A `@Configuration` class works just as well, and `$typeorm.repository` finds it the
same way:

```ts
@Configuration()
class Datasources {
  @OnLifecycle<DataSource>({ destroy: ds => ds.destroy() })
  @ProvidesAsync(DataSource)
  main(): Promise<DataSource> {
    return new DataSource(options).initialize()
  }
}
```

A second DataSource is `@ProvidesAsync(DataSource, kReports)`, which binds it under `kReports` alone — the
name on `@Provides` replaces the key rather than qualifying it. Pass that same token as the second argument
to `$typeorm.repository`. Make it a **symbol** token: a string there is read as an instance name, not as a
key.

## Composing with `$i`

`$typeorm.repository(...)` produces the same kind of value the `$i` helpers do, so it composes with them:

```ts
$i.optional($typeorm.repository(UserEntity)) // Repository<User> | undefined
$i.provide($typeorm.repository(UserEntity)) // Provider<Repository<User>>
```

`$i.allOf` and `$i.mapped` do not: each decides what an injection resolves to, and so does this one, so the
combination throws `ErrConflictingInjectionStages`.

## Entities

Caffeine runs on TC39 decorators, and TypeORM's `@Entity` / `@Column` are TypeScript's legacy ones. The two
cannot compile in one program, so entities are declared with `EntitySchema`:

```ts
export interface User {
  id: number
  email: string
}

export const UserEntity = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String, unique: true },
  },
})
```

Relations name their target by string (`target: 'Address'`), so entity modules never import each other's
values. An application that must keep legacy-decorated entities compiles them as a separate TypeScript
project — see [mixing decorators](../../ai/docs/mixing-decorators.md).

## Start-up errors

Everything this package can detect is decided while the container compiles, so a misconfigured application
fails `ready()` instead of one request at a time.

| Error                         | Cause                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| `ErrNoDataSource`             | A repository injection names a key no DataSource is bound to |
| `ErrNoUniqueDataSource`       | Several DataSources answer to the key and none is `@Primary` |
| `ErrMissingDataSourceOptions` | The configure callback never called `dataSource(...)`        |
