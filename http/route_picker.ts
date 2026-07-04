import { ParameterPickOptions } from '@caffeinejs/application'
import { FastifyRequest } from 'fastify'

export function fastifyRequest<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:request' }
}

export function fastifyReply<R extends FastifyRequest = FastifyRequest>(): ParameterPickOptions<R> {
  return { type: 'fastify:reply' }
}
