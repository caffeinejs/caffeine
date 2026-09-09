import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
// A minimal application used by health_signals.test.ts. Runs as a real child process, because signal delivery
// and process exit codes cannot be exercised in-process with any fidelity.
import fastify from 'fastify'

const drainDelay = Number(process.env.DRAIN_DELAY ?? '150')

const app = createWebApplication(fastifyAdapterFactory(fastify()))
  .server(s => s.port(0).host('127.0.0.1'))
  .health()
  .shutdown(s => s.drainDelay(drainDelay).signals(['SIGTERM', 'SIGINT']))
  .build()

app.on('application:pre-shutdown', () => {
  process.stdout.write('pre-shutdown\n')
})

app.on('application:shutdown', () => {
  process.stdout.write('shutdown\n')
})

await app.run()

process.stdout.write(`listening ${app.instance.server.address().port}\n`)
