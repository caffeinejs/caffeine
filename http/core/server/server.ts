import { Buffer } from 'node:buffer'

import { ConfigStore } from '@caffeinejs/application/config'
import type { Logger } from '@caffeinejs/application/logger'
import { ContextStorage, ExecutionContext, type Container, type ContextKey, type Ctor } from '@caffeinejs/di'
import { formatDuration, type Duration } from '@caffeinejs/std/duration'

import { stripBasePath } from '../../base_path.js'
import { ErrWaitUntilClosed, type ServerContext } from '../../context.js'
import { CACHING_PLUGIN } from '../../plugin_marks.js'
import { compileConstraints, type CompiledConstraints } from '../constraints/derive.js'
import { kCookieSettings } from '../cookie/keys.js'
import { kCookieFlush, kPendingCookies, ServerCookies, type CookieWriter } from '../cookie/server_cookies.js'
import { csrfCoversOf } from '../csrf/csrf.js'
import { problemEncoder } from '../error/encode.js'
import { ErrorHandlerProvider } from '../error/handler.js'
import { ErrHTTPBadRequest, ErrHTTPNotFound, ErrHTTPServiceUnavailable } from '../error/http.js'
import { kErrorHandlingOptions } from '../error/keys.js'
import { newProblem } from '../error/problem.js'
import type { GuardTarget } from '../guards/guard.js'
import type { HookBatch } from '../lifecycle/batch.js'
import {
  asError,
  isThenable,
  runAll,
  runErrorHooks,
  runHooks,
  runSendHooks,
  type HookEntry,
  type SendPayload,
} from '../lifecycle/lifecycle.js'
import { callOnRoute, openDefinition, type RouteDefinition } from '../lifecycle/route_definition.js'
import { findMyWayMatcher, preflightTable, type PreflightTable } from '../matcher/find_my_way.js'
import { ErrRouteConflict, type DerivedConstraints, type RouteMatch, type RouteMatcher } from '../matcher/matcher.js'
import { routeRecord, type RouteRecord } from '../routing/inventory.js'
import { joinPaths, pathsOf } from '../routing/paths.js'
import type { IRoute, IRouteGroup, RouteGroupScope } from '../routing/route.js'
import { assertGated, gateOf } from '../security/gate.js'
import type { CompiledSerializer } from '../validation/validation.js'
import { answer, compileSerializers, connectionFields, HeldStream, NO_SERIALIZER } from './answer.js'
import { Context, kAppendCookies, type ServerShared } from './context.js'
import { answerError, configurationError, defaultProblem, sendProblem } from './error.js'
import { compileLevel, composeRouteHooks, type LevelInput, type StoreHooks } from './hooks.js'
import { compileRouteInput, readInput, type RouteInput } from './input.js'
import { engineCompilers } from './parameters.js'
import type { ContextPlatform, SendHooks, ServerPlatform } from './platform.js'
import { isTimeout, MAX_TIMEOUT, type ResolvedServerSettings } from './settings.js'

/** What one route resolves to in the matcher. A miss resolves to the server's not-found store. */
export interface RouteStore {
  readonly route: IRoute<Context> | undefined
  readonly group: IRouteGroup<Context> | undefined
  readonly handle: (req: Context, res: Context) => unknown
  /** Every hook of the route, in the fixed order, one array per point. */
  readonly hooks: StoreHooks
  /** What `onRoute` was handed; `undefined` for a miss. */
  readonly definition: RouteDefinition | undefined
  readonly headers: readonly (readonly [string, string | string[]])[]
  readonly contentType: string | undefined
  readonly status: number | undefined
  /** The route's `@Timeout`, else the server's `handlerTimeout`. */
  readonly timeout: Duration | undefined
  /** The automatic HEAD route of a GET, which replaces `content-length` as Fastify's does. */
  readonly twin: boolean
  /** How the route reads its body and validates its request; `undefined` for a miss, which reads neither. */
  readonly input: RouteInput | undefined
  /** The serializer an answer of a status is written with, when the route's response schema declares one. */
  readonly serializerFor: (status: number) => CompiledSerializer | undefined
}

export interface HTTPServerInput {
  readonly routeGroups: readonly IRouteGroup<Context>[]
  readonly settings: ResolvedServerSettings
  readonly basePath: string | undefined
  readonly container: Container
  /** The slot of each request's frame that holds its context: what the container resolves `Context` from. */
  readonly contextKey: ContextKey<Context>
  readonly logger: Logger
  /** What sits in front of the routes: the server's root level, and each scope's at one path. */
  readonly levels: { readonly root: LevelInput; of(scope: RouteGroupScope): LevelInput }
  /** Whether the platform runs Node middleware: a Node middleware is refused at start-up otherwise. */
  readonly nodeMiddleware: boolean
}

