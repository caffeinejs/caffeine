import { Readable } from 'node:stream'
import qs from 'fast-querystring'
import { Container, Scopes } from '@caffeinejs/di'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RouteGenericInterface, RouteOptions, type FastifyError } from 'fastify'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import type { Router } from './route.js'
import type { AuthenticationOptions } from './security/auth/builder.js'
import { newAnonymousUser, type Principal } from './security/index.js'
import { compileHandler } from './adapter_handler_parameters.js'
import { kBodyBuffer, kBodyStream } from './decorators/keys/keys.js'
import { CacheStore, ETagGenerator } from './cache/types.js'
import { RouteConfigurer } from './route_configurer.js'
import { cacheConfigurer } from './cache/cache.js'
import { cacheInvalidateConfigurer } from './cache/cache_invalidate.js'
import { MemoryCacheStore } from './cache/index.js'
import { FastifyContext } from './context.js'
import { MediaTypes } from './media_types.js'
import { AuthenticationService } from './security/auth/service.js'
import { isOIDCError } from './security/auth/oidc/index.js'

declare module 'fastify' {
  interface FastifyRequest {
    caffeineResponseCached: boolean
    user: Principal
  }
}

export interface FastifyAdapterOptions {
  cache?: {
    store?: CacheStore
    etagGenerator?: ETagGenerator
  }
  configurers?: RouteConfigurer[]
}

export class FastifyAdapter<
  SERVER extends FastifyInstance = FastifyInstance,
  REQ extends FastifyRequest = FastifyRequest,
  RES extends FastifyReply = FastifyReply,
> implements Adapter<SERVER, REQ> {
  #fastify: SERVER
  #container: Container
  #options: FastifyAdapterOptions | undefined

  constructor(
    kit: AdapterFactoryIn,
    fastify: SERVER,
    options?: FastifyAdapterOptions,
  ) {
    this.#fastify = fastify
    this.#container = kit.container
    this.#options = options
  }

  async setup(input: AdapterIn<REQ>): Promise<void> {
    const routers = input.routers as Router<REQ>[]
    const store = this.#options?.cache?.store ?? new MemoryCacheStore()
    const configurers = [...(this.#options?.configurers ?? [])]

    // Global: caffeineContext decoration + hook
    this.#fastify.decorateRequest('caffeineContext', null as unknown as FastifyContext)
    this.#fastify.addHook('onRequest', (req, reply, done) => {
      req.caffeineContext = new FastifyContext(req, reply)
      done()
    })

    // Global: parse application/x-www-form-urlencoded bodies (built-in, no dependency).
    // Inherited by every router scope; the @BodyAsBuffer/@BodyAsStream scopes drop it explicitly.
    this.#fastify.addContentTypeParser(
      MediaTypes.APPLICATION_FORM_URLENCODED,
      { parseAs: 'string', bodyLimit: 1_048_576 },
      formBodyParser,
    )

    // Auth: resolve coordinator and options once; decorate user field once
    let coordinator: AuthenticationService | undefined
    let authOpts: AuthenticationOptions | undefined
    if (input.services.auth.enabled) {
      coordinator = input.services.auth.coordinator
      authOpts = input.services.auth.options
      this.#fastify.decorateRequest<Principal | null>('user', null)
    }

    const anyRouteNeedsAuthz = routers.some(r => r.routes.some(rt => rt.authorization.enabled))
    if (anyRouteNeedsAuthz && !input.services.auth.enabled) {
      throw new Error('Cannot start application: authorization is configured but authentication is not')
    }

    const oidcMeta = input.services.oidc
    if (oidcMeta) {
      const compiledPaths = new Set(
        routers.flatMap(r => r.routes.map(rt => joinPaths(r.path, rt.path))),
      )

      for (const { callbackPath } of oidcMeta.handlers) {
        if (compiledPaths.has(callbackPath)) {
          throw new Error(
            `Cannot start application: OIDC callbackPath "${callbackPath}" conflicts with a registered controller route`,
          )
        }
      }

      this.#fastify.addHook('onReady', async () => {
        if (!this.#fastify.hasRequestDecorator('cookies')) {
          throw new Error(
            'Cannot start application: OIDC authentication requires @fastify/cookie to be registered',
          )
        }
      })

      for (const { callbackPath, handler } of oidcMeta.handlers) {
        this.#fastify.get(callbackPath, async (req, reply) => {
          try {
            await handler.processCallback(req.caffeineContext)
          } catch (e) {
            // The diagnostic detail (state, nonce, signature, token exchange) stays in the
            // logs: every failure mode must look identical to a client probing the callback.
            req.log.error({ err: e }, 'OIDC callback failed')
            const status = isOIDCError(e) ? e.statusCode : 400
            const error = isOIDCError(e) ? e.publicMessage : 'Authentication failed'
            return reply.status(status).send({ error, statusCode: status })
          }
        })
      }
    }

    configurers.push(cacheConfigurer(store, this.#options?.cache?.etagGenerator))
    configurers.push(cacheInvalidateConfigurer(store))

    this.#fastify.setErrorHandler((error, request, reply) => {
      const err = error as FastifyError
      request.log.error({ err }, err.message)
      void reply.status(err.statusCode ?? 500).send({
        error: err.message,
        statusCode: err.statusCode ?? 500,
      })
    })

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
        const isSingleton = router.binding.scopeID === Scopes.SINGLETON

        server.decorateRequest('caffeineResponseCached', false)

        // Auth: one hook per router scope
        if (input.services.auth.enabled && coordinator && authOpts) {
          const schemes = authOpts.defaultAuthenticateScheme
            ? [authOpts.defaultAuthenticateScheme]
            : []

          if (schemes.length > 0) {
            server.addHook('onRequest', async req => {
              let user: Principal | null = null
              for (const scheme of schemes) {
                const result = await coordinator.authenticate(req.caffeineContext, scheme)
                if (result.succeeded) {
                  if (user) {
                    for (const identity of result.ticket!.principal.identities) {
                      user.addIdentity(identity)
                    }
                  } else {
                    user = result.ticket!.principal
                  }
                }
              }
              req.user = user ?? newAnonymousUser()
            })
          }
        }

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

          // Authz: per-route, delegates challenge/forbid to the authentication handler
          if (route.authorization.enabled && route.authorization.authorizer != null) {
            const onRequest = routeDef.onRequest as Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>>
            const authorizer = route.authorization.authorizer

            onRequest.push(async req => {
              const ctx = req.caffeineContext
              const result = await authorizer.authorize(ctx, req.user)
              if (result.ok) {
                return
              }

              if (!ctx.user.authenticated) {
                return coordinator!.challenge(ctx)
              } else {
                return coordinator!.forbid(ctx)
              }
            })
          }

          const routeFn = (s: typeof server, def: RouteOptions) =>
            s.route(tidy(def))

          for (const configurer of configurers) {
            configurer({ server, router, route, routeDef })
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

function formBodyParser(
  _req: FastifyRequest,
  body: string,
  done: (err: Error | null, value?: unknown) => void,
): void {
  try {
    done(null, qs.parse(body))
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400
    done(err as Error)
  }
}

function joinPaths(base: string, path: string): string {
  const joined = `${base}${path}`
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined || '/'
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
