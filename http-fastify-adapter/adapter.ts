import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterIn, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify'
import { compileHandler } from './adapter_handler_parameters.js'

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> implements Adapter<SERVER, REQ> {
  #fastify: SERVER
  #container: Container

  constructor(container: Container, fastify: SERVER) {
    this.#fastify = fastify
    this.#container = container
  }

  async setup(input: AdapterIn<REQ>): Promise<void> {
    const routers = input.routers as Router<REQ>[]

    const needsRequestScope = routers.some(
      router => this.#container.hasScopeInGraph(router.key, Scopes.REQUEST),
    )

    if (needsRequestScope) {
      const man = this.#container.requestScopeManager
      this.#fastify.addHook('onRequest', (_req, _res, done) => {
        man.run(() => done())
      })
    }

    for (let i = 0; i < routers.length; i++) {
      const router = routers[i]

      const basePath = router.path
      const routes = router.routes

      this.#fastify.register(async server => {
        const controller = router.controller
        const isSingleton = router.binding.scopeId === Scopes.SINGLETON

        for (const route of routes) {
          let dispatch: (req: REQ, res: RES) => unknown

          if (isSingleton) {
            const ref = controller.get()
            const refFn = (ref[route.handler] as (...args: unknown[]) => unknown).bind(ref)
            dispatch = compileHandler(route.parameters, refFn)
          } else {
            const handlerKey = route.handler
            dispatch = compileHandler(route.parameters, (...args) => {
              const inst = controller.get()
              return (inst[handlerKey] as (...args: unknown[]) => unknown).apply(inst, args)
            })
          }

          const respond = (result: unknown, res: RES): unknown => {
            for (const [k, v] of router.header) {
              res.header(k, v)
            }

            for (const [k, v] of route.response.header) {
              res.header(k, v)
            }

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

            // Non-Fetch API response specifics.

            if (route.response.status !== undefined) {
              res.code(route.response.status)
            }

            return result
          }

          server.route({
            method: [...new Set(route.method.map(m => m.toUpperCase()))],
            url: joinPaths(basePath, route.path),
            schema: route.schema as FastifySchema,
            bodyLimit: route.bodyLimit ?? router.bodyLimit,
            handlerTimeout: route.timeout ?? router.timeout,
            handler: function (req, res) {
              const result = dispatch(req as REQ, res as RES)
              if (result instanceof Promise) {
                return result.then(r => respond(r, res as RES))
              }

              return respond(result, res as RES)
            },
          })
        }
      }, { prefix: router.prefix })
    }

    await this.#fastify.ready()
  }

  async teardown(): Promise<void> {
    await this.#fastify.close()
  }

  server(): SERVER {
    return this.#fastify
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const buffer = await request.arrayBuffer()

    const headers = Object.fromEntries(request.headers)
    // light-my-request computes content-length from the payload itself;
    // passing the original value causes a mismatch
    delete headers['content-length']

    return new Promise<Response>((resolve, reject) => {
      void this.#fastify.inject(
        {
          // @ts-expect-error — request.method is string; light-my-request expects its own HTTPMethods union but all valid HTTP methods are accepted at runtime
          method: request.method,
          url: url.pathname + url.search,
          headers,
          payload: buffer.byteLength > 0 ? Buffer.from(buffer) : undefined,
        },
        (err, result) => {
          if (err || !result) {
            reject(err ?? new Error('inject produced no result'))
            return
          }

          const responseHeaders = new Headers()
          for (const [key, value] of Object.entries(result.headers)) {
            if (value === undefined) {
              continue
            }

            if (Array.isArray(value)) {
              for (const v of value) {
                responseHeaders.append(key, String(v))
              }
            } else {
              responseHeaders.set(key, String(value))
            }
          }

          resolve(new Response(result.rawPayload, {
            status: result.statusCode,
            headers: responseHeaders,
          }))
        },
      )
    })
  }
}

function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
}
