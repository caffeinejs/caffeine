import { createWebApplication, newRouter } from '@caffeinejs/http'
import type { FastifyInstance } from 'fastify'

import { registerWattChecks } from '../watt.js'

const app = createWebApplication()
  .mount(newRouter().get('/orders', () => [{ id: 1, item: 'espresso' }]))
  // Only other applications reach this one, through the runtime, and Watt stops it after the entrypoint: no
  // routing table has to catch up, so a drain delay would only hold up the shutdown.
  .shutdown(s => s.drainDelay(0))

// Factory mode: Watt calls this and serves the instance it returns — listening on it if this were the entrypoint,
// injecting into it otherwise, with no port at all. `run()` never runs, so nothing else marks the application
// started, and without this line its readiness would never pass.
export async function create(): Promise<FastifyInstance> {
  await app.ready()
  registerWattChecks(app)
  app.availability.markStarted().acceptTraffic()

  return app.instance
}

export async function close(): Promise<void> {
  await app.close()
}
