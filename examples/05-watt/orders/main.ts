import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { OpenAPI, OpenAPIProvider, openapi } from '@caffeinejs/openapi'
import { setOpenapiSchema } from '@platformatic/globals'
import type { FastifyInstance } from 'fastify'

import { registerWattChecks } from '../watt.js'

const app = createWebApplication()
  .install(OpenAPI())
  // Watt's gateway is the one to publish the document, so the application serves no endpoint for it.
  .with(openapi(o => o.info({ title: 'Orders', version: '1.0.0' }).json(false).yaml(false).docs(false)))
  .mount(newRouter().get('/orders', () => [{ id: 1, item: 'espresso' }]))
  // Only other applications reach this one, through the runtime, and Watt stops it after the entrypoint: no
  // routing table has to catch up, so a drain delay would only hold up the shutdown.
  .shutdown(s => s.drainDelay(0))

// Factory mode: Watt calls this and serves the instance it returns — listening on it if this were the entrypoint,
// injecting into it otherwise, with no port at all. `run()` never runs, so nothing else marks the application
// started, and without this line its readiness would never pass.
export async function create(): Promise<FastifyInstance> {
  await app.bootstrap()
  registerWattChecks(app)
  // The document exists once bootstrap() has readied the server.
  setOpenapiSchema(app.container.get(OpenAPIProvider).docs())
  app.availability.markStarted().acceptTraffic()

  return app.instance
}

export async function close(): Promise<void> {
  await app.close()
}
