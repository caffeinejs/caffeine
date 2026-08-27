# HTTP

Package: `@caffeinejs/http`. Adapter is Fastify.

```ts
import Fastify from 'fastify'
import { createWebApplication, fastifyAdapterFactory, Controller, Get, Post, Params, $p } from '@caffeinejs/http'

@Controller('/examples')
export class ExampleController {
  @Get('/')
  getAll() { return this.list.execute() }

  @Post('/')
  @Params([$p.body()])
  createOne(input: { name: string }) { return this.create.execute(input.name) }
}

const app = createWebApplication(fastifyAdapterFactory(Fastify({ logger: true }))).build()
```

Side-effect-import the controller file from `main.ts` so `@Controller` registers.

- Routes: method decorators (`@Get`, `@Post`, …) on a `@Controller(path)` class. Constructor injection via `@Injectable` / the controller decorator’s dependency list.
- `@Params` / `$p` pick body, params, query — same idea as Kafka `$k`.
- `@Prefix` is a Fastify plugin prefix; `@Controller('/api/pets')` is the URL path, not a 404-scoped `/api` bubble.
- Errors: throw `ErrHTTPNotFound` (etc.). Render with `@Catch(ErrType)` on an `ErrorHandler` class, `{ global: false }` + `@CatchWith`, or a `@Catch` method on the controller. Duplicate global `@Catch` for the same class fails at boot. See [errors.md](errors.md).
- Static: `.extend(staticPlugin()).static(s => s.serve(root, { prefix: '/static' }))`. That serves files. It is not SPA history fallback. Default `@fastify/static` `wildcard: true` will 404 missing files under the prefix, not return `index.html`.
