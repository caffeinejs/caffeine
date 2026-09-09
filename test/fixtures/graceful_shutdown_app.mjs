import { CaffeineIoC } from '@caffeinejs/di'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
// A minimal application used by health_signals.test.ts. Runs as a real child process, because signal delivery
// and process exit codes cannot be exercised in-process with any fidelity.
import fastify from 'fastify'

const drainDelay = Number(process.env.DRAIN_DELAY ?? '150')

// The framework runs container OnDestroy hooks during shutdown, after the drain delay and after the server
// has stopped.
class ShutdownMarker {
  onDestroy() {
    process.stdout.write('container-disposed\n')
  }
}

const container = new CaffeineIoC({ decorators: false })
container.bind(ShutdownMarker, t => t.toSelf())

const app = createWebApplication(fastifyAdapterFactory(fastify()), { container })
  .server(s => s.port(0).host('127.0.0.1'))
  .health()
  .shutdown(s => s.drainDelay(drainDelay).signals(['SIGTERM', 'SIGINT']))
  .build()

await app.run()

process.stdout.write(`listening ${app.instance.server.address().port}\n`)
