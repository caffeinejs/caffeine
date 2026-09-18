import Fastify, { FastifyInstance, FastifyRequest, FastifyReply, LogController } from 'fastify'

import { FastifyAdapter } from './adapter.js'
import { type AdapterFactory } from './application.js'
import type { FastifyTypes } from './fastify_types.js'

export function fastifyAdapterFactory(): AdapterFactory<FastifyTypes>
export function fastifyAdapterFactory<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(fastify: SERVER): AdapterFactory<FastifyTypes<SERVER, REQ, RES>>
export function fastifyAdapterFactory(instance?: FastifyInstance): AdapterFactory<FastifyTypes> {
  return (kit): FastifyAdapter => {
    // Fastify reads `loggerInstance` while it constructs and exposes no setter afterwards, so this is the only
    // point the application's logger can reach it — hence the instance is built here rather than above, where
    // there is no application yet. A caller who passed their own instance already chose its logger.
    //
    // Request logging stays off: handing the server a logger must not change what an application prints.
    const server =
      instance ??
      Fastify({
        loggerInstance: kit.logger,
        logController: new LogController({ disableRequestLogging: true }),
      })

    return new FastifyAdapter(kit, server as FastifyInstance)
  }
}
