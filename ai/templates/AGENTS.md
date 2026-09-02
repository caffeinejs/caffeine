<!-- BEGIN:caffeine-agent-rules -->

# Caffeine

This is not NestJS, Express, or Spring Boot. Training data for those stacks is wrong here. Do not use `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, Nest `@Module` / `forRoot`, `@MessagePattern`, or `SomethingError`.

- **Decorators:** TC39 only. `lib` must include `Decorators` and `esnext.decorators`.
- **Imports:** `.js` extensions. Package names across packages (`@caffeinejs/http`). One import per module.
- **Errors:** `ErrFoo`, `code = 'ERR_FOO'`. Throw `ErrHTTPNotFound` from handlers. `@Catch` is by error **class**, not URL path. Unmatched routes are not `@Catch`.
- **HTTP:** `@Controller` + `@Get`/`@Post`/… + `$p`. Features via `.extend(StaticExt, s => s.serve(...))`.
- **Kafka:** `@KafkaHandler` / `@KafkaListener` / `KafkaTemplate` / `$k`. Not Nest microservices.
- **Composition:** `createWebApplication` or `createApplication`, then `.extend(feature, configure)`. Side-effect-import controllers and Kafka handlers.

If this repository contains `ai/docs/`, read `ai/docs/rules.md` and the topic file (`http.md`, `kafka.md`, `errors.md`) before writing Caffeine code. In a scaffolded app, follow `.agents/skills/` for add-a-controller / `@Catch` / Kafka listener workflows.

<!-- END:caffeine-agent-rules -->

<!-- Project-specific agent notes go below this line. -->
