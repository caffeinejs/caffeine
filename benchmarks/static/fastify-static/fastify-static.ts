import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const ROOT = process.env.STATIC_ROOT!

// `@fastify/static` on plain Fastify, with the options `@caffeinejs/static` used before its own engine: the reference
// row. `preCompressed` finds the variants beside each file on every request, where the fixture copies them.
const app = Fastify({ logger: false })

await app.register(fastifyStatic, {
  root: ROOT,
  wildcard: false,
  index: false,
  preCompressed: true,
  globIgnore: ['index.html', '**/*.br', '**/*.gz', '.static-variants/**'],
})

app.get('/health', () => ({ ok: true }))

await app.listen({ port: PORT, host: '0.0.0.0' })
