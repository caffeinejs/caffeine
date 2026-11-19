# @caffeinejs/http-node

The Node server adapter for `@caffeinejs/http`. `adapter: node()` serves the application on a node:http, node:https
or node:http2 server, as `.server(...)` says, and listens once `run()` is called.

```ts
import { createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'

const app = createWebApplication({ adapter: node() }).mount(pets)
await app.run({ port: 3000 })
```

Beside `node`, the package exports the types of what it serves: `NodeAdapter`, `NodeServerSettings` (what
`.server(...)` returns under `node()`), `NodeHTTPServer` (what `app.instance` is) and `NodeResponse`.

```sh
npm install -E @caffeinejs/http @caffeinejs/http-node
```

Documentation: [ai/docs/http.md](https://github.com/caffeinejs/caffeine/blob/main/ai/docs/http.md).

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## License

[MIT](LICENSE)
