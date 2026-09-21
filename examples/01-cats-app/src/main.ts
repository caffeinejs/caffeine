import { createContainer } from './app.di.js'
import { createApp } from './app.js'

const app = createApp(await createContainer())

await app.run({ port: 3000, host: '0.0.0.0' })
