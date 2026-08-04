import { Readable } from 'node:stream'
import qs from 'fast-querystring'
import { Container, Scopes } from '@caffeinejs/di'
import { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerBase, RouteGenericInterface, RouteOptions, type FastifyError } from 'fastify'
import type { Adapter, AdapterIn, AdapterFactoryIn } from './application.js'
import type { Router } from './route.js'
import type { AuthenticationOptions } from './security/auth/builder.js'
import { newAnonymousUser, type Principal } from './security/index.js'
import { compileArgs, compileHandler } from './adapter_handler_parameters.js'
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
import { resolveByErrorChain } from './error/error.js'
import { ErrHTTP } from './error/http.js'

// Augmenting Fastify with Caffeine-specific types.
declare module 'fastify' {
  interface FastifyRequest {
    httpContext: FastifyContext
    responseCached: boolean
    controller: Record<string | symbol, unknown> | null
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
    const fastify = this.#fastify

    // Decorating the request
    fastify.decorateRequest<Principal | null>('user', null)
    fastify.decorateRequest('controller', null)
    fastify.decorateRequest('httpContext', null as unknown as FastifyContext)

    fastify.addHook('onRequest', (req, reply, done) => {
      req.httpContext = new FastifyContext(req, reply)
      done()
    })

    // Error Handling
    // --
    const defaultErrorHandler = fastify.errorHandler
    const errorManager = input.services.errorHandling

    // The application-wide error handler. Also the fallback for per-controller (encapsulated)
    // handlers when they do not handle a given error type.
    const globalErrorHandler = async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const err = error instanceof Error ? error : new Error(String(error))
      const handler = errorManager.handlerFor(err)

      if (handler) {
        await handler.get().handle(request.httpContext, err)
        // The handler renders via ctx; finalize defensively so the request never hangs if it did not.
        if (!reply.sent) {
          return reply.send()
        }

        return
      }

      if (err instanceof ErrHTTP) {
        reply.status(err.statusCode)

        if (err.headers) {
          reply.headers(err.headers)
        }

        const body = err.body !== undefined
          ? err.body
          : { error: err.message, code: err.code, statusCode: err.statusCode, message: err.message }

        return reply.send(body)
      }

      request.log.error({ err }, err.message)

      return defaultErrorHandler(error, request, reply)
    }

    fastify.setErrorHandler(globalErrorHandler)

    // form-urlencoded body parser.
    fastify.addContentTypeParser(
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
    }

    const anyRouteNeedsAuthz = routers.some(r => r.routes.some(rt => rt.authorization.hasProtection))
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

      fastify.addHook('onReady', async () => {
        if (!this.#fastify.hasRequestDecorator('cookies')) {
          throw new Error(
            'Cannot start application: OIDC authentication requires @fastify/cookie to be registered',
          )
        }
      })

      for (const { callbackPath, handler } of oidcMeta.handlers) {
        fastify.get(callbackPath, async (req, reply) => {
          try {
            await handler.processCallback(req.httpContext)
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

    const needsRequestScope = routers.some(
      router => this.#container.hasScopeInGraph(router.key, Scopes.REQUEST),
    )

    if (needsRequestScope) {
      const man = this.#container.requestScopeManager
      fastify.addHook('onRequest', (_req, _res, done) => {
        man.run(() => done())
      })
    }

    for (const router of routers) {
      const basePath = router.path
      const routes = router.routes

      fastify.register(async server => {
        const controller = router.controller
        const isSingleton = router.binding.scopeID === Scopes.SINGLETON

        server.decorateRequest('responseCached', false)

        // Error Handling (per-controller @Catch methods)
        // --
        // When the controller declares @Catch methods, resolve its instance once per request in an
        // onRequest hook (inside the live request scope) and install an encapsulated setErrorHandler.
        // The handler runs the matching @Catch method on that same instance — correct for transient
        // scope (no second get()) — and covers every phase in the plugin (validation, hooks, handler).
        // Unmatched errors delegate to the app-wide globalErrorHandler.
        if (router.errorHandlers?.size) {
          const ref = isSingleton ? controller.get() : null
          const errorHandlers = router.errorHandlers

          server.addHook('onRequest', (req, _res, done) => {
            req.controller = (ref ?? controller.get()) as Record<string | symbol, unknown>
            done()
          })

          server.setErrorHandler(async (error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
            const err = error instanceof Error ? error : new Error(String(error))
            const instance = req.controller
            const methodKey = instance ? resolveByErrorChain(errorHandlers, err) : undefined

            if (instance && methodKey) {
              const handle = instance[methodKey] as (...args: unknown[]) => unknown
              await handle.apply(instance, [req.httpContext, err])
              if (!reply.sent) {
                await reply.send()
              }

              return
            }

            return globalErrorHandler(error, req, reply)
          })
        }

        // Auth: one hook per router scope
        if (input.services.auth.enabled && coordinator && authOpts) {
          const schemes = authOpts.defaultAuthenticateScheme
            ? [authOpts.defaultAuthenticateScheme]
            : []

          if (schemes.length > 0) {
            server.addHook('onRequest', async req => {
              let user: Principal | null = null
              for (const scheme of schemes) {
                const result = await coordinator.authenticate(req.httpContext, scheme)
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
          if (route.authorization.authorizer != null) {
            const onRequest = routeDef.onRequest as Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>>
            const authorizer = route.authorization.authorizer

            onRequest.push(async (req, reply) => {
              const ctx = req.httpContext
              const result = await authorizer.authorize(ctx, req.user)
              if (result.ok) {
                return
              }

              if (!ctx.user.authenticated) {
                await coordinator!.challenge(ctx)
              } else {
                await coordinator!.forbid(ctx)
              }

              // challenge()/forbid() only set status/headers (or a redirect) on the reply; they do
              // not end the request. Finalize here so the route handler is skipped — otherwise the
              // handler runs despite the failed check, and an explicit @Status would overwrite the
              // challenge status. Redirect-based challenges (OIDC/OAuth2) have already sent.
              if (!reply.sent) {
                return reply.send()
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
