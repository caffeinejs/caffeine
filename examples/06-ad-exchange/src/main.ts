import { createContainer } from './app.container.js'
import { buildApp } from './app.js'
import { rootModule } from './root.gen.mod.js'

// The generated module graph is imported here rather than inside createContainer, so nothing but the entry point
// depends on generated code.
const app = buildApp(createContainer(rootModule))

// No signal handling here: `.shutdown()` installs SIGTERM and SIGINT, drains, closes the server, and disposes the
// container, which closes every DSP client and ends the retries still waiting.
const { address } = await app.run()

app.log.info(`Ad exchange listening on ${address.origin}`)
