import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyListenOptions, FastifyReply, FastifyRequest, FastifySchema } from 'fastify'
import fp from 'fastify-plugin'
import { compileParameters } from './adapter_handler_parameters.js'

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

    const needsRequestScope = this.routers.some(
      router => this.container.hasScopeInGraph(router.key, Scopes.REQUEST),
    )

    if (needsRequestScope) {
      const man = this.container.requestScopeManager
      this.#fastify.addHook('onRequest', (_req, _res, done) => {
        man.run(() => done())
      })
    }

    for (let i = 0; i < this.routers.length; i++) {
      const router = this.routers[i]

      const prefix = router.prefix
      const routes = router.routes
      const fpo = { name: `${String(router.key)}`, fastify: '5.x' }

      this.#fastify.register(fp(async server => {
        const controller = router.controller
        const isSingleton = router.binding.scopeId === Scopes.SINGLETON

        for (const route of routes) {
          const fn = compileParameters(route.parameters) as (req: REQ, res: RES) => unknown[]
          let handlerFn: HandlerFn

          if (isSingleton) {
            const ref = controller.get()
            const refFn = ref[route.handler]
            handlerFn = () => (...args: unknown[]) => refFn(...args)
          } else {
            handlerFn = (handler: string | symbol) => (...args: unknown[]) => controller.get()[handler](...args)
          }

          server.route({
            method: [...new Set(route.method.map(m => m.toUpperCase()))],
            url: `${prefix}${route.path}`,
            schema: route.schema as FastifySchema,
            bodyLimit: route.bodyLimit ?? router.bodyLimit,
            handlerTimeout: route.timeout ?? router.timeout,
            handler: async function (req, res) {
              const result = await handlerFn(route.handler)(...fn(req as REQ, res as RES))

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

              if (route.response.status !== undefined) {
                res.code(route.response.status)
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
