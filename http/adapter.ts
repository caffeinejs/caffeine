import { Readable } from 'node:stream'
import { Container, Scopes } from '@caffeinejs/di'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RouteGenericInterface, RouteOptions } from 'fastify'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import type { CatchByMap, Router } from './route.js'
import type { Principal } from './security/index.js'
import { compileArgs, compileHandler } from './adapter_handler_parameters.js'
import { kBodyBuffer, kBodyStream } from './decorators/keys/keys.js'
import { FeatureConfigurer, orderConfigurers } from './feature_configurer.js'
import { AuthenticationConfigurer } from './security/auth/authentication_configurer.js'
import { AuthorizationConfigurer } from './security/authz/authorization_configurer.js'
import { OIDCConfigurer } from './security/auth/oidc/oidc_configurer.js'
import { FormBodyConfigurer } from './form/index.js'
import { ErrorHandlingConfigurer } from './error/error_handling_configurer.js'
import { CacheConfigurer } from './cache/cache.js'
import { CacheInvalidateConfigurer } from './cache/cache_invalidate.js'
import { FastifyContext } from './context.js'
import { joinPaths } from './internal/paths/index.js'

// Augmenting Fastify with Caffeine-specific types.
declare module 'fastify' {
  interface FastifyRequest {
    httpContext: FastifyContext
    responseCached: boolean
    controller: Record<string | symbol, unknown> | null
    user: Principal
  }

