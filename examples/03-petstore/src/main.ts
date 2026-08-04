import './__caffeine__.gen.js'
import Fastify from 'fastify'
import FastifyMultipart from '@fastify/multipart'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { prisma } from './util/db/prisma.js'
import { JWT_SECRET } from './features/auth/tokens.js'

const fastify = Fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true } })
  .addHttpMethod('QUERY', { hasBody: true })

await fastify.register(FastifyMultipart)

const builder = createWebApplication(fastifyAdapterFactory(fastify))
builder.authentication.addJWTBearer(o => o.secret(JWT_SECRET))
void builder.authorization
const app = builder.build()

app.onClose(() => prisma.$disconnect())
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => app.close().then(() => process.exit(0)))
}

await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
