import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/core'
import { Adapter, AdapterIn, Router } from '@caffeinejs/http'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify'
import { compileHandler } from './adapter_handler_parameters.js'
import { kBodyBuffer, kBodyStream } from './decorators/keys/keys.js'

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

          // Route Config
          // https://fastify.dev/docs/latest/Reference/Routes/#config
          // This can be user-provided, or framework-level (Eg. @CORS).
          const config: Record<string | symbol, unknown> = {}
          if (router.config) {
            for (const [k, v] of router.config) {
              config[k] = v
            }
          }
          if (route.config) {
            for (const [k, v] of route.config) {
              config[k] = v
            }
          }

          // Route Options
          // https://fastify.dev/docs/latest/Reference/Routes/#routes-options
          // This can be user-provided, or framework-level (Eg. @Compress).
          const options: Record<string | symbol, unknown> = {}
          if (router.options) {
            for (const [k, v] of router.options) {
              options[k] = v
            }
          }
          if (route.options) {
            for (const [k, v] of route.options) {
              options[k] = v
            }
          }

          const routeFn = (s: typeof server) =>
            s.route({
              method: [...new Set(route.method.map(m => m.toUpperCase()))],
              url: joinPaths(basePath, route.path),
              schema: route.schema as FastifySchema,
              bodyLimit: route.bodyLimit ?? router.bodyLimit,
              handlerTimeout: route.timeout ?? router.timeout,
              config,
              ...options,
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

                return dispatch(req as REQ, res as RES)
              },
            })

          // BodyAsBuffer
          // When the route is decorated with @BodyAsBuffer(), the body is read as a raw buffer.
          // We need to register an inner plugin, so we can remove all content type parsers,
          // and add a custom content type parser for the raw body.
          if (route.extras?.get(kBodyBuffer)) {
            server.register(async innerServer => {
              innerServer.removeAllContentTypeParsers()
              innerServer.addContentTypeParser('*', { bodyLimit: route.bodyLimit ?? router.bodyLimit }, function (_request, payload, done) {
                const chunks: Buffer[] = []
                payload.on('data', (chunk: Buffer) => chunks.push(chunk))
                payload.on('end', () => done(null, Buffer.concat(chunks)))
                payload.on('error', done)
              })

              routeFn(innerServer)
            })
            continue
          }

          // BodyAsStream
          if (route.extras?.get(kBodyStream)) {
            server.register(async innerServer => {
              innerServer.removeAllContentTypeParsers()
              innerServer.addContentTypeParser('*', function (_request, payload, done) {
                done(null, Readable.toWeb(payload))
              })

              routeFn(innerServer)
            })
            continue
          }

          routeFn(server)
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
