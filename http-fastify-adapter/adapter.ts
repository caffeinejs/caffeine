import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterIn, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify'
import { compileHandler } from './adapter_handler_parameters.js'
import { kConfig, kCORS } from './decorators/keys/keys.js'

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

    for (const router of routers) {
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
          }

          // Config
          const config: Record<string | symbol, unknown> = {}

          // CORS
          const cors = router.binding.tags.get(kCORS) ?? {}
          if (typeof cors !== 'undefined') {
            config.cors = cors
          }

          // Additional Configuration Entries
          const { config: extras, override } = router.binding.tags.get(kConfig) ?? {} as any
          if (extras !== undefined) {
            for (const [k, v] of Object.entries(extras)) {
              if (Object.hasOwn(config, k)) {
                if (override) {
                  config[k] = v
                }
              } else {
                config[k] = v
              }
            }
          }

          server.route({
            method: [...new Set(route.method.map(m => m.toUpperCase()))],
            url: joinPaths(basePath, route.path),
            schema: route.schema as FastifySchema,
            bodyLimit: route.bodyLimit ?? router.bodyLimit,
            handlerTimeout: route.timeout ?? router.timeout,
            config,
            handler: function (req, res) {
              if (router.header) {
                for (const [k, v] of router.header) {
                  res.header(k, v)
                }
              }

              if (route.header) {
                for (const [k, v] of route.header) {
                  res.header(k, v)
                }
              }

              if (route.contentType) {
                res.type(route.contentType)
              }

              if (route.statusCode !== undefined) {
                res.code(route.statusCode)
              }

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

  get instance(): SERVER {
    return this.#fastify
  }

  async fetch(input: string | URL | Request, options?: RequestInit): Promise<Response> {
    let request: Request

    if (input instanceof Request) {
      request = input
    } else {
      if (typeof input === 'string') {
        if (input.startsWith('/')) {
          input = 'http://localhost' + input
        }
      }

      request = new Request(input, options)
    }

    const body = await request.arrayBuffer()
    const payload = body.byteLength > 0 ? Buffer.from(body) : undefined

    // light-my-request computes content-length from the payload itself;
    // passing the original value causes a mismatch
    request.headers.delete('content-length')

    return new Promise<Response>((resolve, reject) => {
      void this.#fastify.inject(
        {
          method: request.method as any,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          payload,
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
            statusText: result.statusMessage,
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
