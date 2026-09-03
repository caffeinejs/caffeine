import { token } from '@caffeinejs/di'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'

export const kPgPool = token<Pool>(Symbol.for('pg.pool'))
export const kHealthRoutes = token<(fastify: FastifyInstance) => Promise<void>>(Symbol.for('health.routes'))