const EMPTY_PARAMS: Readonly<Record<string, string | undefined>> = Object.freeze({})

// The engine's cookie writer, one for every server: a context appends its own lines.
const writeCookies: CookieWriter<Context> = (ctx, lines) => ctx[kAppendCookies](lines)

const CLOSED_BODY = 'Service Unavailable'
// The 503 of a closed server is tracked by no request.
const NO_HOOKS: SendHooks = { sent: () => undefined, cancelWith: () => undefined }

/** One server of the engine: its routes, and the pipeline every request of every platform goes through. */
export class HTTPServer {
  /** Every route as it registered, for the inventory. */
  readonly routes: readonly RouteRecord[]

  readonly #shared: ServerShared
  readonly #matcher: RouteMatcher<RouteStore>
  readonly #constraints: CompiledConstraints
  /** Where a preflight looks its route up once some route is constrained: a table that ignores constraints. */
  readonly #preflight: PreflightTable<RouteDefinition> | undefined
  readonly #notFound: RouteStore
  readonly #basePath: string | undefined
  readonly #container: Container
  readonly #contextKey: ContextKey<Context>
  readonly #storage: ContextStorage | undefined
  readonly #settings: ResolvedServerSettings
  readonly #input: HTTPServerInput
  readonly #root: StoreHooks
  /** Each scope's level, by key then path: one router nested under two parents is one key at two paths. */
  readonly #scoped = new Map<object, Map<string, ScopeLevel>>()
  /** Every batch whose server hooks run on this server: the root's, then each served scope's, once each. */
  readonly #batches = new Set<HookBatch>()

