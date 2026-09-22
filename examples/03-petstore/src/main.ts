import 'dotenv/config'
import { kConfig } from './app.config.js'
import { createContainer } from './app.container.js'
import { buildApp } from './app.js'
import { rootModule } from './root.gen.mod.js'

// The generated module graph is imported here rather than inside createContainer, so nothing but the entry
// point depends on generated code and a test can build a container from one feature's module.
const app = buildApp(createContainer(rootModule))

// The Prisma handle disconnects itself on container dispose — see `PrismaConfig` — which the framework runs
// after the drain delay and after the server has stopped.

// No signal handling here. `.shutdown()` installs SIGTERM/SIGINT, refuses readiness, waits out the
// routing-table lag while still serving, closes the server, and lets the process exit on its own — calling
// process.exit() straight after close() would truncate the very logs describing the shutdown.
const { address } = await app.run()

if (address !== undefined) {
  app.log.info(`Petstore listening on ${address.origin}`)

  // A wildcard bind prints as 127.0.0.1, but a GitHub sign-in has to start on the callback URL's host: the state
  // cookie is set for the host the browser is on, and GitHub sends the browser back to the callback URL.
  const signIn = new URL(app.container.get(kConfig).auth.github.callbackUrl).origin
  if (signIn !== address.origin) {
    app.log.info(`Open ${signIn} to sign in with GitHub: the state cookie is sent back only to the callback URL's host`)
  }
}
