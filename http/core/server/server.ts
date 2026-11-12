import type { AsyncLocalStorage } from 'node:async_hooks'

import { ConfigStore } from '@caffeinejs/application/config'
import { runGuards } from '@caffeinejs/application/framework'
import type { Logger } from '@caffeinejs/application/logger'
import type { Container, Ctor } from '@caffeinejs/di'
import { formatDuration, type Duration } from '@caffeinejs/std/duration'

import { stripBasePath } from '../../base_path.js'
import { kRouteConstraints } from '../constraints/keys.js'
import { kCSRFRoute } from '../csrf/route.js'
import { problemEncoder } from '../error/encode.js'
import { ErrorHandlerProvider } from '../error/handler.js'
import { ErrHTTPNotFound, ErrHTTPServiceUnavailable } from '../error/http.js'
import { kErrorHandlingOptions } from '../error/keys.js'
import { httpGuardDenial, type GuardContext, type GuardTarget } from '../guards/guard.js'
import { andThen, callbackEntry, isThenable, runHooks, type HookEntry } from '../lifecycle/lifecycle.js'
import { ErrRouteConflict, type RouteMatch, type RouteMatcher } from '../matcher/matcher.js'
import { routeRecord, type RouteRecord } from '../routing/inventory.js'
import { joinPaths, pathsOf } from '../routing/paths.js'
import type { IRoute, IRouteGroup } from '../routing/route.js'
import { answer, byteLength, connectionFields } from './answer.js'
import { Context, type ServerShared } from './context.js'
import { answerError, asError, configurationError, defaultProblem, USE_FASTIFY } from './error.js'
import type { FetchContextPlatform } from './fetch.js'
import { engineCompilers } from './parameters.js'
import type { SendPayload, ServerPlatform } from './platform.js'
import { isTimeout, MAX_TIMEOUT, type ResolvedServerSettings } from './settings.js'

/** What one route resolves to in the matcher. A miss resolves to the server's not-found store. */
export interface RouteStore {
  readonly route: IRoute<Context> | undefined
  readonly group: IRouteGroup<Context> | undefined
  readonly handle: (req: Context, res: Context) => unknown
  /** The group's `onRequest`, then its guards. */
  readonly onRequest: readonly HookEntry<Context>[]
  readonly headers: readonly (readonly [string, string | string[]])[]
  readonly contentType: string | undefined
  readonly status: number | undefined
  /** The route's `@Timeout`, else the server's `handlerTimeout`. */
  readonly timeout: Duration | undefined
  /** The automatic HEAD route of a GET, which replaces `content-length` as Fastify's does. */
  readonly twin: boolean
}

export interface HTTPServerInput {
  readonly routeGroups: readonly IRouteGroup<Context>[]
  readonly settings: ResolvedServerSettings
  readonly basePath: string | undefined
  readonly container: Container
  readonly storage: AsyncLocalStorage<Context>
  readonly logger: Logger
}

const EMPTY_PARAMS: Readonly<Record<string, string | undefined>> = Object.freeze({})

const CLOSED_BODY = 'Service Unavailable'

/** One server of the engine: its routes, and the pipeline every request of every platform goes through. */
export class HTTPServer {
  /** Every route as it registered, for the inventory. */
  readonly routes: readonly RouteRecord[]

  readonly #shared: ServerShared
  readonly #matcher: RouteMatcher<RouteStore>
  readonly #notFound: RouteStore
  readonly #basePath: string | undefined
  readonly #container: Container
  readonly #storage: AsyncLocalStorage<Context>

  /** How to cut each request still in flight: abort its handler, or its answer once it has one. */
  readonly #inFlight = new Set<(reason: Error) => void>()
  #ids = 0
  #count = 0
  #closing = false
  #closed = false
  #cutting = false
  #drained: Promise<void> | undefined
  #resolveDrained: (() => void) | undefined

