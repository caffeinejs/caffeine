import { Container } from '@caffeine/core'
import { Adaptee, Adapter, AdapterFactory, AdapterIn, ParameterPickOptions } from '@caffeine/http'
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

type Accessor<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply
>
  = (server: SERVER, req: REQ, res: RES) => unknown

export function fastifyAdapterFactory<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply
>(fastify: SERVER): AdapterFactory<REQ, SERVER> {
  return (ctx) => fastifyAdapter<SERVER, REQ, RES>(fastify, ctx.container)
}

export function fastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply
>(fastify: SERVER, container: Container): Adapter<REQ, SERVER> {
  return async function ({ routers }: AdapterIn<REQ>): Promise<Adaptee<SERVER>> {
    for (let i = 0; i < routers.length; i++) {
      const router = routers[i]

      const prefix = router.prefix
      const routes = router.routes
      const fpo = { name: `${String(router.key)}`, fastify: '5.x' }

      fastify.register(fp(async (server, options) => {
        for (const route of routes) {
          const fn = compile(route.parameters) as (server: SERVER, req: REQ, res: RES) => unknown[]
          const controller = router.controller

          server.route({
            method: route.method,
            url: `${prefix}${route.path}`,
            config: {},
            handler: function (req, res) {
              return controller.get()[route.handler](...fn(this as SERVER, req as REQ, res as RES))
            },
          })
        }
      }, fpo))
    }

    await fastify.ready()

    return {
      instance: () => fastify
    }
  }
}

function compile<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply
>(params: ParameterPickOptions<REQ>[]): (server: SERVER, req: REQ, res: RES) => unknown[] {
  const accessors: Accessor[] = params.map(p => {
    const type = p.type
    const field = p.name

    switch (type) {
      case "body":
        return (server, req, res) => req.body
      case "query":
        if (field) return (server, req, res) => (req.query as Record<string, unknown>)[field]
        else return (server, req, res) => req.query
      case "params":
        if (field) return (server, req, res) => (req.params as Record<string, unknown>)[field]
        else return (server, req, res) => req.params
      case "header":
        if (field) return (server, req, res) => (req.headers as Record<string, unknown>)[field]
        else return (server, req, res) => req.headers
      default:
        throw new Error(`Invalid parameter type: ${type}`);
    }
  })

  return (server, req, res) => {
    const out = new Array(accessors.length);
    for (let i = 0; i < accessors.length; i++) {
      out[i] = accessors[i](server, req, res);
    }

    return out;
  };
}
