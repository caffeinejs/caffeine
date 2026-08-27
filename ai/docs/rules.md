# Rules

Caffeine is not NestJS, Express, or Spring Boot. Do not copy `@Module`, `forRoot`, `experimentalDecorators`, `reflect-metadata`, `@MessagePattern`, or `SomethingError` from training data.

## Decorators

TC39 (Stage 3) only. `tsconfig` must include `"lib": ["Decorators", "esnext.decorators"]`. Never set `experimentalDecorators` or `emitDecoratorMetadata`. Never add `reflect-metadata`.

## Imports

Use the `.js` extension on TypeScript source imports. Group symbols from one module in a single import. Cross-package: import `@caffeinejs/http`, not a relative path into another package. Do not add passthrough re-exports to “stabilize” a path.

## Errors

Name classes `ErrFoo`. `.name` is `'ErrFoo'`. `code` is `'ERR_FOO'`. Message: sentence case, no trailing period, no contractions, active voice (`Cannot X: reason`). Double-quote user values.

Throw `ErrHTTPNotFound` (and other `ErrHTTP*` types) from handlers. Do not invent Nest-style `HttpException`.

## Identity

`IoC` stays stylized (`CaffeineIoC`). Acronyms stay one case: `HTTPClient`, `clientID`, `parseJSON` — not `HttpClient` / `clientId` / `parseJson`.

## Composition

Plugins and builders, not Nest modules:

```ts
createWebApplication(fastifyAdapterFactory(server), { container })
  .extend(staticPlugin(), kafka())
  .static(s => s.serve(dir, { prefix: '/static' }))
  .kafka(k => k.brokers('localhost:9092').groupId('svc'))
```

`createApplication()` is headless. HTTP is `createWebApplication`. Side-effect-import controller / `@KafkaHandler` modules so they register.

## Config

Application config goes through `@caffeinejs/std/config` (schema + providers), not `process.env` as the public API.