  /**
   * @throws ErrConfiguration for a route the engine cannot serve yet.
   * @throws ErrRouteConflict for a method and path taken twice.
   */
  constructor(input: HTTPServerInput) {
    const { container, settings } = input
    const options = container.get(kErrorHandlingOptions)

    this.#shared = {
      store: container.get(ConfigStore),
      logger: input.logger,
      errors: container.get(ErrorHandlerProvider),
      options,
      encodeProblem: problemEncoder(options),
    }
    this.#basePath = input.basePath
    this.#container = container
    this.#storage = input.storage
    this.#matcher = settings.matcher<RouteStore>(settings.router)
    this.#notFound = {
      route: undefined,
      group: undefined,
      handle: ctx => {
        throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
      },
      onRequest: [],
      headers: [],
      contentType: undefined,
      status: undefined,
      timeout: undefined,
      twin: false,
    }
    this.routes = this.#register(input.routeGroups, settings)
  }

  /**
   * Serves one request on `platform`.
   *
   * @param drainAtRespond - Stop counting the request toward {@link close} once its answer is handed back, rather than
   *   when it has left: `request()`'s, whose body a test may never read.
   */
  serve<R>(
    platform: ServerPlatform<Request, FetchContextPlatform, R>,
    native: Request,
    extra: unknown,
    drainAtRespond = false,
  ): R | Promise<R> {
    // The container may be disposed by now: answer without it.
    if (this.#closed) {
      return platform.respond(
        native,
        {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(CLOSED_BODY.length) },
        },
        CLOSED_BODY,
      )
    }

    this.#count++
    const id = ++this.#ids

    let ctx: Context | undefined
    let answered: { readonly value: R } | undefined
    let scopeRelease: (() => void) | undefined
    let finished = false
    let uncounted = false
    let fail: ((reason: Error) => void) | undefined

    // A forced close cuts the request as Fastify's destroys its socket: an answer being sent fails its reader, and a
    // request not yet answered fails its caller and aborts its handler, whose late result then goes nowhere.
    const cut = (reason: Error): void => {
      if (answered !== undefined) {
        platform.cancel(native, answered.value, reason)
        return
      }

      ctx?.expire()
      ctx?.markResponded()
      ctx?.abort(reason)
      fail?.(reason)
    }
    const uncount = (): void => {
      if (!uncounted) {
        uncounted = true
        this.#count--
        this.#settleDrain()
      }
    }
    const finish = (): void => {
      if (finished) {
        return
      }

      finished = true
      scopeRelease?.()
      this.#inFlight.delete(cut)
      uncount()
      this.#settleDrain()
    }

    this.#inFlight.add(cut)

    try {
      const method = platform.method(native)
      const target = platform.target(native)
      const stripped = this.#basePath === undefined ? undefined : stripBasePath(target, this.#basePath)
      const url = stripped ?? target
      const seenBase = stripped === undefined ? '' : this.#basePath!

      let failure: Error | undefined
      let match: RouteMatch<RouteStore> | null = null

      if (this.#closing) {
        failure = new ErrHTTPServiceUnavailable('The server is closing')
      } else {
        try {
          match = this.#matcher.match(method, url, undefined)
        } catch (err) {
          failure = asError(err)
        }
      }

      const store = match?.store ?? this.#notFound
      const current = new Context(
        this.#shared,
        platform,
        native,
        extra,
        id,
        method,
        url,
        seenBase,
        match?.params ?? EMPTY_PARAMS,
        match?.query ?? queryAfter(url),
      )
      ctx = current

      const pipeline = new Pipeline<R>(this.#shared, platform, native, current, store, {
        finish,
        uncountEarly: drainAtRespond ? uncount : undefined,
        keep: value => {
          answered = { value }
        },
      })

      let result!: R | Promise<R>
      let thrown: { readonly err: unknown } | undefined

      this.#storage.run(current, () => {
        this.#container.requestScopeManager
          .run(
            () =>
              new Promise<void>(release => {
                scopeRelease = release

                // A throw in a promise's executor would only reject this promise, so it is kept and thrown below.
                try {
                  result = pipeline.run(failure)
                } catch (err) {
                  thrown = { err }
                }
              }),
          )
          .catch((err: unknown) =>
            this.#shared.logger.error({ reqId: current.req.id, err }, 'Cannot tear down the request scope'),
          )
      })

      if (thrown !== undefined) {
        throw thrown.err
      }

      if (!isThenable(result)) {
        return result
      }

      const pending = result
      return new Promise<R>((resolve, reject) => {
        fail = reject
        Promise.resolve(pending).then(resolve, reject)
      }).then(undefined, (err: unknown) => {
        finish()
        throw err
      })
    } catch (err) {
      finish()
      throw err
    }
  }

  /**
   * Answers 503 from now on; resolves once every request in flight has been answered and, on `fetch`, its body has
   * been sent.
   */
  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve()
    }

    this.#closing = true
    this.#drained ??= new Promise<void>(resolve => {
      this.#resolveDrained = resolve
    })
    this.#settleDrain()

    return this.#drained.then(() => {
      this.#closed = true
    })
  }

  /**
   * Cuts every answer still being sent; fails every request not yet answered with an `ErrHTTPServiceUnavailable` and
   * aborts its handler's signal; settles {@link close}; and answers the plain 503 from then on.
   */
  forceClose(): void {
    this.#closing = true
    this.#closed = true

    const reason = new ErrHTTPServiceUnavailable('The server was closed')
    for (const cut of [...this.#inFlight]) {
      cut(reason)
    }

    this.#resolveDrained?.()
  }

  // Once nothing counts toward the drain, what is still in flight is an in-process answer nobody read: it is cut, so its
  // request scope ends before the container does, and the drain settles as the last one finishes.
  #settleDrain(): void {
    if (!this.#closing || this.#count > 0) {
      return
    }

    if (this.#inFlight.size === 0) {
      this.#resolveDrained?.()
      return
    }

    if (!this.#cutting) {
      this.#cutting = true
      const reason = new ErrHTTPServiceUnavailable('The server was closed')
      for (const cut of [...this.#inFlight]) {
        cut(reason)
      }
    }
  }

  #register(groups: readonly IRouteGroup<Context>[], settings: ResolvedServerSettings): RouteRecord[] {
    const registered: Array<{
      readonly route: IRoute<Context>
      readonly group: IRouteGroup<Context>
      readonly methods: string[]
      readonly url: string
    }> = []
    const twins: Array<{ readonly store: RouteStore; readonly paths: readonly string[]; readonly methods: string[] }> =
      []

    for (const group of groups) {
      for (const route of group.routes) {
        const methods = [...new Set(route.method.map(method => method.toUpperCase()))]
        const paths = pathsOf(group.prefix, joinPaths(group.path, route.path), settings.router.ignoreTrailingSlash)

        assertServable(route, methods, paths[0])

        const store = storeOf(group, route, settings.handlerTimeout)

        for (const method of methods) {
          for (const path of paths) {
            this.#matcher.add(method, path, undefined, store)
          }
        }

        registered.push({ route, group, methods, url: paths[0] })

        if (methods.includes('GET')) {
          twins.push({ store: { ...store, twin: true }, paths, methods })
        }
      }
    }

    // After every explicit route, so an explicit HEAD route wins whichever was declared first.
    for (const twin of twins) {
      let served = false

      for (const path of twin.paths) {
        try {
          this.#matcher.add('HEAD', path, undefined, twin.store)
          served = true
        } catch (err) {
          if (!(err instanceof ErrRouteConflict)) {
            throw err
          }
        }
      }

      if (served && !twin.methods.includes('HEAD')) {
        twin.methods.push('HEAD')
      }
    }

    return registered.map(({ route, group, methods, url }) => routeRecord(route, group, methods, url))
  }
}