  /** Each request still in flight, to cut: abort its handler, or its answer once it has one. */
  readonly #inFlight = new Set<InFlight>()
  /** Injected answers handed to the caller whose bodies may still need cancelling during shutdown. */
  readonly #unread = new Set<InFlight>()
  /** Stops counting one request toward the drain. */
  readonly #uncountOne = (): void => {
    this.#count--
    this.#settleDrain()
  }
  readonly #settle = (): void => this.#settleDrain()
  #ids = 0
  #count = 0
  #pendingWork = 0
  #closing = false
  #closed = false
  #cutting = false
  #closedOnce: Promise<void> | undefined
  #resolveDrained: (() => void) | undefined

  /**
   * @throws ErrConfiguration for a route the engine cannot serve yet.
   * @throws ErrRouteConflict for a method and path taken twice.
   */
  constructor(input: HTTPServerInput) {
    const { container, settings } = input
    const options = container.get(kErrorHandlingOptions)
    const cookieSettings = container.get(kCookieSettings)

    this.#shared = {
      store: container.get(ConfigStore),
      logger: input.logger,
      trackWork: (work, reqId, open, host) => this.#trackWork(work, reqId, open, host),
      errors: container.get(ErrorHandlerProvider),
      options,
      encodeProblem: problemEncoder(options),
      application: settings.application,
      trustProxy: settings.trustProxy,
      requestIDHeader: settings.requestIDHeader,
      router: settings.router,
      bodyLimit: settings.bodyLimit,
      cookies: cookieSettings.enabled ? ServerCookies.resolve(cookieSettings, container, writeCookies) : undefined,
      routeOf: (method, url) => {
        if (this.#preflight !== undefined) {
          return this.#preflight.match(method, url)
        }

        try {
          const definition = this.#matcher.match(method, url, undefined)?.store.definition
          return definition === undefined ? undefined : [definition]
        } catch (err) {
          // A URL that cannot be decoded names no route.
          if (err instanceof ErrHTTPBadRequest) {
            return undefined
          }
          throw err
        }
      },
    }
    this.#basePath = input.basePath
    this.#container = container
    this.#contextKey = input.contextKey
    // Absent, the request scope fails each request at `enter`, as it did before hooks existed.
    this.#storage = container.getOptional(ContextStorage)
    this.#settings = settings
    this.#input = input
    this.#constraints = compileConstraints(input.routeGroups, settings.constraints)
    // Without a constrained route a preflight finds its route in the matcher itself. The table is find-my-way's: under
    // a matcher of the application's own, a preflight finds only unconstrained routes, and a constrained one goes
    // unanswered.
    this.#preflight =
      this.#constraints.derives && settings.matcher === findMyWayMatcher ? preflightTable(settings.router) : undefined
    this.#matcher = settings.matcher<RouteStore>(settings.router, settings.constraints)
    const root = compileLevel(input.levels.root, settings, input.nodeMiddleware)
    const vary = this.#constraints.vary
    this.#root = vary === undefined ? root : { ...root, onSend: [vary, ...root.onSend] }
    for (const batch of input.levels.root.batches) {
      this.#batches.add(batch)
    }
    this.#notFound = {
      route: undefined,
      group: undefined,
      handle: ctx => {
        throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
      },
      hooks: this.#root,
      definition: undefined,
      headers: [],
      contentType: undefined,
      status: undefined,
      timeout: undefined,
      twin: false,
      input: undefined,
      serializerFor: NO_SERIALIZER,
    }
    this.routes = this.#register(input.routeGroups, settings)
  }

  /**
   * Serves one request on `platform`.
   *
   * @param drainAtRespond - Stop counting the request toward {@link close} once its answer is handed back, rather than
   *   when it has left: `request()`'s, whose body a test may never read.
   */
  serve<N, R>(
    platform: ServerPlatform<N, ContextPlatform, R>,
    native: N,
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
        NO_HOOKS,
      )
    }

    this.#count++
    const id = ++this.#ids

    const flight = new InFlight(
      this.#inFlight,
      this.#uncountOne,
      this.#settle,
      drainAtRespond ? this.#unread : undefined,
      this.#storage,
    )
    this.#inFlight.add(flight)

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
          match = this.#matcher.match(
            method,
            url,
            this.#constraints.derives
              ? this.#constraints.derive({ header: name => platform.header(native, name) })
              : undefined,
          )
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
        store,
        !this.#closing,
      )
      flight.ctx = current
      flight.onResponse = store.hooks.onResponse

      const pipeline = new Pipeline<N, R>(this.#shared, platform, native, current, store, flight, method === 'HEAD')

      // One frame per request, holding its context and its request scope, built from the root so no slot of the caller
      // leaks into it. A request served inside an open request scope is still refused. The scope ends in `sent`, once
      // the answer has left.
      const result = this.#container.requestScopeManager.enter(
        end => {
          flight.scope = end
          // Kept only for what runs after the answer left, outside this continuation.
          if (flight.onResponse.length > 0) {
            flight.frame = this.#storage?.getStore()
          }
          return pipeline.run(failure)
        },
        ExecutionContext.ROOT.with(this.#contextKey, current),
      )

      if (!isThenable(result)) {
        return result
      }

      const pending = result
      return new Promise<R>((resolve, reject) => {
        flight.fail = reject
        Promise.resolve(pending).then(resolve, reject)
      }).then(undefined, (err: unknown) => {
        this.#failed(flight, err)
        throw err
      })
    } catch (err) {
      this.#failed(flight, err)
      throw err
    }
  }

  // A failure that escapes the pipeline. One past respond was logged there, and a forced close's is no failure of the
  // request: both marked the context responded. Anything else, such as a scope that cannot open, is logged here.
  #failed(flight: InFlight, err: unknown): void {
    const ctx = flight.ctx
    if (ctx?.responded !== true) {
      this.#shared.logger.error({ reqId: ctx?.req.id, err }, 'Cannot serve the request')
    }
    flight.sent()
  }

  /** Runs every `onReady`, the root's plugins' first, then each served scope's, in order. */
  async ready(): Promise<void> {
    for (const batch of this.#batches) {
      for (const onReady of batch.onReady) {
        await onReady(batch.kit)
      }
    }
  }

  /**
   * Answers 503 from now on; resolves once every request in flight has been answered and, on `fetch`, its body has
   * been sent, registered work has settled, and every `onClose` has run. Every `onClose` runs; the first that failed rejects.
   */
  close(): Promise<void> {
    // A second call waits for what the first started, `onClose` included.
    if (this.#closedOnce !== undefined || this.#closed) {
      return this.#closedOnce ?? Promise.resolve()
    }

    this.#closing = true
    const drained = new Promise<void>(resolve => {
      this.#resolveDrained = resolve
    })
    this.#closedOnce = drained.then(() => this.#runOnClose())
    this.#settleDrain()
    return this.#closedOnce
  }

  async #runOnClose(): Promise<void> {
    const failures: unknown[] = []

    for (const batch of this.#batches) {
      for (const onClose of batch.onClose) {
        try {
          await onClose(batch.kit)
        } catch (err) {
          this.#shared.logger.error({ err }, 'onClose hook failed')
          failures.push(err)
        }
      }
    }

    if (failures.length > 0) {
      throw failures[0]
    }
  }

  /**
   * Cuts every answer still being sent; fails every request not yet answered with an `ErrHTTPServiceUnavailable` and
   * aborts its handler's signal; settles {@link close}; and answers the plain 503 from then on.
   */
  forceClose(): void {
    this.#closing = true
    this.#closed = true

    const reason = new ErrHTTPServiceUnavailable('The server was closed')
    for (const flight of [...this.#inFlight]) {
      flight.cut(reason)
    }

    this.#resolveDrained?.()
  }

  #trackWork(work: Promise<unknown>, reqId: string, open: boolean, host?: ServerContext['waitUntil']): void {
    let reserved = open && !this.#closed
    if (reserved) {
      this.#pendingWork++
    }

    const release = (): void => {
      if (reserved) {
        reserved = false
        this.#pendingWork--
        this.#settleDrain()
      }
    }
    const observed = this.#outsideRequest(async () => {
      try {
        await work
      } catch (err) {
        this.#logWorkError(reqId, err, 'Background work failed')
      } finally {
        release()
      }
    })

    if (!reserved) {
      throw new ErrWaitUntilClosed()
    }
    try {
      const registration: unknown = host?.(observed)
      if (isThenable(registration)) {
        void this.#outsideRequest(async () => {
          try {
            await registration
          } catch (err) {
            release()
            this.#logWorkError(reqId, err, 'Host rejected background work registration')
          }
        })
      }
    } catch (err) {
      release()
      throw err
    }
  }

  // Both the task and the host's registration can outlive the request scope.
  #outsideRequest(observe: () => Promise<void>): Promise<void> {
    return this.#storage === undefined ? observe() : this.#storage.run(ExecutionContext.ROOT, observe)
  }

  #logWorkError(reqId: string, err: unknown, message: string): void {
    try {
      this.#shared.logger.error({ reqId, err }, message)
    } catch {
      // A failing log transport must not produce an unhandled rejection from the observer.
    }
  }

  // Cut unread in-process bodies as soon as the counted requests finish, even while background work is pending.
  #settleDrain(): void {
    if (!this.#closing || this.#count > 0) {
      return
    }

    if (this.#inFlight.size === 0) {
      if (this.#pendingWork === 0) {
        // Stop admitting requests before another promise callback can enter the closing 503 pipeline.
        this.#closed = true
        this.#resolveDrained?.()
      }
      return
    }

    if (this.#unread.size > 0 && !this.#cutting) {
      this.#cutting = true
      try {
        const reason = new ErrHTTPServiceUnavailable('The server was closed')
        for (const flight of this.#unread) {
          flight.cut(reason)
        }
      } finally {
        this.#cutting = false
      }
    }
  }

  #register(groups: readonly IRouteGroup<Context>[], settings: ResolvedServerSettings): RouteRecord[] {
    const registered: Array<{
      readonly route: IRoute<Context>
      readonly group: IRouteGroup<Context>
      readonly definition: RouteDefinition
      readonly methods: string[]
      readonly url: string
    }> = []
    const twins: Array<{
      readonly store: RouteStore
      readonly paths: readonly string[]
      readonly methods: string[]
      readonly declared: DerivedConstraints | undefined
    }> = []

    for (const group of groups) {
      for (const route of group.routes) {
        const methods = [...new Set(route.method.map(method => method.toUpperCase()))]
        const paths = pathsOf(group.prefix, joinPaths(group.path, route.path), settings.router.ignoreTrailingSlash)

        assertServable(route, methods, paths[0])
        const declared = this.#constraints.of(route, methods, paths[0])

        const store = this.#storeOf(group, route, methods, paths[0], settings)

        for (const method of methods) {
          for (const path of paths) {
            this.#matcher.add(method, path, declared, store)
            this.#preflight?.add(method, path, store.definition!)
          }
        }

        registered.push({ route, group, definition: store.definition!, methods, url: paths[0] })

        if (methods.includes('GET')) {
          twins.push({ store: { ...store, twin: true }, paths, methods, declared })
        }
      }
    }

    // After every explicit route, so an explicit HEAD route wins whichever was declared first.
    for (const twin of twins) {
      let served = false

      for (const path of twin.paths) {
        try {
          this.#matcher.add('HEAD', path, twin.declared, twin.store)
          this.#preflight?.add('HEAD', path, twin.store.definition!)
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

    // Once every gate's `onRoute` has run, and the HEAD twins are in `methods`.
    assertGated(registered)

    return registered.map(({ route, group, definition, methods, url }) =>
      routeRecord(route, group, methods, url, { gate: gateOf(definition)?.label, csrf: csrfCoversOf(definition) }),
    )
  }

  /**
   * One route's store. Everything the route declares is read first; then `onRoute` runs, root plugins' first, then
   * each scope's, outermost first; then the hooks are composed, with what `onRoute` added last.
   */
  #storeOf(
    group: IRouteGroup<Context>,
    route: IRoute<Context>,
    methods: readonly string[],
    url: string,
    settings: ResolvedServerSettings,
  ): RouteStore {
    const guards = route.guards
    const compiled = route.hooks
    // The same object for every request on this route.
    const target: GuardTarget = { clazz: group.target as Ctor<unknown> | undefined, handler: route.name }
    const name = `${methods.join('|')} ${url}`
    const statics = {
      handle: route.dispatch(engineCompilers) as (req: Context, res: Context) => unknown,
      headers: [...route.header],
      contentType: route.contentType || undefined,
      status: typeof route.statusCode === 'number' && route.statusCode > 0 ? route.statusCode : undefined,
      timeout: route.timeout ?? settings.handlerTimeout,
      input: compileRouteInput(route, name, settings),
      serializerFor: compileSerializers(route, name, settings.schemaCompiler),
    }

    const scopes = group.scopes ?? []
    const levels = scopes.map(scope => this.#level(scope))

    const batches = [this.#input.levels.root.batches, ...levels.map(level => level.batches)]
    assertCachingCovered(route, batches, name, settings.application)

    // A copy: the automatic HEAD route is added to `methods` later, and is not one the route declared.
    const open = openDefinition(route, group, Object.freeze([...methods]), url)
    try {
      for (const level of batches) {
        callOnRoute(level, open.definition)
      }
    } finally {
      open.close()
    }

    return {
      route,
      group,
      ...statics,
      hooks: composeRouteHooks({
        root: this.#root,
        scopes: levels.map(level => level.hooks),
        group,
        guards,
        target,
        compiled,
        added: open.added,
      }),
      definition: open.definition as RouteDefinition,
      twin: false,
    }
  }

  // A scope's level at one path, compiled on first use; its batches join the server's once.
  #level(scope: RouteGroupScope): ScopeLevel {
    let byPath = this.#scoped.get(scope.key)
    if (byPath === undefined) {
      byPath = new Map()
      this.#scoped.set(scope.key, byPath)
    }

    let level = byPath.get(scope.path)
    if (level === undefined) {
      const input = this.#input.levels.of(scope)
      level = { hooks: compileLevel(input, this.#settings, this.#input.nodeMiddleware), batches: input.batches }
      byPath.set(scope.path, level)

      for (const batch of input.batches) {
        this.#batches.add(batch)
      }
    }

    return level
  }
}

/** One scope's level at one path: its compiled hooks, and the batches its `onRoute` and server hooks come from. */
interface ScopeLevel {
  readonly hooks: StoreHooks
  readonly batches: readonly HookBatch[]
}

/** One request in flight: what a forced close cuts, and what releases it once its answer has left. */
class InFlight implements SendHooks {
  ctx: Context | undefined
  /** Ends the request scope: set as the request enters it. */
  scope: (() => void | Promise<void>) | undefined
  /** The request's frame, which `onResponse` runs in: set as the request enters its scope. */
  frame: ExecutionContext | undefined
  onResponse: readonly HookEntry<Context>[] = []
  fail: ((reason: Error) => void) | undefined

  readonly #flights: Set<InFlight>
  readonly #uncountOne: () => void
  readonly #settle: () => void
  readonly #unread: Set<InFlight> | undefined
  #cancel: ((reason: Error) => void) | undefined
  #finished = false
  #cutReason: Error | undefined
  #uncounted = false

  readonly #storage: ContextStorage | undefined

  constructor(
    flights: Set<InFlight>,
    uncountOne: () => void,
    settle: () => void,
    unread: Set<InFlight> | undefined,
    storage: ContextStorage | undefined,
  ) {
    this.#storage = storage
    this.#flights = flights
    this.#uncountOne = uncountOne
    this.#settle = settle
    this.#unread = unread
  }

  /**
   * Runs `onResponse`, then releases the request scope and the drain count, once. An arrow: a platform may call it
   * detached.
   */
  readonly sent = (): void => {
    if (this.#finished) {
      return
    }

    this.#finished = true
    this.#unread?.delete(this)
    this.ctx?.markResponded()

    const ran = this.#runOnResponse()
    if (isThenable(ran)) {
      void Promise.resolve(ran).then(() => this.#release())
    } else {
      this.#release()
    }
  }

  // In the request's frame, re-entered: a stream's end fires outside it. A request whose scope never opened has none.
  #runOnResponse(): void | Promise<void> {
    const ctx = this.ctx
    const frame = this.frame

    if (ctx === undefined || frame === undefined || this.#storage === undefined) {
      return
    }

    const entries = this.onResponse
    return this.#storage.run(frame, () =>
      runAll(entries, ctx, err => ctx.logger.error({ reqId: ctx.req.id, err }, 'onResponse hook failed')),
    )
  }

  #release(): void {
    this.#endScope()
    this.#flights.delete(this)

    // Uncounting settles the drain; a request `request()` already uncounted still leaves the in-flight set.
    if (!this.#uncount()) {
      this.#settle()
    }
  }

  cancelWith(cancel: (reason: Error) => void): void {
    if (this.#finished) {
      return
    }
    if (this.#cutReason !== undefined) {
      if (this.#cancel === undefined) {
        this.#cancel = cancel
        cancel(this.#cutReason)
      }
      return
    }
    this.#cancel = cancel
    if (this.#unread !== undefined) {
      this.#unread.add(this)
      if (this.#uncounted) {
        this.#settle()
      }
    }
  }

  /** For `request()`: stops counting toward `close()` at respond. A no-op otherwise. */
  uncountEarly(): void {
    if (this.#unread !== undefined) {
      this.#uncount()
    }
  }

  // A forced close cuts the request as Fastify's destroys its socket: an answer being sent fails its reader, and a
  // request not yet answered fails its caller and aborts its handler, whose late result then goes nowhere.
  cut(reason: Error): void {
    if (this.#cutReason !== undefined) {
      return
    }
    this.#cutReason = reason
    this.#unread?.delete(this)

    if (this.#cancel !== undefined) {
      this.#cancel(reason)
      return
    }

    this.ctx?.expire()
    this.ctx?.markResponded()
    this.ctx?.abort(reason)
    this.fail?.(reason)
  }

  // Whether this call stopped the count.
  #uncount(): boolean {
    if (this.#uncounted) {
      return false
    }

    this.#uncounted = true
    this.#uncountOne()
    return true
  }

  // A destroy hook that fails is logged: the answer has left by now.
  #endScope(): void {
    const ending = this.scope?.()
    if (isThenable(ending)) {
      const ctx = this.ctx!
      void ending.then(undefined, (err: unknown) =>
        ctx.logger.error({ reqId: ctx.req.id, err }, 'Cannot tear down the request scope'),
      )
    }
  }
}

