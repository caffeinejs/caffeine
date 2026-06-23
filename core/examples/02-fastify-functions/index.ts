import { buildServer } from './app.js'
import { catsRoutes } from './cats/cats.routes.js'
import { createContainer } from './dependencies.js'

const container = createContainer()
const { server } = await buildServer({ logger: true }, container, catsRoutes)

await server.listen({ port: 3000, host: '0.0.0.0' })