/** What the request path calls back into the server for. */
interface PipelineHooks<R> {
  /** Releases the request scope and the drain count, once. */
  readonly finish: () => void
  /** For `request()`: stops counting toward `close()` at respond. */
  readonly uncountEarly: (() => void) | undefined
  /** Keeps the answer, so a forced close can cut it. */
  readonly keep: (answer: R) => void
}

/** One request through the engine: hooks, handler and answer, then respond, with no `async` function on the way. */
class Pipeline<R> {
  readonly #shared: ServerShared
  readonly #platform: ServerPlatform<Request, FetchContextPlatform, R>
  readonly #native: Request
  readonly #ctx: Context
  readonly #store: RouteStore
  readonly #hooks: PipelineHooks<R>

  constructor(
    shared: ServerShared,
    platform: ServerPlatform<Request, FetchContextPlatform, R>,
    native: Request,
    ctx: Context,
    store: RouteStore,
    hooks: PipelineHooks<R>,
  ) {
    this.#shared = shared
    this.#platform = platform
    this.#native = native
    this.#ctx = ctx
    this.#store = store
    this.#hooks = hooks
  }

  run(failure: Error | undefined): R | Promise<R> {
    if (failure !== undefined) {
      return this.#errorThenRespond(failure)
    }

    let work: void | PromiseLike<void>

    try {
      work = this.#work()
    } catch (err) {
      return this.#errorThenRespond(err)
    }

    return isThenable(work) ? this.#settle(work) : this.#respond()
  }

  // Hooks, the route's statics, then the handler and its answer.
  #work(): void | PromiseLike<void> {
    const ctx = this.#ctx
    const store = this.#store

