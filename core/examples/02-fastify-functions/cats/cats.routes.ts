import { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { FastifyRequest } from 'fastify'
import { ContainerPluginOptions } from '../app.js'
import { CATS_REPOSITORY } from '../dependencies.js'
import type { CreateCatDTO, UpdateCatDTO } from './cat.js'
import { CatsRepository } from './cats.repository.js'

export const catsRoutes: FastifyPluginAsync<ContainerPluginOptions> = async function (fastify, opts) {
  const repository = opts.container.get<CatsRepository>(CATS_REPOSITORY)

  async function byId(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const cat = repository.findOne(Number(req.params.id))
    if (cat === undefined) {
      return reply.code(404)
        .send()
    }

    return reply.code(200)
      .send(cat)
  }

  async function all(req: FastifyRequest, reply: FastifyReply) {
    const cats = repository.findAll()

    return reply.code(200)
      .send(cats)
  }

  async function create(req: FastifyRequest<{ Body: CreateCatDTO }>, reply: FastifyReply) {
    const cat = repository.create(req.body)

    return reply.code(201)
      .send(cat)
  }

  async function update(req: FastifyRequest<{ Params: { id: string }, Body: UpdateCatDTO }>, reply: FastifyReply) {
    const cat = repository.update(Number(req.params.id), req.body)

    if (cat === undefined) {
      return reply.code(404)
        .send()
    }

    return reply.code(200)
      .send(cat)
  }

  async function remove(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const removed = repository.remove(Number(req.params.id))

    if (!removed) {
      return reply.code(404)
        .send()
    }

    return reply.code(204)
      .send()
  }

  fastify.get('/cats/:id', byId)
  fastify.get('/cats', all)
  fastify.post('/cats', create)
  fastify.put('/cats/:id', update)
  fastify.delete('/cats/:id', remove)
}
