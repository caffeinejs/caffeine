# @caffeinejs/http

HTTP for CaffeineJS applications, on a web-standards engine: controllers, routes, validation and errors. One
application, `createWebApplication()` from `@caffeinejs/http`, runs on a runtime through a server adapter:
`adapter: node()` from `@caffeinejs/http-node` listens on a node:http, node:https or node:http2 server,
`adapter: bun()` from `@caffeinejs/http/bun` listens with `Bun.serve`, and with no adapter the application answers
`app.fetch` on Deno and workers.

```ts
import { createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'

const app = createWebApplication({ adapter: node() }).mount(pets)
await app.run({ port: 3000 })
```

On Bun, the same application takes `bun()` in place of `node()`:

```ts
import { bun } from '@caffeinejs/http/bun'

const app = createWebApplication({ adapter: bun() }).mount(pets)
```

```sh
npm install -E @caffeinejs/http @caffeinejs/http-node
```

Documentation: [ai/docs/http.md](https://github.com/caffeinejs/caffeine/blob/main/ai/docs/http.md).

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