  interface FastifyContextConfig {
    caffeine?: {
      hasStatus: boolean
      status: number
      hasContentType: boolean
      contentType: string
      hasHeader: boolean
      header: Array<[string, string | string[]]>
      catchBy?: CatchByMap
    }
  }
}

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> implements Adapter<SERVER, REQ> {
  #fastify: SERVER
  #container: Container

  constructor(
    kit: AdapterFactoryIn,
    fastify: SERVER,
  ) {
    this.#fastify = fastify
    this.#container = kit.container
  }

  run(): Promise<void> {
    throw new Error('Method not implemented.')
  }

  async setup(input: AdapterIn<REQ>): Promise<void> {
    const routers = input.routers as Router<REQ>[]
    const fastify = this.#fastify
    const services = input.services

    // Decorating the request
    fastify.decorateRequest<Principal | null>('user', null)
    fastify.decorateRequest('controller', null)
    fastify.decorateRequest('httpContext', null as unknown as FastifyContext)

    fastify.addHook('onRequest', (req, reply, done) => {
      req.httpContext = new FastifyContext(req, reply)
      done()
    })

    const needsRequestScope = routers.some(
      router => this.#container.hasScopeInGraph(router.key, Scopes.REQUEST),
    )

    if (needsRequestScope) {
      const man = this.#container.requestScopeManager
      fastify.addHook('onRequest', (_req, _res, done) => {
        man.run(() => done())
      })
    }

    // Feature configurers: built-in Fastify features + any DI-bound (plugin/user) ones, run in
    // dependency order. Each hooks into the phases below via optional configureServer/Router/Route.
    const configurers = orderConfigurers([
      new ErrorHandlingConfigurer(),
      new FormBodyConfigurer(),
      new AuthenticationConfigurer(),
      new AuthorizationConfigurer(),
      new OIDCConfigurer(),
      new CacheConfigurer(),
      new CacheInvalidateConfigurer(),
      ...this.#container.getManyOptional<FeatureConfigurer>(FeatureConfigurer),
    ])

    for (const configurer of configurers) {
      await configurer.configureServer?.({ server: fastify, container: this.#container, services, routers })
    }

    for (const router of routers) {
      const basePath = router.path
      const routes = router.routes

      fastify.register(async server => {
        const controller = router.controller
        const isSingleton = router.binding.scopeID === Scopes.SINGLETON

        server.decorateRequest('responseCached', false)

        for (const configurer of configurers) {
          await configurer.configureRouter?.({ server, container: this.#container, services, router })
        }

        for (const route of routes) {
          let dispatch: (req: REQ, res: RES) => unknown

          if (router.errorHandlers?.size) {
            const pickArgs = compileArgs(route.parameters)
            const handlerKey = route.handler

            dispatch = async (req, res) => {
              const instance = req.controller!
              const args = await pickArgs(req, res)

              return (instance[handlerKey] as (...args: unknown[]) => unknown).apply(instance, args)
            }
          } else if (isSingleton) {
            const ref = controller.get()
            const refFn = (ref[route.handler] as (...args: unknown[]) => unknown).bind(ref)

            dispatch = compileHandler(route.parameters, refFn)
          } else {
            const handlerKey = route.handler

            dispatch = compileHandler(route.parameters, (...args) => {
              const ctrl = controller.get()
              return (ctrl[handlerKey] as (...args: unknown[]) => unknown).apply(ctrl, args)
            })
          }

          // Route Config
          // https://fastify.dev/docs/latest/Reference/Routes/#config
          const config: Record<string | symbol, unknown> = {}
          if (route.config) {
            for (const [k, v] of route.config) {
              config[k] = v
            }
          }

          // Route Options
          // https://fastify.dev/docs/latest/Reference/Routes/#routes-options
          const options: Record<string | symbol, unknown> = {}
          if (route.options) {
            for (const [k, v] of route.options) {
              options[k] = v
            }
          }

          const status = route.statusCode!
          const hasStatus = typeof status === 'number' && status > 0
          const contentType = route.contentType
          const hasContentType = typeof contentType === 'string' && contentType.length > 0
          const header = [] as Array<[string, string | string[]]>
          if (route.header) {
            for (const [k, v] of route.header) {
              header.push([k, v])
            }
          }
          const hasHeader = header.length > 0

          config.caffeine = {
            hasStatus,
            status,
            hasContentType,
            contentType,
            hasHeader,
            header,
            catchBy: route.catchBy,
          }

          const routeDef: RouteOptions<
            RawServerBase,
            RawRequestDefaultExpression<RawServerBase>,
            RawReplyDefaultExpression<RawServerBase>,
            RouteGenericInterface,
            any
          > = {
            method: [...new Set(route.method.map(m => m.toUpperCase()))],
            url: joinPaths(basePath, route.path),
            schema: route.schema as FastifySchema,
            bodyLimit: route.bodyLimit,
            handlerTimeout: route.timeout,
            config,
            ...options,
            handler: function (req, res) {
              const config = req.routeOptions.config.caffeine

              if (config.hasHeader) {
                for (let i = 0; i < config.header.length; i++) {
                  const item = config.header[i]
                  res.header(item[0], item[1])
                }
              }

              if (config.hasContentType) {
                res.type(config.contentType)
              }

              if (config.hasStatus) {
                res.code(config.status)
              }

              return dispatch(req as REQ, res as RES)
            },
          }

          normalizeRouteDef(routeDef)

          const routeFn = (s: typeof server, def: RouteOptions) =>
            s.route(tidy(def))

          for (const configurer of configurers) {
            await configurer.configureRoute?.({ server, container: this.#container, services, router, route, routeDef })
          }

          // BodyAsBuffer
          // When the route is decorated with @BodyAsBuffer(), the body is read as a raw buffer.
          if (route.extras?.get(kBodyBuffer)) {
            server.register(async innerServer => {
              innerServer.removeAllContentTypeParsers()
              innerServer.addContentTypeParser('*', { bodyLimit: route.bodyLimit }, function (_request, payload, done) {
                const chunks: Buffer[] = []
                payload.on('data', (chunk: Buffer) => chunks.push(chunk))
                payload.on('end', () => done(null, Buffer.concat(chunks)))
                payload.on('error', done)
              })

              routeFn(innerServer, routeDef)
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

              routeFn(innerServer, routeDef)
            })
            continue
          }

          routeFn(server, routeDef)
        }
      }, { prefix: router.prefix })
    }

    await fastify.ready()
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

          // Null-body statuses (204/205/304, plus 1xx) must be constructed with a null body, otherwise
          // the Response constructor throws "Invalid response status code".
          const nullBody = result.statusCode < 200
            || result.statusCode === 204
            || result.statusCode === 205
            || result.statusCode === 304

          resolve(new Response(nullBody ? null : result.rawPayload, {
            status: result.statusCode,
            statusText: result.statusMessage,
            headers: responseHeaders,
          }))
        },
      )
    })
  }
}

// Normalizing all route hooks to arrays to more easily support multiple hooks.

const ROUTE_HOOK_KEYS = [
  'onRequest',
  'preParsing',
  'onSend',
  'onError',
  'onTimeout',
  'onResponse',
  'onRequestAbort',
  'preHandler',
  'preValidation',
] as const satisfies readonly (keyof RouteOptions)[]

function normalizeRouteDef(routeDef: RouteOptions) {
  for (const key of ROUTE_HOOK_KEYS) {
    const hook = routeDef[key]
    routeDef[key] = (hook ? (Array.isArray(hook) ? hook : [hook]) : []) as any
  }
}

function tidy(routeDef: RouteOptions): RouteOptions {
  for (const key of ROUTE_HOOK_KEYS) {
    const hook = routeDef[key]
    if (hook === undefined) {
      continue
    }

    if (Array.isArray(hook)) {
      if (hook.length === 0) {
        routeDef[key] = undefined
        continue
      }

      if (hook.length === 1) {
        routeDef[key] = hook[0] as any
        continue
      }
    }
  }

  return routeDef
}
