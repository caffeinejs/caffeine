import 'dotenv/config'
import { createContainer } from './app.container.js'
import { buildApp } from './app.js'
import { prisma } from './util/db/index.js'

const app = buildApp(createContainer())

app.onClose(() => prisma.$disconnect())
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => void app.close().then(() => process.exit(0)))
}

await app.ready()
await app.instance.listen({ port: Number(process.env.PORT) || 9999, host: '0.0.0.0' })
