import { AdapterFactory } from '@caffeinejs/application'
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { FastifyAdapter, type FastifyAdapterOptions } from './adapter.js'

export function fastifyAdapterFactory<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(fastify: SERVER, options?: FastifyAdapterOptions): AdapterFactory<SERVER, REQ, FastifyAdapter<SERVER, REQ, RES>> {
  return (kit): FastifyAdapter<SERVER, REQ, RES> =>
    new FastifyAdapter<SERVER, REQ, RES>(kit.container, fastify, options)
}
