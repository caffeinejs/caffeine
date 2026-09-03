import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

import { FastifyAdapter } from './adapter.js'
import { type AdapterFactory } from './application.js'

export function fastifyAdapterFactory(): AdapterFactory<FastifyInstance, FastifyRequest, FastifyAdapter>
export function fastifyAdapterFactory<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(fastify: SERVER): AdapterFactory<SERVER, REQ, FastifyAdapter<SERVER, REQ, RES>>
export function fastifyAdapterFactory(
  instance?: FastifyInstance,
): AdapterFactory<FastifyInstance, FastifyRequest, FastifyAdapter> {
  const server = instance ?? Fastify()

  return (kit): FastifyAdapter => new FastifyAdapter(kit, server)
}
