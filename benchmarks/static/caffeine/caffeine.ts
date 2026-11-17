import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/node'
import { staticFiles } from '@caffeinejs/static'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const ROOT = process.env.STATIC_ROOT!

// The mount a single-page application writes: the shell left to the application, the hashed bundle pinned.
const app = createWebApplication()
  .with(staticFiles(s => s.serve(ROOT, { unrouted: ['index.html'], anonymous: true, immutable: ['assets/**'] })))
  .mount(new Router().get('/health', () => ({ ok: true })))

await app.run({ port: PORT, host: '0.0.0.0' })