/** One request through the engine: hooks, handler and answer, then respond, with no `async` function on the way. */
class Pipeline<N, R> {
  readonly #shared: ServerShared
  readonly #platform: ServerPlatform<N, ContextPlatform, R>
  readonly #native: N
  readonly #ctx: Context
  readonly #store: RouteStore
  readonly #hooks: InFlight
  readonly #head: boolean
  #answeringError = false

  constructor(
    shared: ServerShared,
    platform: ServerPlatform<N, ContextPlatform, R>,
    native: N,
    ctx: Context,
    store: RouteStore,
    hooks: InFlight,
    head: boolean,
  ) {
    this.#shared = shared
    this.#platform = platform
    this.#native = native
    this.#ctx = ctx
    this.#store = store
    this.#hooks = hooks
    this.#head = head
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
  // Each step goes on in the same call when the one before it stayed synchronous: no closure on that path.
  #work(): void | PromiseLike<void> {
    const ran = runHooks(this.#store.hooks.onRequest, this.#ctx)
    return isThenable(ran) ? ran.then(() => this.#afterOnRequest()) : this.#afterOnRequest()
  }

  #afterOnRequest(): void | PromiseLike<void> {
    if (this.#ctx.sent) {
      return
    }

    // The body is read and the request validated before `preHandler`, which sees what validation produced.
    const input = this.#store.input
    const read = input === undefined ? undefined : readInput(this.#ctx, input)
    return isThenable(read) ? read.then(() => this.#beforeHandler()) : this.#beforeHandler()
  }

  #beforeHandler(): void | PromiseLike<void> {
    const ran = runHooks(this.#store.hooks.preHandler, this.#ctx)
    return isThenable(ran) ? ran.then(() => this.#afterPreHandler()) : this.#afterPreHandler()
  }

  #afterPreHandler(): void | PromiseLike<void> {
    return this.#ctx.sent ? undefined : this.#handle()
  }

  // The route's statics, then the handler and its answer.
  #handle(): void | PromiseLike<void> {
    const ctx = this.#ctx
    const store = this.#store

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

  // The `onError` hooks, which observe; then the error chain, and the default problem for whatever it throws.
  #answerError(err: Error): void | Promise<void> {
    this.#answeringError = true

    const observed = this.#runOnError(err)
    return isThenable(observed)
      ? Promise.resolve(observed).then(() => this.#resolveError(err))
      : this.#resolveError(err)
  }

  // A failing hook is logged, and the error goes on: an observer does not replace the application's answer.
  #runOnError(err: Error): void | Promise<void> {
    const ctx = this.#ctx
    return runErrorHooks(this.#store.hooks.onError, ctx, err, failure =>
      this.#shared.logger.error({ reqId: ctx.req.id, err: failure }, 'onError hook failed'),
    )
  }

  #resolveError(err: Error): void | Promise<void> {
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

  // The cookies, then `onSend`, then the answer the context holds goes out.
  #respond(): R | Promise<R> {
    const ctx = this.#ctx

    // A Node middleware ended the response itself: nothing more goes out, and the request is done.
    if (ctx.outside) {
      this.#hooks.sent()
      return undefined as R
    }

    if (ctx.responded) {
      return undefined as R
    }

    // The `Set-Cookie` head slot, ahead of every `onSend` hook: inline, so an answer that set no cookie pays one field
    // read and one write.
    if (ctx[kPendingCookies] === null) {
      ctx[kCookieFlush] = 'done'
      return this.#runSend()
    }

    let flushed: void | Promise<void>
    try {
      // A queued cookie means the server's cookies are on.
      flushed = this.#shared.cookies!.flush(ctx)
    } catch (err) {
      return this.#flushFailed(err)
    }

    if (isThenable(flushed)) {
      return Promise.resolve(flushed).then(
        () => this.#runSend(),
        (err: unknown) => this.#flushFailed(err),
      )
    }

    return this.#runSend()
  }

  // The answer's cookies could not be written. The answer they were for is taken back, and the failure is answered as
  // a handler's throw is: `onError`, then the error chain, whose answer gets a cookie pass of its own. Unless that
  // answer's cookies failed too, or a forced close cut the request meanwhile.
  #flushFailed(failure: unknown): R | Promise<R> {
    const ctx = this.#ctx

    if (ctx.responded) {
      return undefined as R
    }

    if (this.#answeringError) {
      return this.#sendFailed(failure, 'Cannot write the response cookies')
    }

    dropped(ctx.payload ?? null)
    ctx.reopen()
    // The failed batch went with the answer it was for: what the error chain sets goes out with its own.
    ctx[kCookieFlush] = 'open'

    return this.#errorThenRespond(failure)
  }

