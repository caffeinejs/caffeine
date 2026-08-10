import fastify, { type FastifyServerOptions } from 'fastify'
import FastifyMultipart from '@fastify/multipart'
import type { Container } from '@caffeinejs/di'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import { JWT_SECRET } from './features/auth/tokens.js'

// Builds the web application from a given container — it never creates one, so tests can pass a
// TestContainer with overridden dependencies. DB-agnostic: no prisma import here.
export function buildApp(container: Container, serverOpts: FastifyServerOptions = {}): WebApplication {
  const server = fastify({ logger: true, routerOptions: { ignoreTrailingSlash: true }, ...serverOpts })
    .addHttpMethod('QUERY', { hasBody: true })
  server.register(FastifyMultipart)

  return createWebApplication(fastifyAdapterFactory(server), { container })
    .authentication(auth => auth.addJWTBearer(o => o.secret(JWT_SECRET)))
    .build()
}
