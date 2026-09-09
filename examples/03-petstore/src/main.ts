import 'dotenv/config'
import { createContainer } from './app.container.js'
import { buildApp } from './app.js'

const app = buildApp(await createContainer())

// The Prisma handle disconnects itself on container dispose — see `PrismaConfig` — which the framework runs
// after the drain delay and after the server has stopped.

// No signal handling here. `.shutdown()` installs SIGTERM/SIGINT, refuses readiness, waits out the
// routing-table lag while still serving, closes the server, and lets the process exit on its own — calling
// process.exit() straight after close() would truncate the very logs describing the shutdown.
await app.run()