  // The `onSend` hooks, then the answer the context holds goes out.
  #runSend(): R | Promise<R> {
    const ctx = this.#ctx

    // A forced close may cut the request while its cookies were signing.
    if (ctx.responded) {
      return undefined as R
    }

    const onSend = this.#store.hooks.onSend
    if (onSend.length === 0) {
      return this.#send()
    }

    ctx.openSending()

    let sent: SendPayload | Promise<SendPayload>
    try {
      sent = runSendHooks(onSend, ctx, ctx.payload ?? null)
    } catch (err) {
      return this.#sendFailed(err)
    }

    if (isThenable(sent)) {
      return Promise.resolve(sent).then(
        payload => this.#sendWith(payload),
        (err: unknown) => this.#sendFailed(err),
      )
    }

    return this.#sendWith(sent)
  }

  #sendWith(payload: SendPayload): R {
    const ctx = this.#ctx
    ctx.closeSending()

    // A forced close cut the request while `onSend` ran.
    if (ctx.responded) {
      dropped(payload)
      return undefined as R
    }

    ctx.replacePayload(payload)
    return this.#send()
  }

  // A throw from `onSend`: logged, observed by `onError` unless an error is already being answered, and answered with
  // a 500 that no `onSend` runs over.
  #sendFailed(failure: unknown, message = 'onSend hook failed'): R | Promise<R> {
    const ctx = this.#ctx
    const err = asError(failure)
    ctx.closeSending()
    this.#shared.logger.error({ reqId: ctx.req.id, err }, message)

    const answer500 = (): R => {
      if (ctx.responded) {
        return undefined as R
      }

      dropped(ctx.payload ?? null)
      ctx.reopen()
      sendProblem(this.#shared, ctx, newProblem({ status: 500, code: 'ERR_INTERNAL' }))
      return this.#send()
    }

    if (this.#answeringError) {
      return answer500()
    }

    this.#answeringError = true
    const observed = this.#runOnError(err)
    return isThenable(observed) ? Promise.resolve(observed).then(answer500) : answer500()
  }

  // Sends what the context holds, under the length rules of Fastify's `reply.send` and HEAD route.
  #send(): R {
    const ctx = this.#ctx
    const hooks = this.#hooks

    if (ctx.responded) {
      return undefined as R
    }

    const headers = ctx.responseHeaders

    // `Connection` is itself a field of the fixed list, so nothing to drop means no header to look at.
    if (ctx.hasConnectionFields) {
      const isConnectionField = connectionFields({ get: name => ctx.getHeader(name) ?? null })
      for (const name of Object.keys(headers)) {
        if (isConnectionField(name)) {
          delete headers[name]
        }
      }
    }

    const status = ctx.statusCode
    const head = this.#head
    // A Node stream nothing has read goes to a platform that pipes it as it is.
    const held = this.#platform.respondStream === undefined ? undefined : ctx.heldStream
    let payload: SendPayload | HeldStream = held ?? ctx.payload ?? null

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
    this.#platform.holdBodyTo?.(this.#native, ctx.bodyLimit)

    let sent: R
    try {
      sent =
        payload instanceof HeldStream
          ? this.#platform.respondStream!(this.#native, { status, headers }, payload.source, hooks)
          : this.#platform.respond(this.#native, { status, headers }, payload, hooks)
    } catch (err) {
      this.#shared.logger.error({ reqId: ctx.req.id, err }, 'Cannot send the answer')
      hooks.sent()
      throw err
    }

    hooks.uncountEarly()

    return sent
  }
}

