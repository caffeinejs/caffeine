import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import fastifyStatic from '@fastify/static'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const ROOT = process.env.STATIC_ROOT!

// The mount `@caffeinejs/static` registered before its own engine: `spaMount()` with `preCompressed`, the variants
// found beside each file on every request.
const app = createWebApplication()
  .with(() => [
    fastifyStatic,
    {
      root: ROOT,
      wildcard: false,
      index: false,
      preCompressed: true,
      globIgnore: ['index.html', '**/*.br', '**/*.gz'],
    },
  ])
  .mount(newRouter().get('/health', () => ({ ok: true })))

await app.run({ port: PORT, host: '0.0.0.0' })
