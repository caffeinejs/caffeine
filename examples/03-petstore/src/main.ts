import 'dotenv/config'
import { createContainer } from './app.container.js'
import { buildApp } from './app.js'
import { prisma } from './util/db/index.js'

const app = buildApp(createContainer())

app.onClose(() => prisma.$disconnect())
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)))
}

// Starts the framework: readies the container, then listens on the address the server feature resolved from
// config (PETSTORE_SERVER__HOST / PETSTORE_SERVER__PORT).
await app.run()
