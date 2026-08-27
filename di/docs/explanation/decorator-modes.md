# Decorator modes

CaffeineIoC supports three ways to declare dependencies. Choose based on your
TypeScript version, build tooling, and how much you want metadata to be
implicit vs explicit.

---

## ECMAScript stage 3 decorators (recommended)

Standard TC39 decorators, available in TypeScript 5+. No `reflect-metadata`
required. No `experimentalDecorators` flag needed.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "experimentalDecorators": false
  }
}
```

Import from `@caffeinejs/di/decorators`:

```ts
import { Injectable, Lifetime, Scopes } from '@caffeinejs/di/decorators'

@Injectable([Logger, Database])
class UserService {
  constructor(private readonly logger: Logger, private readonly db: Database) {}
}
```

**Trade-off:** You must list dependencies explicitly in the `@Injectable` array.
There is no automatic inference of constructor parameter types.

**Choose this when:** you are starting a new project or can accept the explicit
dependency lists. It is the long-term standard.

---

## Legacy TypeScript decorators with reflect-metadata

Uses TypeScript's `experimentalDecorators` flag and the `reflect-metadata`
polyfill. The compiler emits type metadata for constructor parameters, so CaffeineIoC
can infer dependencies without an explicit list.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Install `reflect-metadata` and import it once at the entry point:

```sh
npm install reflect-metadata
```

```ts
import 'reflect-metadata'
import { Injectable } from '@caffeinejs/di/decorators/legacy'

@Injectable()
class UserService {
  // Logger and Database inferred from the parameter types automatically
  constructor(private readonly logger: Logger, private readonly db: Database) {}
}
```

**Trade-off:** The `reflect-metadata` API is not a TC39 standard and may be
removed in future TypeScript versions. Some bundlers and runtimes handle
`emitDecoratorMetadata` inconsistently.

**Choose this when:** you are migrating an existing codebase that already uses
legacy decorators, or your team relies on implicit injection.

---

## Programmatic (no decorators)

Register bindings directly on the container using the fluent `bind()` API and
module functions. No decorators, no `reflect-metadata`, no TypeScript flags.

```ts
import { CaffeineIoC, type ModuleFn } from '@caffeinejs/di'

const appModule: ModuleFn = di => {
  di.bind(Logger).toSelf()
  di.bind(Database).toAsyncFactory(async () => {
    return connectToDatabase(process.env.DATABASE_URL)
  })
  di.bind(UserService).toClass(UserService, [Logger, Database])
}

const di = new CaffeineIoC({ decorators: false, modules: [appModule] })
await di.init()
```

**Trade-off:** All wiring is centralized. No co-location of dependency
declarations with the class. More verbose for large graphs. No global registry
— you must pass `decorators: false` to prevent the container from scanning for
decorated classes.

**Choose this when:** decorators are not available in your environment, you
prefer centralized explicit configuration, or you are integrating CaffeineIoC into
a library that cannot impose decorator annotations on user code.

---

## Mixing modes

You can mix programmatic bindings with decorator-annotated classes in the same
container. `@Configuration` classes are a common bridge — they are decorators
themselves but they can provide instances of third-party classes that are not
decorated:

```ts
@Configuration([AppConfig])
class InfraConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(Database)
  database(): Database {
    return new PostgresDatabase(this.config.databaseUrl)
  }
}
```

`PostgresDatabase` does not need `@Injectable`. The `@Configuration` class
acts as a factory, keeping third-party constructors free of CaffeineIoC annotations.

---

## Summary

| Mode | TypeScript flag | Explicit deps | Package |
|---|---|---|---|
| Stage 3 decorators | none | yes | `@caffeinejs/di/decorators` |
| Legacy decorators | `experimentalDecorators` + `emitDecoratorMetadata` | no | `@caffeinejs/di/decorators/legacy` |
| Programmatic | none | yes | `@caffeinejs/di` |
