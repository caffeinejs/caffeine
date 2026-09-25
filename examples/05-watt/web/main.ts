import { createWebApplication, health, newRouter } from '@caffeinejs/http'
import { getBasePath } from '@platformatic/globals'

import { registerWattChecks } from '../watt.js'

// Every application in a Watt runtime answers the others at `http://<id>.plt.local`, in process.
const routes = newRouter()
  .get('/', () => ({ application: 'web' }))
  .get('/orders', async () => (await fetch('http://orders.plt.local/orders')).json())

// Script mode: the module starts the application exactly as it would outside Watt, which takes over the `listen()`
// inside `run()` and binds the host and port `watt.json` names. The same file runs under plain Node.
const app = createWebApplication()
  // `/livez` on the public port as well: Watt's own `/status` also fails whenever readiness does, so a liveness
  // probe that must not restart the pod over a dependency points here instead.
  .with(health())
  .mount(routes)
  // Served under the `application.basePath` this application's `watt.json` names, `/shop`: Watt hands it over as
  // `/shop/`, and the trailing slash is dropped. Watt types a missing one as `null`, which `.basePath(...)` takes
  // as `undefined`; outside Watt there is none either, and the application serves from `/`.
  .basePath(() => getBasePath({ throwOnMissing: false }) ?? undefined)

await app.ready()
registerWattChecks(app)
await app.run()

// Watt stops a worker by awaiting this, and never sends it a signal: without it, no drain and no `OnDestroy` hook
// would run.
export async function close(): Promise<void> {
  await app.close()
}
