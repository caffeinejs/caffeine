import type { Container } from '@caffeinejs/di'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

import type { CreateCatDTO, UpdateCatDTO } from './cat.js'
import { CatsService } from './cats.service.js'

export type ContainerPluginOptions = { container: Container }

export const catsRoutes: FastifyPluginAsync<ContainerPluginOptions> = async function (fastify, opts) {
  const service = opts.container.get(CatsService)

  fastify.get('/cats', async (_req: FastifyRequest, reply: FastifyReply) => {
    const cats = await service.findAll()

    return reply.code(200).send(cats)
  })

  fastify.get('/cats/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const cat = await service.findOne(Number(req.params.id))
    if (cat === undefined) {
      return reply.code(404).send()
    }

    return reply.code(200).send(cat)
  })

  fastify.post('/cats', async (req: FastifyRequest<{ Body: CreateCatDTO }>, reply: FastifyReply) => {
    const cat = await service.create(req.body)

    return reply.code(201).send(cat)
  })

  fastify.put(
    '/cats/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: UpdateCatDTO }>, reply: FastifyReply) => {
      const cat = await service.update(Number(req.params.id), req.body)
      if (cat === undefined) {
        return reply.code(404).send()
      }

      return reply.code(200).send(cat)
    },
  )

  fastify.delete('/cats/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const removed = await service.remove(Number(req.params.id))
    if (!removed) {
      return reply.code(404).send()
    }

    return reply.code(204).send()
  })
}
