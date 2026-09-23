import 'dotenv/config'
import { createContainer } from './app.container.js'
import { buildApp } from './app.js'
import { rootModule } from './root.gen.mod.js'

// The generated module graph is imported here rather than inside createContainer, so nothing but the entry
// point depends on generated code and a test can build a container from one feature's module.
const app = buildApp(createContainer(rootModule))

// No signal handling here. `.shutdown()` installs SIGTERM/SIGINT, refuses readiness, waits out the
// routing-table lag while still serving, and lets the process exit on its own.
const { address } = await app.run()

if (address !== undefined) {
  app.log.info(`SPA dashboard listening on ${address.origin}`)
  app.log.info('Sign in with admin/admin123 (admin + member) or user/user123 (member)')
}
