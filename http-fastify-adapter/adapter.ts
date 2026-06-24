import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterFactory, ParameterPickOptions, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyListenOptions, FastifyReply, FastifyRequest, FastifySchema } from 'fastify'
import fp from 'fastify-plugin'
import { FastifyContext } from './context.js'

type Accessor<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>
  = (server: SERVER, req: REQ, res: RES) => unknown

type HandlerFn = (handler: string | symbol) => (...args: unknown[]) => unknown

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> extends Adapter<SERVER, REQ> {
  #fastify: SERVER

  constructor(container: Container, fastify: SERVER, routers: Router<REQ>[]) {
    super(container, routers)
    this.#fastify = fastify
  }

  async ready(): Promise<void> {
    await this.container.init()

    for (let i = 0; i < this.routers.length; i++) {
      const router = this.routers[i]

      const prefix = router.prefix
      const routes = router.routes
      const fpo = { name: `${String(router.key)}`, fastify: '5.x' }

      this.#fastify.register(fp(async server => {
        for (const route of routes) {
          const fn = compile(route.parameters) as (server: SERVER, req: REQ, res: RES) => unknown[]
          const controller = router.controller
          const singleton = router.binding.scopeId === Scopes.SINGLETON
          let handlerFn: HandlerFn

          if (singleton) {
            const ref = controller.get()
            const refFn = ref[route.handler]
            handlerFn = () => (...args: unknown[]) => refFn(...args)
          } else {
            handlerFn = (handler: string | symbol) => (...args: unknown[]) => controller.get()[handler](...args)
          }

          server.route({
            method: route.method,
            url: `${prefix}${route.path}`,
            schema: route.schema as FastifySchema,
            handler: async function (req, res) {
              const result = await handlerFn(route.handler)(...fn(this as SERVER, req as REQ, res as RES))

              // Fetch API Response Support.
              // The response is mapped using Fastify's reply object.
              if (result instanceof Response) {
                res.code(result.status)
                for (const [key, value] of result.headers) {
                  res.header(key, value)
                }

                const stream = result.body
                const body = stream ? Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]) : null

                return res.send(body)
              }

              return result
            },
          })
        }
      }, fpo))
    }

    await this.#fastify.ready()
  }

  instance(): SERVER {
    return this.#fastify
  }

  async listen(opts?: FastifyListenOptions): Promise<string> {
    return this.#fastify.listen(opts)
  }
}

export function fastifyAdapterFactory<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(fastify: SERVER): AdapterFactory<SERVER, REQ, FastifyAdapter<SERVER, REQ, RES>> {
  return (kit, input): FastifyAdapter<SERVER, REQ, RES> =>
    new FastifyAdapter<SERVER, REQ, RES>(kit.container, fastify, input.routers)
}

function compile<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
>(params: ParameterPickOptions<REQ>[]): (server: SERVER, req: REQ, res: RES) => unknown[] {
  const accessors: Accessor[] = params.map(p => {
    const type = p.type
    const field = p.name

    switch (type) {
      case 'body':
        return (_server, req, _res) => req.body
      case 'query':
        if (field) {
          return (_server, req, _res) => (req.query as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.query
        }
      case 'params':
        if (field) {
          return (_server, req, _res) => (req.params as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.params
        }
      case 'header':
        if (field) {
          return (_server, req, _res) => (req.headers as Record<string, unknown>)[field]
        } else {
          return (_server, req, _res) => req.headers
        }
      case 'context':
        return (_server, req, res) => new FastifyContext(req, res)
      default:
        throw new Error(`Invalid parameter type: ${type}`)
    }
  })

  return (server, req, res) => {
    const out = new Array(accessors.length)
    for (let i = 0; i < accessors.length; i++) {
      out[i] = accessors[i](server, req, res)
    }

    return out
  }
}
