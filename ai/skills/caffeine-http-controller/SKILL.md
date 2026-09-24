---
name: caffeine-http-controller
description: >-
  Add a Caffeine HTTP controller and routes (@Controller, @Get, @Post, @Args, $p).
  Use when creating REST endpoints, a new controller class, or wiring createWebApplication
  in a Caffeine app. Not Nest @Controller modules.
---

# HTTP controller

Use this skill when adding or changing HTTP routes in Caffeine.

If `ai/docs/http.md` or `ai/docs/rules.md` exist in this repo, read them first.

## Steps

1. Create a class. Decorate with `@Controller('/path')`. Constructor-inject collaborators (use cases, not the Fastify instance).
2. Add method decorators (`@Get('/')`, `@Post('/')`, …). Pick args with `@Args([$p.body()])` / `$p.param('id')` as needed. `$p.user()` is the authenticated principal; wrap any pick in `$p.map(pick, fn)` to reshape it — `$p.map($p.user(), u => u.findFirst('sub')?.value)` for one claim.
3. Side-effect-import the file from `main.ts` (or the app entry) so the decorator runs.
4. `tsconfig` must include `"lib": ["Decorators", "esnext.decorators"]`. Imports use `.js` extensions.
5. Throw `ErrHTTPNotFound` (etc.) for missing resources. Do not use Nest `HttpException`.

## Shape

```ts
import { Controller, Get, Post, Args, $p } from '@caffeinejs/http'

@Controller('/examples')
export class ExampleController {
  constructor(private readonly list: ListExamplesUseCase) {}

  @Get('/')
  getAll() {
    return this.list.execute()
  }

  @Post('/')
  @Args([$p.body()])
  createOne(input: { name: string }) {
    return this.create.execute(input.name)
  }
}
```

App:

```ts
import { createWebApplication } from '@caffeinejs/http'
import './presentation/example.controller.js'

const app = createWebApplication()

await app.run({ port: 3000 })
```

## Verify

Run the app’s `test` / `build` scripts. Hit the new route with `fetch` or the test helper the project already uses.

## Related

- `caffeine-error-handlers` for `@Catch`
- `docs/http.md`, `docs/rules.md`