    return andThen(runHooks(store.onRequest, ctx), () => {
      if (ctx.sent) {
        return
      }

      for (const [name, value] of store.headers) {
        if (typeof value === 'string') {
          ctx.header(name, value)
        } else {
          for (const item of value) {
            ctx.appendHeader(name, item)
          }
        }
      }

      if (store.contentType !== undefined) {
        ctx.header('content-type', store.contentType)
      }

      if (store.status !== undefined) {
        ctx.status(store.status)
      }

      const result = store.handle(ctx, ctx)

      // What the handler settles with once its timeout fired is dropped: the 503 stands, whoever is writing it.
      return isThenable(result)
        ? Promise.resolve(result).then(settled => (ctx.expired ? undefined : answer(ctx, settled)))
        : answer(ctx, result)
    })
  }

  /**
   * Settles with the first of: the answer through `ctx`, the work settling, the timer. What comes after is logged and
   * dropped.
   */
  #settle(pending: PromiseLike<void>): Promise<R> {
    const ctx = this.#ctx
    const timeout = this.#store.timeout

    return new Promise<R>((resolve, reject) => {
      let done = false
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (next: () => R | Promise<R>): void => {
        if (done) {
          return
        }

        done = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }

        try {
          resolve(next())
        } catch (err) {
          reject(err)
        }
      }

      if (timeout !== undefined) {
        timer = setTimeout(() => {
          const err = new ErrHTTPServiceUnavailable(`The request was not answered within ${formatDuration(timeout)}`)
          timedOut = true
          ctx.expire()
          ctx.abort(err)
          settle(() => this.#errorThenRespond(err))
        }, Math.ceil(timeout))
      }

      ctx.onAnswered(() => settle(() => this.#respond()))

      pending.then(
        () => {
          if (!done) {
            settle(() => this.#respond())
          } else if (timedOut) {
            this.#late()
          }
        },
        (err: unknown) => {
          if (!done) {
            settle(() => this.#errorThenRespond(err))
          } else if (timedOut) {
            this.#late(err)
          } else {
            this.#shared.logger.error({ reqId: ctx.req.id, err }, 'Handler failed after its answer was sent')
          }
        },
      )
    })
  }

  #late(err?: unknown): void {
    this.#shared.logger.error(
      { reqId: this.#ctx.req.id, status: this.#ctx.statusCode, ...(err === undefined ? {} : { err }) },
      'Handler settled after its timeout',
    )
  }

  #errorThenRespond(err: unknown): R | Promise<R> {
    const handled = this.#answerError(asError(err))
    return isThenable(handled) ? Promise.resolve(handled).then(() => this.#respond()) : this.#respond()
  }

  // The error chain, and the default problem for whatever the chain itself throws.
  #answerError(err: Error): void | Promise<void> {
    try {
      const handled = answerError(this.#shared, this.#ctx, this.#store, err)
      return isThenable(handled)
        ? Promise.resolve(handled).then(undefined, failure => this.#lastResort(failure))
        : handled
    } catch (failure) {
      this.#lastResort(failure)
    }
  }

  #lastResort(failure: unknown): void {
    const ctx = this.#ctx
    const err = asError(failure)
    this.#shared.logger.error({ reqId: ctx.req.id, err }, 'Cannot answer an error: answering with the default problem')

    if (ctx.sent) {
      return
    }

    try {
      defaultProblem(this.#shared, ctx, err)
    } catch (again) {
      this.#shared.logger.error({ reqId: ctx.req.id, err: again }, 'Cannot answer with the default problem')
      ctx.status(500)
      ctx.body()
    }
  }

  // Sends what the context holds, under the length rules of Fastify's `reply.send` and HEAD route.
  #respond(): R {
    const ctx = this.#ctx
    const { finish, uncountEarly, keep } = this.#hooks

    if (ctx.responded) {
      return undefined as R
    }

    const headers = ctx.responseHeaders
    const isConnectionField = connectionFields({ get: name => ctx.getHeader(name) ?? null })
    for (const name of Object.keys(headers)) {
      if (isConnectionField(name)) {
        delete headers[name]
      }
    }

    const status = ctx.statusCode
    const head = ctx.req.method === 'HEAD'
    let payload: SendPayload = ctx.payload ?? null

    if (payload !== null && status === 204) {
      payload = dropped(payload)
      delete headers['content-length']
      delete headers['content-type']
    } else if (payload !== null && status === 304) {
      const length = lengthOf(payload)
      payload = dropped(payload)
      if (length === undefined) {
        delete headers['content-length']
      } else {
        headers['content-length'] = String(length)
      }
    } else if (status === 205) {
      // A `Response` refuses a body here.
      payload = dropped(payload)
      headers['content-length'] = '0'
    } else if (payload === null) {
      if (status !== 204 && status !== 304 && (!head || this.#store.twin)) {
        headers['content-length'] = '0'
      }
    } else {
      const length = lengthOf(payload)

      if (length !== undefined && (!head || this.#store.twin || headers['content-length'] === undefined)) {
        headers['content-length'] = String(length)
      }

      if (head) {
        payload = dropped(payload)
      }
    }

    ctx.markResponded()

    let sent: R
    try {
      sent = this.#platform.respond(this.#native, { status, headers }, payload)
    } catch (err) {
      this.#shared.logger.error({ reqId: ctx.req.id, err }, 'Cannot send the answer')
      finish()
      throw err
    }

    uncountEarly?.()
    keep(sent)

    return this.#platform.whenSent(this.#native, sent, finish)
  }
}

/**
 * Refuses what the engine cannot serve yet, at start-up rather than as a route that quietly never does what it
 * declares.
 */
function assertServable(route: IRoute<Context>, methods: readonly string[], url: string): void {
  const types = new Set(route.parameters.map(parameter => parameter.type))
  const timeout = route.timeout
  const unreadConfig = [...route.config.keys()].filter(key => key !== kCSRFRoute).map(String)

  if (timeout !== undefined && !isTimeout(timeout)) {
    throw configurationError(
      `Cannot serve "${methods.join('|')} ${url}": a @Timeout of "${String(timeout)}ms" is not a duration above 0 and at most ${formatDuration(MAX_TIMEOUT)}`,
      'Write a positive duration, such as 30 * Second',
    )
  }

  // The first that applies names the refusal.
  const refusals: ReadonlyArray<readonly [boolean, string]> = [
    [
      route.schema !== undefined && Object.values(route.schema).some(slot => slot !== undefined),
      'a request or response schema',
    ],
    [route.bodyAs !== undefined, '@BodyAsBuffer or @BodyAsStream'],
    [route.options.size > 0, `route options ("${[...route.options.keys()].map(String).join('", "')}")`],
    [route.config.has(kRouteConstraints), 'a route constraint'],
    [route.config.has('cache') || route.config.has('cacheInvalidate'), '@CacheControl or @CacheInvalidate'],
    [route.authorization.authorizer != null, 'a protected route, which needs an authentication gate'],
    [types.has('body'), 'reading the body'],
    [types.has('cookie') || types.has('cookie:signed'), 'reading cookies'],
    [types.has('fastify:request') || types.has('fastify:reply'), 'the Fastify request or reply'],
    // A key nothing here reads would be ignored: a plugin's own, such as CORS, that the engine does not run.
    [unreadConfig.length > 0, `route config ("${unreadConfig.join('", "')}")`],
  ]
  const unsupported = refusals.find(([applies]) => applies)?.[1]

  if (unsupported !== undefined) {
    throw configurationError(
      `Cannot serve "${methods.join('|')} ${url}" on the fetch application: ${unsupported} is not supported yet`,
      USE_FASTIFY,
    )
  }
}

function storeOf(
  group: IRouteGroup<Context>,
  route: IRoute<Context>,
  handlerTimeout: Duration | undefined,
): RouteStore {
  const onRequest: HookEntry<Context>[] = []

  const groupHook = group.onRequest
  if (groupHook !== undefined) {
    onRequest.push(callbackEntry<Context>((ctx, done) => groupHook(ctx, ctx, done)))
  }

  const guards = route.guards
  if (guards !== undefined && guards.length > 0) {
    // The same object for every request on this route.
    const target: GuardTarget = { clazz: group.target as Ctor<unknown> | undefined, handler: route.name }

    onRequest.push(
      callbackEntry<Context>((ctx, done) =>
        runGuards(guards, { kind: 'http', context: ctx as unknown as GuardContext, target }, httpGuardDenial, done),
      ),
    )
  }

  return {
    route,
    group,
    handle: route.dispatch(engineCompilers) as (req: Context, res: Context) => unknown,
    onRequest,
    headers: [...route.header],
    contentType: route.contentType || undefined,
    status: typeof route.statusCode === 'number' && route.statusCode > 0 ? route.statusCode : undefined,
    timeout: route.timeout ?? handlerTimeout,
    twin: false,
  }
}

function lengthOf(payload: SendPayload): number | undefined {
  if (typeof payload === 'string') {
    return byteLength(payload)
  }

  return payload instanceof Uint8Array ? payload.byteLength : undefined
}

function queryAfter(url: string): string {
  const at = url.indexOf('?')
  return at === -1 ? '' : url.slice(at + 1)
}

// A body that will not go out: a stream is cancelled, so its source stops.
function dropped(payload: SendPayload): null {
  if (payload instanceof ReadableStream) {
    void payload.cancel().catch(() => undefined)
  }

  return null
}
