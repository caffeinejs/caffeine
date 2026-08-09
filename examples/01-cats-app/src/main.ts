import './__caffeine__.gen.js'
import { createContainer } from './app.di.js'
import { createApp } from './app.js'

const app = createApp(createContainer())

await app.ready()
await app.instance.listen({ port: 3000, host: '0.0.0.0' })
