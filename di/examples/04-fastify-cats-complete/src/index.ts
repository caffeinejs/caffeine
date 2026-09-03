import { Redis } from 'ioredis'
import { Pool } from 'pg'

import { AppConfig } from './app.config.js'
import { createContainer } from './app.container.js'
import { buildServer } from './app.js'
import { catsRoutes } from './cats/cats.routes.js'
import { kHealthRoutes, kPgPool } from './keys.js'

// The application entrypoint.
// It glues everything, but with minimal application logic.
// Prefer to keep the HTTP server and the container creation separate.
// This facilitates testing.

const container = await createContainer()
await container.init()

const pool = container.get<Pool>(kPgPool)
await pool.query('SELECT 1')
await pool.query(`
  CREATE TABLE IF NOT EXISTS cats (
    id    SERIAL PRIMARY KEY,
    name  TEXT    NOT NULL,
    breed TEXT    NOT NULL,
    age   INTEGER NOT NULL
  )
`)

const redis = container.get(Redis)
await redis.ping()

const config = container.get(AppConfig)

const healthChecks = container.get(kHealthRoutes)

const server = await buildServer(container, {}, catsRoutes, healthChecks)

await server.listen({ port: config.port, host: '0.0.0.0' })