/**
 * Refuses a route whose `@Timeout` no timer can wait out, at start-up rather than as a route that never times out as
 * declared.
 */
function assertServable(route: IRoute<Context>, methods: readonly string[], url: string): void {
  const timeout = route.timeout

  if (timeout !== undefined && !isTimeout(timeout)) {
    throw configurationError(
      `Cannot serve "${methods.join('|')} ${url}": a @Timeout of "${String(timeout)}ms" is not a duration above 0 and at most ${formatDuration(MAX_TIMEOUT)}`,
      'Write a positive duration, such as 30 * Second',
    )
  }
}

/**
 * Refuses a route that declares caching with no HTTP caching over it, which would answer as if it declared nothing, and
 * a route with two, which would run two caches. `batches` are the server's and each scope's around the route.
 */
function assertCachingCovered(
  route: IRoute<Context>,
  batches: readonly (readonly HookBatch[])[],
  name: string,
  application: string,
): void {
  let installs = 0
  for (const level of batches) {
    for (const batch of level) {
      if (batch.name === CACHING_PLUGIN) {
        installs++
      }
    }
  }

  if (installs > 1) {
    throw configurationError(
      `Cannot serve "${name}" on the ${application}: HTTP caching is installed more than once over it, among its server, routers and controller`,
      'Keep one ".with(HTTPCaching(...))" or "@Use(HTTPCaching(...))" over the route, and remove the others',
    )
  }

  if (installs === 0 && (route.config.has('cache') || route.config.has('cacheInvalidate'))) {
    throw configurationError(
      `Cannot serve "${name}" on the ${application}: it declares @CacheControl or @CacheInvalidate and no HTTP caching covers it`,
      'Add ".with(HTTPCaching(...))" to the application builder',
      'On a listener, add it there: ".listener(name, l => l.with(HTTPCaching(...)))"',
      'Install it on the route group with "router.with(HTTPCaching(...))" or "@Use(HTTPCaching(...))"',
    )
  }
}

function lengthOf(payload: SendPayload | HeldStream): number | undefined {
  if (typeof payload === 'string') {
    return Buffer.byteLength(payload)
  }

  return payload instanceof Uint8Array ? payload.byteLength : undefined
}

function queryAfter(url: string): string {
  const at = url.indexOf('?')
  return at === -1 ? '' : url.slice(at + 1)
}

// A body that will not go out: a stream is cancelled, so its source stops.
function dropped(payload: SendPayload | HeldStream): null {
  if (payload instanceof ReadableStream) {
    void payload.cancel().catch(() => undefined)
  } else if (payload instanceof HeldStream) {
    ;(payload.source as { destroy?: () => void }).destroy?.()
  }

  return null
}
