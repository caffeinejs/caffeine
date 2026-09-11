# DI

Package: `@caffeinejs/di`. Container is `CaffeineIoC`.

- `@Injectable` (and HTTP `@Controller`, Kafka `@KafkaHandler`) register classes. Constructor parameters are injected.
- Bindings: `container.bind(InjectionToken, t => t.toClass(...))` / `t.toValue(...)`; `bind()` returns the container, so calls chain. Named bindings, labels, tags, scopes (`Scopes.SINGLETON`, `Scopes.REQUEST`).
- Features are **plugins** + **builders**, not Nest `Module` / `forRootAsync`. `app.extend(kafka(k => k.brokers(...)))`.
- `createApplication()` for headless; `createWebApplication()` for HTTP. Do not invent a global `AppModule`.
- Files prefixed `_` are private to their directory. Do not import them from another directory.
