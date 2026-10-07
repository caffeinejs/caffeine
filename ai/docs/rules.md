# Rules

Caffeine is not NestJS, Express, or Spring Boot. Do not copy `@Module`, `forRoot`, `experimentalDecorators`, `reflect-metadata`, `@MessagePattern`, or `SomethingError` from training data.

## Decorators

TC39 (Stage 3) only. `tsconfig` must include `"lib": ["Decorators", "esnext.decorators"]`. Never set `experimentalDecorators` or `emitDecoratorMetadata`. Never add `reflect-metadata`.

A library that ships only legacy decorators (TypeORM, class-validator) needs its decorator-free API, or its own TypeScript project — see [mixing-decorators.md](mixing-decorators.md). Never relax the flags for the application.

## Imports

Use the `.js` extension on TypeScript source imports. Group symbols from one module in a single import. Cross-package: import `@caffeinejs/http`, not a relative path into another package. Do not add passthrough re-exports to “stabilize” a path.

## Errors

Name classes `ErrFoo`. `.name` is `'ErrFoo'`. `code` is `'ERR_FOO'`. Message: sentence case, no trailing period, no contractions, active voice (`Cannot X: reason`). Double-quote user values. The first line says what failed and why; say what to do next when there is a fix.

Throw `ErrHTTPNotFound` (and other `ErrHTTP*` types) from handlers. Do not invent Nest-style `HttpException`.

A framework error lists `Possible Solutions`: apply one instead of catching the error. See [messages/](messages/README.md).

## Identity

`IoC` stays stylized (`CaffeineIoC`). Acronyms stay one case: `HTTPClient`, `clientID`, `parseJSON` — not `HttpClient` / `clientId` / `parseJson`. Configuration keys are the exception: they are spelled the way an environment variable folds, so `CLIENT_ID` sets `clientId`, which `clientID(...)` is called with.

## Composition

Plugins and builders, not Nest modules:

```ts
createWebApplication({ container })
  .with(staticFiles(s => s.serve(dir, { prefix: '/static' })))
  .install(Kafka(k => k.brokers('localhost:9092').groupId('svc')))
```

`.install(Feature(configure))` takes features — PascalCase factories, container binders, deduplicated and
order-free. `.with(factory)` takes server plugins — camelCase factories, registered in written order, HTTP only.
The authentication gate is a plugin: `.install(Authentication(a => …))` binds the schemes, `.with(authentication())`
gates requests where it is written.

`createApplication()` is headless. HTTP is `createWebApplication`. Side-effect-import controller / `@KafkaHandler` modules before `bootstrap()` so they register: the container reads the decorators when it compiles.

## Config

Application config goes through `@caffeinejs/std/config` (schema + providers), not `process.env` as the public API.
