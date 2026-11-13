# DI

Package: `@caffeinejs/di`. Container is `CaffeineIoC`.

- `@Injectable` (and HTTP `@Controller`, Kafka `@KafkaHandler`) register classes. Constructor parameters are injected.
- Bindings: `container.bind(InjectionToken, t => t.toClass(...))` / `t.toValue(...)`; `bind()` returns the container, so calls chain. Named bindings, labels, tags, scopes (`Scopes.SINGLETON`, `Scopes.REQUEST`).
- `Scopes.REQUEST` runs on the container's context storage; inject it as `ContextStorage`. Under Node each container gets an `AsyncLocalStorage` of its own, which `container.bindContextStorage(...)` replaces before `init()`. Off Node, register a factory with `bindContextStorageFactory(...)` before constructing the container.
- Features are **container binders** + **builders**, not Nest `Module` / `forRootAsync`. `app.install(Kafka(k => k.brokers(...)))`.
- `createApplication()` for headless; `createWebApplication()` for HTTP. Do not invent a global `AppModule`.
- Files prefixed `_` are private to their directory. Do not import them from another directory.
