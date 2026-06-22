import type { FastifyInstance } from 'fastify'
import { HealthCheck } from './health.js'

export const healthRoutes = (healthChecks: HealthCheck[]) =>
  async (fastify: FastifyInstance) =>
    fastify.get('/health', async (_req, reply) => {
      const results = await Promise.all(healthChecks.map(c => c.check()))
      const status = results.every(r => r.status === 'ok') ? 200 : 503

      return reply.code(status).send({ checks: results })
    })
